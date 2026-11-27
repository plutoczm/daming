import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { createTotpSecret, verifyTotp, totpEnrollmentUri } from './totp.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Session } from './auth.ts';
import { parseCookie } from './auth.ts';
import { protectWindowsSecret, unprotectWindowsSecret } from './windows-secret.ts';
import type { MagpieRoutingCatalog, MagpieRoutingCandidate } from './magpie-routing.ts';
import type { FinancialObservation } from './vendor-billing-readonly.ts';
import type { OpenAiIssuedServiceKey } from './openai-service-key.ts';

const HANDLE = /^[a-z][a-z0-9._-]{2,47}$/;
const LABEL = /^[^\u0000-\u001f\u007f]{1,80}$/;
const UUID = /^[a-f0-9-]{36}$/i;
const SESSION_MS = 12 * 60 * 60 * 1000;
const INVITE_MS = 20 * 60 * 1000;
const VALIDATION_MS = 24 * 60 * 60 * 1000;
const MFA_ENROLL_MS = 10 * 60 * 1000;
const HASH_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
type Row = Record<string, unknown>;
type MemberRole = 'owner' | 'operator' | 'viewer';
export type ProviderKind = 'openai' | 'deepseek';
export interface IdentityPrincipal {
  readonly userId: string;
  readonly username: string;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly memberRole: MemberRole;
  readonly rootAdministrator: boolean;
  /** True for the single fixed machine owner in desktop mode: no password/MFA login required. */
  readonly localMachine?: boolean;
}
export interface IdentitySession extends Session {
  readonly identity: IdentityPrincipal;
}
export interface CredentialBinding {
  readonly instanceId: string;
  readonly providerId: string;
  readonly accountRef: string;
}
export interface StoredCredentialView extends CredentialBinding {
  readonly credentialId: string;
  readonly providerKind: ProviderKind;
  readonly label: string;
  readonly proof: 'vendor_key_control_and_exact_magpie_key';
  readonly verifiedAt: string;
  readonly expiresAt: string;
  readonly vendorBillingOwnerVerified: false;
  readonly productionDispatchEnabled: false;
}

export class IdentityError extends Error {
  readonly status: number;
  constructor(status: number, reason: string) { super(reason); this.status = status; }
}
function validateUsername(name: unknown): string {
  if (typeof name !== 'string' || !HANDLE.test(name.toLowerCase())) throw new IdentityError(400, 'username_invalid');
  return name.toLowerCase();
}
function validatePassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length < 14 || password.length > 256 ||
      password.includes('\0')) throw new IdentityError(400, 'password_length_invalid');
}
function validateLabel(value: unknown): string {
  if (typeof value !== 'string' || !LABEL.test(value.trim())) throw new IdentityError(400, 'label_invalid');
  return value.trim();
}
function digest(value: string): string {
  return createHash('sha512').update(value, 'utf8').digest('hex');
}
function secureEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
async function passwordDigest(password: string, salt: Buffer): Promise<string> {
  const key = await new Promise<Buffer>((done, fail) =>
    scryptCallback(password, salt, 64, HASH_OPTIONS, (error, value) =>
      error ? fail(error) : done(value as Buffer)));
  return key.toString('base64');
}
function now(): number { return Date.now(); }
function iso(ms: number): string { return new Date(ms).toISOString(); }
const PASSWORD_DUMMY_SALT = Buffer.from('daming-nonexistent');
function requiredPrincipal(principal: IdentityPrincipal | null | undefined): IdentityPrincipal {
  if (!principal) throw new IdentityError(401, 'identity_session_required');
  return principal;
}
function isOwner(principal: IdentityPrincipal): void {
  if (principal.memberRole !== 'owner') throw new IdentityError(403, 'tenant_owner_required');
}

export interface IdentityRegistryOptions {
  /** Used in isolated unit tests only; never supplied by HTTP data. */
  readonly protectMaster?: (plain: string) => string;
  readonly unprotectMaster?: (sealed: string) => string;
  readonly clock?: () => number;
}

export class IdentityRegistry {
  private readonly db: DatabaseSync;
  private readonly master: Buffer;
  private readonly clock: () => number;
  constructor(dataDir: string, options: IdentityRegistryOptions = {}) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dataDir, 'identities.db'));
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,' +
      'salt TEXT NOT NULL,password_hash TEXT NOT NULL,created_ms INTEGER NOT NULL,' +
      'disabled INTEGER NOT NULL DEFAULT 0,failed_count INTEGER NOT NULL DEFAULT 0,' +
      'locked_until_ms INTEGER NOT NULL DEFAULT 0);' +
      'CREATE TABLE IF NOT EXISTS tenants(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_ms INTEGER NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS memberships(user_id TEXT NOT NULL REFERENCES users(id),' +
      'tenant_id TEXT NOT NULL REFERENCES tenants(id),role TEXT NOT NULL' +
      " CHECK(role IN ('owner','operator','viewer')),PRIMARY KEY(user_id,tenant_id));" +
      'CREATE TABLE IF NOT EXISTS login_attempts(username TEXT PRIMARY KEY,failures INTEGER NOT NULL,' +
      'locked_until_ms INTEGER NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS identity_sessions(session_hash TEXT PRIMARY KEY,' +
      'user_id TEXT NOT NULL REFERENCES users(id),tenant_id TEXT NOT NULL REFERENCES tenants(id),' +
      'csrf TEXT NOT NULL,expires_ms INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);' +
      'CREATE INDEX IF NOT EXISTS identity_sessions_user ON identity_sessions(user_id,expires_ms);' +
      'CREATE TABLE IF NOT EXISTS invitations(invite_hash TEXT PRIMARY KEY,' +
      'tenant_id TEXT NOT NULL REFERENCES tenants(id),role TEXT NOT NULL,' +
      'expires_ms INTEGER NOT NULL,used_ms INTEGER);' +
      'CREATE TABLE IF NOT EXISTS managed_accounts(id TEXT PRIMARY KEY,' +
      'tenant_id TEXT NOT NULL REFERENCES tenants(id),created_by TEXT NOT NULL REFERENCES users(id),' +
      'provider_kind TEXT NOT NULL,instance_id TEXT NOT NULL,provider_id TEXT NOT NULL,' +
      'account_ref TEXT NOT NULL,key_hmac TEXT NOT NULL UNIQUE,ciphertext TEXT NOT NULL,' +
      'label TEXT NOT NULL,verified_ms INTEGER NOT NULL,revoked_ms INTEGER,' +
      'UNIQUE(instance_id,provider_id,account_ref));' +
      'CREATE INDEX IF NOT EXISTS managed_accounts_tenant ON managed_accounts(tenant_id);' +
      'CREATE TABLE IF NOT EXISTS owned_missions(mission_id TEXT PRIMARY KEY,' +
      'tenant_id TEXT NOT NULL REFERENCES tenants(id),created_by TEXT NOT NULL REFERENCES users(id));' +
      'CREATE TABLE IF NOT EXISTS identity_audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT,' +
      'tenant_id TEXT NOT NULL,actor_id TEXT NOT NULL,event TEXT NOT NULL,' +
      'subject TEXT,occurred_ms INTEGER NOT NULL);' +
      'CREATE INDEX IF NOT EXISTS identity_audit_tenant ON identity_audit(tenant_id,sequence);' +
      'CREATE TABLE IF NOT EXISTS mfa_methods(user_id TEXT PRIMARY KEY REFERENCES users(id),' +
      'secret_cipher TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,' +
      'generation INTEGER NOT NULL DEFAULT 1,last_step INTEGER NOT NULL DEFAULT -1,' +
      'pending_expires_ms INTEGER NOT NULL DEFAULT 0);' +
      'CREATE TABLE IF NOT EXISTS mfa_session_proofs(session_hash TEXT PRIMARY KEY ' +
      'REFERENCES identity_sessions(session_hash),generation INTEGER NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS mfa_recovery(user_id TEXT NOT NULL REFERENCES users(id),' +
      'code_digest TEXT NOT NULL,PRIMARY KEY(user_id,code_digest));' +
      'CREATE TABLE IF NOT EXISTS owned_tasks(task_id TEXT PRIMARY KEY,' +
      'tenant_id TEXT NOT NULL REFERENCES tenants(id),created_by TEXT NOT NULL REFERENCES users(id),' +
      'execution_mode TEXT NOT NULL);' +
      'CREATE INDEX IF NOT EXISTS owned_tasks_tenant ON owned_tasks(tenant_id,task_id);' +
      'CREATE TABLE IF NOT EXISTS billing_observations(' +
      'id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES tenants(id),' +
      'actor_id TEXT NOT NULL REFERENCES users(id),' +
      'credential_id TEXT NOT NULL REFERENCES managed_accounts(id),' +
      'provider TEXT NOT NULL,source TEXT NOT NULL,scope TEXT NOT NULL,scope_hash TEXT NOT NULL,' +
      'scope_hint TEXT NOT NULL,amounts_json TEXT NOT NULL,' +
      'period_start_ms INTEGER,period_end_ms INTEGER,observed_ms INTEGER NOT NULL);' +
      'CREATE INDEX IF NOT EXISTS billing_observations_tenant ON ' +
      'billing_observations(tenant_id,observed_ms);' +
      'CREATE TABLE IF NOT EXISTS tenant_api_accounts(' +
      'id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES tenants(id),' +
      'created_by TEXT NOT NULL REFERENCES users(id),' +
      'provider TEXT NOT NULL,model_id TEXT NOT NULL,label TEXT NOT NULL,' +
      'key_hmac TEXT NOT NULL UNIQUE,ciphertext TEXT NOT NULL,' +
      'verified_ms INTEGER NOT NULL,revoked_ms INTEGER);' +
      'CREATE INDEX IF NOT EXISTS tenant_api_accounts_tenant ON tenant_api_accounts(tenant_id);' +
      'CREATE TABLE IF NOT EXISTS openai_admin_issuances(' +
      'request_id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES tenants(id),' +
      'actor_id TEXT NOT NULL REFERENCES users(id),' +
      'project_id TEXT NOT NULL,service_account_id TEXT NOT NULL,model_id TEXT NOT NULL,' +
      'status TEXT NOT NULL,credential_id TEXT UNIQUE,' +
      'key_id TEXT,expires_ms INTEGER,created_ms INTEGER NOT NULL);' +
      'CREATE INDEX IF NOT EXISTS openai_issuances_tenant ON openai_admin_issuances(tenant_id,created_ms);' +
      'CREATE TABLE IF NOT EXISTS official_key_cost_observations(' +
      'id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES tenants(id),' +
      'actor_id TEXT NOT NULL REFERENCES users(id),credential_id TEXT NOT NULL,' +
      'project_id TEXT NOT NULL,api_key_id TEXT NOT NULL,utc_day TEXT NOT NULL,' +
      'cost_micro_usd INTEGER NOT NULL,observed_ms INTEGER NOT NULL);' +
      'CREATE INDEX IF NOT EXISTS official_key_cost_tenant ON ' +
      'official_key_cost_observations(tenant_id,observed_ms);' +
      'CREATE TABLE IF NOT EXISTS official_spend_limit_observations(' +
      'id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES tenants(id),' +
      'actor_id TEXT NOT NULL REFERENCES users(id),credential_id TEXT NOT NULL,' +
      'project_id TEXT NOT NULL,observed_ms INTEGER NOT NULL,' +
      'project_status TEXT NOT NULL,project_minor INTEGER NOT NULL,' +
      'org_status TEXT NOT NULL,org_minor INTEGER NOT NULL);' +
      'CREATE INDEX IF NOT EXISTS official_spend_limit_tenant ON ' +
      'official_spend_limit_observations(tenant_id,observed_ms);'
    );
    // Single-machine desktop mode marks exactly one fixed owner account as local_machine.
    // Migrate older databases in place without disturbing existing rows.
    {
      const columns = this.db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
      if (!columns.some((column) => column.name === 'local_machine')) {
        this.db.prepare('ALTER TABLE users ADD COLUMN local_machine INTEGER NOT NULL DEFAULT 0').run();
      }
    }
    // A Host crash may occur after the official API created a key but before
    // its secret was durably sealed. Never blindly replay such mutations.
    this.db.prepare("UPDATE openai_admin_issuances SET status='uncertain' WHERE status='started'").run();
    this.clock = options.clock ?? now;
    const saved = this.db.prepare("SELECT value FROM meta WHERE key='protected_master'")
      .get() as { value: string } | undefined;
    const seal = options.protectMaster ?? protectWindowsSecret;
    const unseal = options.unprotectMaster ?? unprotectWindowsSecret;
    if (saved) {
      const key = Buffer.from(unseal(saved.value), 'base64');
      if (key.length !== 32) throw new IdentityError(503, 'identity_master_invalid');
      this.master = key;
    } else {
      const key = randomBytes(32);
      const blob = seal(key.toString('base64'));
      this.db.prepare("INSERT INTO meta(key,value) VALUES('protected_master',?)").run(blob);
      this.master = key;
    }
  }
  close(): void { this.master.fill(0); this.db.close(); }
  private audit(tenantId: string, actorId: string, event: string, subject?: string): void {
    this.db.prepare('INSERT INTO identity_audit(tenant_id,actor_id,event,subject,occurred_ms) VALUES(?,?,?,?,?)')
      .run(tenantId, actorId, event, subject ?? null, this.clock());
  }
  auditFor(principal: IdentityPrincipal): { sequence: number; event: string; occurredAt: string; subject: string | null }[] {
    if (principal.memberRole !== 'owner') throw new IdentityError(403, 'tenant_owner_required');
    return (this.db.prepare('SELECT * FROM identity_audit WHERE tenant_id=? ' +
      'ORDER BY sequence DESC LIMIT 100').all(principal.tenantId) as Row[]).map(r => ({
      sequence: Number(r.sequence), event: String(r.event),
      occurredAt: iso(Number(r.occurred_ms)), subject: r.subject == null ? null : String(r.subject)
    }));
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }
  initialized(): boolean {
    return !!this.db.prepare("SELECT 1 FROM meta WHERE key='root_user'").get();
  }
  private sessionFor(userId: string, tenantId: string, mfaGeneration?: number): { cookie: string; session: IdentitySession } {
    const cookie = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    const sessionHash = digest(cookie);
    this.db.prepare('INSERT INTO identity_sessions(session_hash,user_id,tenant_id,csrf,expires_ms) VALUES(?,?,?,?,?)')
      .run(sessionHash, userId, tenantId, csrf, this.clock() + SESSION_MS);
    if (mfaGeneration !== undefined) this.db.prepare(
      'INSERT INTO mfa_session_proofs(session_hash,generation) VALUES(?,?)'
    ).run(sessionHash, mfaGeneration);
    const session = this.getSession('daming_identity=' + cookie);
    if (!session) throw new IdentityError(500, 'identity_session_creation_failed');
    return { cookie, session };
  }
  async setup(input: { username: unknown; password: unknown; tenantName: unknown; localMachine?: boolean }): Promise<{ cookie: string; session: IdentitySession }> {
    const username = validateUsername(input.username);
    validatePassword(input.password);
    const tenantName = validateLabel(input.tenantName);
    const salt = randomBytes(16);
    const passwordHash = await passwordDigest(input.password, salt);
    return this.transaction(() => {
      if (this.initialized()) throw new IdentityError(409, 'identity_already_initialized');
      const userId = randomUUID(), tenantId = randomUUID(), created = this.clock();
      this.db.prepare('INSERT INTO users(id,username,salt,password_hash,created_ms,local_machine) VALUES(?,?,?,?,?,?)')
        .run(userId, username, salt.toString('base64'), passwordHash, created, input.localMachine === true ? 1 : 0);
      this.db.prepare('INSERT INTO tenants(id,name,created_ms) VALUES(?,?,?)').run(tenantId, tenantName, created);
      this.db.prepare("INSERT INTO memberships(user_id,tenant_id,role) VALUES(?,?,'owner')").run(userId, tenantId);
      this.db.prepare("INSERT INTO meta(key,value) VALUES('root_user',?)").run(userId);
      this.audit(tenantId, userId, 'identity.root.created');
      return this.sessionFor(userId, tenantId);
    });
  }
  /**
   * Desktop fixed-user mode: create the one machine owner once (username `local`, random
   * password never shown) or, on an upgraded machine that already had an identity, mark the
   * existing root owner as the local machine user. Idempotent; never creates a second account.
   */
  async ensureLocalOwner(): Promise<void> {
    if (!this.initialized()) {
      const password = randomBytes(24).toString('base64url');
      await this.setup({ username: 'local', password, tenantName: '本机工作空间', localMachine: true });
      return;
    }
    const root = this.db.prepare("SELECT value FROM meta WHERE key='root_user'")
      .get() as { value: string } | undefined;
    if (!root) throw new IdentityError(503, 'root_identity_unavailable');
    this.db.prepare('UPDATE users SET local_machine=1 WHERE id=?').run(String(root.value));
  }
  /** Open a fresh identity session for the fixed local owner without any credential prompt. */
  openLocalOwnerSession(): { cookie: string; session: IdentitySession } {
    const root = this.db.prepare("SELECT value FROM meta WHERE key='root_user'")
      .get() as { value: string } | undefined;
    if (!root) throw new IdentityError(503, 'root_identity_unavailable');
    const member = this.db.prepare(
      "SELECT tenant_id FROM memberships WHERE user_id=? AND role='owner' ORDER BY rowid LIMIT 1"
    ).get(String(root.value)) as { tenant_id: string } | undefined;
    if (!member) throw new IdentityError(503, 'root_tenant_unavailable');
    return this.sessionFor(String(root.value), String(member.tenant_id));
  }
  private userByName(username: string): Row | undefined {
    return this.db.prepare('SELECT * FROM users WHERE username=?').get(username) as Row | undefined;
  }
  async login(input: { username: unknown; password: unknown; mfaCode?: unknown }): Promise<{ cookie: string; session: IdentitySession }> {
    const username = validateUsername(input.username);
    // A real password is required; unknown usernames take the same scrypt path.
    if (typeof input.password !== 'string' || input.password.length > 256) {
      throw new IdentityError(401, 'identity_login_failed');
    }
    const user = this.userByName(username);
    const attempts = this.db.prepare('SELECT * FROM login_attempts WHERE username=?')
      .get(username) as Row | undefined;
    if ((attempts && Number(attempts.locked_until_ms) > this.clock()) ||
        (user && Number(user.locked_until_ms) > this.clock())) {
      throw new IdentityError(429, 'identity_login_delayed');
    }
    const salt = user ? Buffer.from(String(user.salt), 'base64') : PASSWORD_DUMMY_SALT;
    const candidate = Buffer.from(await passwordDigest(input.password, salt), 'base64');
    const expected = user ? Buffer.from(String(user.password_hash), 'base64') : Buffer.alloc(64);
    const passwordAccepted = !!user && Number(user.disabled) === 0 && secureEqual(candidate, expected);
    const outcome = this.transaction(() => {
      const refreshed = this.userByName(username);
      const latest = this.db.prepare('SELECT * FROM login_attempts WHERE username=?')
        .get(username) as Row | undefined;
      const locked = Number(refreshed?.locked_until_ms ?? 0) > this.clock() ||
        Number(latest?.locked_until_ms ?? 0) > this.clock();
      const validUser = passwordAccepted && refreshed && Number(refreshed.disabled) === 0 && !locked;
      const mfa = validUser ? this.db.prepare(
        'SELECT * FROM mfa_methods WHERE user_id=? AND enabled=1'
      ).get(String(refreshed.id)) as Row | undefined : undefined;
      if (validUser && mfa && input.mfaCode === undefined) return { status: 'mfa_required' as const };
      const factorAccepted = !mfa || this.consumeMfaForLogin(String(refreshed!.id), input.mfaCode, mfa);
      if (!validUser || !factorAccepted) {
        const failures = (latest && Number(latest.locked_until_ms) > 0 &&
          Number(latest.locked_until_ms) <= this.clock() ? 0 : Number(latest?.failures ?? 0)) + 1;
        const until = failures >= 5 ? this.clock() + 15 * 60 * 1000 : 0;
        this.db.prepare('INSERT INTO login_attempts(username,failures,locked_until_ms) VALUES(?,?,?) ' +
          'ON CONFLICT(username) DO UPDATE SET failures=excluded.failures,locked_until_ms=excluded.locked_until_ms')
          .run(username, failures, until);
        if (refreshed) this.db.prepare(
          'UPDATE users SET failed_count=?,locked_until_ms=? WHERE id=?'
        ).run(failures, until, String(refreshed.id));
        return { status: 'failed' as const };
      }
      const member = this.db.prepare(
        'SELECT tenant_id FROM memberships WHERE user_id=? ORDER BY rowid LIMIT 1'
      ).get(String(refreshed!.id)) as { tenant_id: string } | undefined;
      if (!member) return { status: 'failed' as const };
      this.db.prepare('UPDATE users SET failed_count=0,locked_until_ms=0 WHERE id=?')
        .run(String(refreshed!.id));
      this.db.prepare('DELETE FROM login_attempts WHERE username=?').run(username);
      this.audit(member.tenant_id, String(refreshed!.id), mfa ? 'identity.mfa.login' : 'identity.login');
      return { status: 'ok' as const, opened: this.sessionFor(String(refreshed!.id), member.tenant_id,
        mfa ? Number(mfa.generation) : undefined) };
    });
    if (outcome.status === 'mfa_required') throw new IdentityError(428, 'mfa_code_required');
    if (outcome.status !== 'ok') throw new IdentityError(401, 'identity_login_failed');
    return outcome.opened;
  }
  getSession(header: string | undefined): IdentitySession | undefined {
    const value = parseCookie(header, 'daming_identity');
    if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) return undefined;
    const row = this.db.prepare(
      'SELECT s.*,u.username,u.disabled,u.local_machine,t.name AS tenant_name,m.role,' +
      " (SELECT value FROM meta WHERE key='root_user') AS root_user " +
      'FROM identity_sessions s JOIN users u ON u.id=s.user_id ' +
      'JOIN tenants t ON t.id=s.tenant_id ' +
      'JOIN memberships m ON m.user_id=s.user_id AND m.tenant_id=s.tenant_id ' +
      'WHERE s.session_hash=?'
    ).get(digest(value)) as Row | undefined;
    if (!row || Number(row.revoked) !== 0 || Number(row.disabled) !== 0 ||
        Number(row.expires_ms) <= this.clock()) return undefined;
    const method = this.db.prepare('SELECT enabled,generation FROM mfa_methods WHERE user_id=?')
      .get(String(row.user_id)) as { enabled: number; generation: number } | undefined;
    if (method?.enabled === 1) {
      const proof = this.db.prepare('SELECT generation FROM mfa_session_proofs WHERE session_hash=?')
        .get(digest(value)) as { generation: number } | undefined;
      if (!proof || proof.generation !== method.generation) return undefined;
    }
    const memberRole = String(row.role) as MemberRole;
    return Object.freeze({
      id: digest(value), csrfToken: String(row.csrf),
      role: memberRole === 'viewer' ? 'readonly' as const : 'readwrite' as const,
      expiresAt: Number(row.expires_ms),
      identity: {
        userId: String(row.user_id), username: String(row.username),
        tenantId: String(row.tenant_id), tenantName: String(row.tenant_name),
        memberRole, rootAdministrator: row.user_id === row.root_user,
        localMachine: Number(row.local_machine) === 1
      }
    });
  }
  logout(header: string | undefined): void {
    const value = parseCookie(header, 'daming_identity');
    if (value && /^[A-Za-z0-9_-]{43}$/.test(value)) {
      this.db.prepare('UPDATE identity_sessions SET revoked=1 WHERE session_hash=?').run(digest(value));
    }
  }
  listTenants(principal: IdentityPrincipal): { tenantId: string; name: string; role: MemberRole }[] {
    return (this.db.prepare(
      'SELECT t.id,t.name,m.role FROM memberships m JOIN tenants t ON t.id=m.tenant_id ' +
      'WHERE m.user_id=? ORDER BY t.created_ms,t.id'
    ).all(principal.userId) as Row[]).map((row) => ({
      tenantId: String(row.id), name: String(row.name), role: String(row.role) as MemberRole
    }));
  }
  createTenant(principal: IdentityPrincipal, name: unknown): { tenantId: string; name: string; role: 'owner' } {
    const tenantName = validateLabel(name);
    return this.transaction(() => {
      const tenantId = randomUUID();
      this.db.prepare('INSERT INTO tenants(id,name,created_ms) VALUES(?,?,?)').run(tenantId, tenantName, this.clock());
      this.db.prepare("INSERT INTO memberships(user_id,tenant_id,role) VALUES(?,?,'owner')")
        .run(principal.userId, tenantId);
      this.audit(tenantId, principal.userId, 'tenant.created');
      return { tenantId, name: tenantName, role: 'owner' as const };
    });
  }
  switchTenant(principal: IdentityPrincipal, tenantId: unknown, header: string | undefined) {
    if (typeof tenantId !== 'string' || !UUID.test(tenantId)) throw new IdentityError(400, 'tenant_id_invalid');
    const member = this.db.prepare('SELECT 1 FROM memberships WHERE user_id=? AND tenant_id=?')
      .get(principal.userId, tenantId);
    if (!member) throw new IdentityError(403, 'tenant_membership_required');
    return this.transaction(() => {
      this.logout(header);
      this.audit(tenantId, principal.userId, 'tenant.switched');
      const mfa = this.db.prepare('SELECT enabled,generation FROM mfa_methods WHERE user_id=?')
        .get(principal.userId) as { enabled: number; generation: number } | undefined;
      return this.sessionFor(principal.userId, tenantId, mfa?.enabled === 1 ? mfa.generation : undefined);
    });
  }
  issueInvitation(principal: IdentityPrincipal, role: unknown): { invitationCode: string; expiresAt: string } {
    isOwner(principal);
    if (role !== 'operator' && role !== 'viewer') throw new IdentityError(400, 'invitation_role_invalid');
    const invitationCode = randomBytes(32).toString('base64url');
    const expires = this.clock() + INVITE_MS;
    this.transaction(() => {
      this.db.prepare('INSERT INTO invitations(invite_hash,tenant_id,role,expires_ms) VALUES(?,?,?,?)')
        .run(digest(invitationCode), principal.tenantId, role, expires);
      this.audit(principal.tenantId, principal.userId, 'member.invited');
    });
    return { invitationCode, expiresAt: iso(expires) };
  }
  async enroll(input: { username: unknown; password: unknown; invitationCode: unknown }) {
    const username = validateUsername(input.username);
    validatePassword(input.password);
    if (typeof input.invitationCode !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.invitationCode)) {
      throw new IdentityError(403, 'invitation_invalid');
    }
    const salt = randomBytes(16);
    const passwordHash = await passwordDigest(input.password, salt);
    return this.transaction(() => {
      const invitation = this.db.prepare('SELECT * FROM invitations WHERE invite_hash=?')
        .get(digest(input.invitationCode as string)) as Row | undefined;
      if (!invitation || invitation.used_ms !== null || Number(invitation.expires_ms) <= this.clock()) {
        throw new IdentityError(403, 'invitation_invalid');
      }
      if (this.userByName(username)) throw new IdentityError(409, 'username_taken');
      const userId = randomUUID();
      this.db.prepare('INSERT INTO users(id,username,salt,password_hash,created_ms) VALUES(?,?,?,?,?)')
        .run(userId, username, salt.toString('base64'), passwordHash, this.clock());
      this.db.prepare('INSERT INTO memberships(user_id,tenant_id,role) VALUES(?,?,?)')
        .run(userId, String(invitation.tenant_id), String(invitation.role));
      this.db.prepare('UPDATE invitations SET used_ms=? WHERE invite_hash=? AND used_ms IS NULL')
        .run(this.clock(), digest(input.invitationCode as string));
      this.audit(String(invitation.tenant_id), userId, 'member.enrolled');
      return this.sessionFor(userId, String(invitation.tenant_id));
    });
  }
  migrateLegacyMissions(missionIds: readonly string[]): number {
    if (!Array.isArray(missionIds) ||
        missionIds.some(id => typeof id !== 'string' || !UUID.test(id))) {
      throw new IdentityError(400, 'legacy_mission_inventory_invalid');
    }
    return this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM meta WHERE key='legacy_mission_ownership_migrated'").get()) return 0;
      const root = this.db.prepare("SELECT value FROM meta WHERE key='root_user'")
        .get() as { value: string } | undefined;
      if (!root) throw new IdentityError(503, 'root_identity_unavailable');
      const tenant = this.db.prepare('SELECT t.id FROM tenants t JOIN memberships m ON m.tenant_id=t.id ' +
        "WHERE m.user_id=? AND m.role='owner' ORDER BY t.created_ms,t.id LIMIT 1")
        .get(root.value) as { id: string } | undefined;
      if (!tenant) throw new IdentityError(503, 'root_tenant_unavailable');
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO owned_missions(mission_id,tenant_id,created_by) VALUES(?,?,?)'
      );
      let migrated = 0;
      for (const missionId of missionIds) {
        migrated += Number(insert.run(missionId, tenant.id, root.value).changes);
      }
      this.db.prepare("INSERT INTO meta(key,value) VALUES('legacy_mission_ownership_migrated',?)")
        .run(String(this.clock()));
      this.audit(tenant.id, root.value, 'missions.legacy_migrated');
      return migrated;
    });
  }

  bindMission(principal: IdentityPrincipal, missionId: string): void {
    if (!UUID.test(missionId)) throw new IdentityError(400, 'mission_id_invalid');
    this.transaction(() => {
      const existing = this.db.prepare('SELECT tenant_id FROM owned_missions WHERE mission_id=?')
        .get(missionId) as { tenant_id: string } | undefined;
      if (existing) {
        if (existing.tenant_id !== principal.tenantId) throw new IdentityError(404, 'mission_not_found');
        return;
      }
      this.db.prepare('INSERT INTO owned_missions(mission_id,tenant_id,created_by) VALUES(?,?,?)')
        .run(missionId, principal.tenantId, principal.userId);
      this.audit(principal.tenantId, principal.userId, 'mission.bound', missionId);
    });
  }
  ownsMission(principal: IdentityPrincipal, missionId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM owned_missions WHERE mission_id=? AND tenant_id=?')
      .get(missionId, principal.tenantId);
  }
  assertMission(principal: IdentityPrincipal, missionId: string): void {
    if (!this.ownsMission(principal, missionId)) throw new IdentityError(404, 'mission_not_found');
  }
  private seal(value: string, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.master, iv);
    cipher.setAAD(Buffer.from(aad));
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'),
      encrypted.toString('base64url')].join('.');
  }

  private unseal(value: string, aad: string): string {
    if (typeof value !== 'string') throw new IdentityError(503, 'identity_ciphertext_invalid');
    const parts = value.split('.');
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) {
      throw new IdentityError(503, 'identity_ciphertext_invalid');
    }
    const iv = Buffer.from(parts[0], 'base64url');
    const tag = Buffer.from(parts[1], 'base64url');
    if (iv.length !== 12 || tag.length !== 16) throw new IdentityError(503, 'identity_ciphertext_invalid');
    const decipher = createDecipheriv('aes-256-gcm', this.master, iv);
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64url')), decipher.final()])
      .toString('utf8');
  }

  hasMfa(principal: IdentityPrincipal): boolean {
    // The machine-local owner is bound to this Windows account/device; no second factor prompt.
    if (principal.localMachine === true) return true;
    const row = this.db.prepare('SELECT enabled FROM mfa_methods WHERE user_id=?')
      .get(principal.userId) as { enabled: number } | undefined;
    return row?.enabled === 1;
  }

  async beginMfaEnrollment(
    principal: IdentityPrincipal, cookieHeader: string | undefined, password: unknown
  ): Promise<{ secret: string; enrollmentUri: string; expiresAt: string }> {
    if (this.getSession(cookieHeader)?.identity.userId !== principal.userId ||
        typeof password !== 'string' || password.length > 256) {
      throw new IdentityError(403, 'mfa_reauthentication_required');
    }
    const user = this.db.prepare('SELECT * FROM users WHERE id=?')
      .get(principal.userId) as Row | undefined;
    if (!user || Number(user.disabled) !== 0 || Number(user.locked_until_ms) > this.clock()) {
      throw new IdentityError(403, 'mfa_reauthentication_required');
    }
    const digestValue = Buffer.from(await passwordDigest(
      password, Buffer.from(String(user.salt), 'base64')), 'base64');
    const expected = Buffer.from(String(user.password_hash), 'base64');
    if (!secureEqual(digestValue, expected)) {
      this.db.prepare('UPDATE users SET failed_count=failed_count+1,' +
        'locked_until_ms=CASE WHEN failed_count+1>=5 THEN ? ELSE 0 END WHERE id=?')
        .run(this.clock() + 15 * 60 * 1000, principal.userId);
      throw new IdentityError(403, 'mfa_reauthentication_required');
    }
    return this.transaction(() => {
      if (!this.getSession(cookieHeader) || this.hasMfa(principal)) {
        throw new IdentityError(409, 'mfa_already_enabled_or_session_expired');
      }
      const secret = createTotpSecret();
      const expiration = this.clock() + MFA_ENROLL_MS;
      this.db.prepare(
        'INSERT INTO mfa_methods(user_id,secret_cipher,enabled,generation,last_step,pending_expires_ms)' +
        ' VALUES(?,?,0,1,-1,?) ON CONFLICT(user_id) DO UPDATE SET secret_cipher=excluded.secret_cipher,' +
        'enabled=0,last_step=-1,pending_expires_ms=excluded.pending_expires_ms'
      ).run(principal.userId, this.seal(secret, 'totp:' + principal.userId), expiration);
      this.audit(principal.tenantId, principal.userId, 'identity.mfa.enrollment_started');
      return {
        secret, enrollmentUri: totpEnrollmentUri(principal.username, secret), expiresAt: iso(expiration)
      };
    });
  }

  confirmMfaEnrollment(
    principal: IdentityPrincipal, cookieHeader: string | undefined, code: unknown
  ): { enabled: true; recoveryCodes: string[] } {
    return this.transaction(() => {
      const session = this.getSession(cookieHeader);
      if (!session || session.identity.userId !== principal.userId ||
          session.identity.tenantId !== principal.tenantId) {
        throw new IdentityError(403, 'mfa_session_invalid');
      }
      const row = this.db.prepare('SELECT * FROM mfa_methods WHERE user_id=?')
        .get(principal.userId) as Row | undefined;
      if (!row || Number(row.enabled) !== 0 || Number(row.pending_expires_ms) <= this.clock()) {
        throw new IdentityError(409, 'mfa_enrollment_expired');
      }
      const secret = this.unseal(String(row.secret_cipher), 'totp:' + principal.userId);
      const step = verifyTotp(secret, code, this.clock(), -1);
      if (step === null) throw new IdentityError(403, 'mfa_code_invalid');
      const generation = Number(row.generation) + 1;
      this.db.prepare('UPDATE mfa_methods SET enabled=1,generation=?,last_step=?,' +
        'pending_expires_ms=0 WHERE user_id=?').run(generation, step, principal.userId);
      const recoveryCodes = Array.from({ length: 8 }, () =>
        'R-' + randomBytes(18).toString('base64url'));
      this.db.prepare('DELETE FROM mfa_recovery WHERE user_id=?').run(principal.userId);
      const insert = this.db.prepare('INSERT INTO mfa_recovery(user_id,code_digest) VALUES(?,?)');
      for (const item of recoveryCodes) {
        insert.run(principal.userId, this.keyFingerprint('mfa-recovery:' + item));
      }
      this.db.prepare('INSERT INTO mfa_session_proofs(session_hash,generation) VALUES(?,?) ' +
        'ON CONFLICT(session_hash) DO UPDATE SET generation=excluded.generation')
        .run(session.id, generation);
      this.db.prepare('UPDATE identity_sessions SET revoked=1 WHERE user_id=? AND session_hash<>?')
        .run(principal.userId, session.id);
      this.audit(principal.tenantId, principal.userId, 'identity.mfa.enabled');
      return { enabled: true as const, recoveryCodes };
    });
  }

  /** Token consumption is atomic with login. The same 30s TOTP cannot be reused. */
  private consumeMfaForLogin(userId: string, code: unknown, method: Row): boolean {
    if (typeof code !== 'string') return false;
    if (/^R-[A-Za-z0-9_-]{24}$/.test(code)) {
      const used = this.db.prepare('DELETE FROM mfa_recovery WHERE user_id=? AND code_digest=?')
        .run(userId, this.keyFingerprint('mfa-recovery:' + code));
      return used.changes === 1;
    }
    const secret = this.unseal(String(method.secret_cipher), 'totp:' + userId);
    const step = verifyTotp(secret, code, this.clock(), Number(method.last_step));
    if (step === null) return false;
    return this.db.prepare('UPDATE mfa_methods SET last_step=? WHERE user_id=? AND last_step<?')
      .run(step, userId, step).changes === 1;
  }

  /** One-time, atomic import of pre-identity tasks into the original root tenant. */
  migrateLegacyTasks(taskIds: readonly string[]): number {
    if (!Array.isArray(taskIds) || taskIds.some(id => typeof id !== 'string' || !UUID.test(id))) {
      throw new IdentityError(400, 'legacy_task_inventory_invalid');
    }
    return this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM meta WHERE key='legacy_task_ownership_migrated'").get()) return 0;
      const root = this.db.prepare("SELECT value FROM meta WHERE key='root_user'")
        .get() as { value: string } | undefined;
      if (!root) throw new IdentityError(503, 'root_identity_unavailable');
      const tenant = this.db.prepare('SELECT t.id FROM tenants t JOIN memberships m ON m.tenant_id=t.id ' +
        'WHERE m.user_id=? AND m.role=? ORDER BY t.created_ms,t.id LIMIT 1')
        .get(root.value, 'owner') as { id: string } | undefined;
      if (!tenant) throw new IdentityError(503, 'root_tenant_unavailable');
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO owned_tasks(task_id,tenant_id,created_by,execution_mode) VALUES(?,?,?,?)'
      );
      let migrated = 0;
      for (const taskId of taskIds) {
        migrated += Number(insert.run(taskId, tenant.id, root.value, 'legacy').changes);
      }
      this.db.prepare(
        "INSERT INTO meta(key,value) VALUES('legacy_task_ownership_migrated',?)"
      ).run(String(this.clock()));
      this.audit(tenant.id, root.value, 'tasks.legacy_migrated');
      return migrated;
    });
  }

  bindTask(principal: IdentityPrincipal, taskId: string, executionMode: string): void {
    if (!UUID.test(taskId) || !['fixture','local','project','real','dsh'].includes(executionMode)) {
      throw new IdentityError(400, 'task_binding_invalid');
    }
    this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM owned_tasks WHERE task_id=?')
        .get(taskId) as Row | undefined;
      if (existing) {
        if (existing.tenant_id !== principal.tenantId) throw new IdentityError(404, 'task_not_found');
        return;
      }
      this.db.prepare('INSERT INTO owned_tasks(task_id,tenant_id,created_by,execution_mode)' +
        ' VALUES(?,?,?,?)').run(taskId, principal.tenantId, principal.userId, executionMode);
      this.audit(principal.tenantId, principal.userId, 'task.bound', taskId);
    });
  }

  ownsTask(principal: IdentityPrincipal, taskId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM owned_tasks WHERE task_id=? AND tenant_id=?')
      .get(taskId, principal.tenantId);
  }

  assertTask(principal: IdentityPrincipal, taskId: string): void {
    if (!this.ownsTask(principal, taskId)) throw new IdentityError(404, 'task_not_found');
  }

  taskMode(principal: IdentityPrincipal, taskId: string): string | null {
    const row = this.db.prepare('SELECT execution_mode FROM owned_tasks WHERE task_id=? AND tenant_id=?')
      .get(taskId, principal.tenantId) as { execution_mode: string } | undefined;
    return row?.execution_mode ?? null;
  }

  // Secret is intentionally never returned over HTTP; protect at rest even
  // when the SQLite file is copied off the machine.
  private keyFingerprint(secret: string): string {
    return createHmac('sha512', this.master).update(secret, 'utf8').digest('hex');
  }
  listAccounts(principal: IdentityPrincipal): StoredCredentialView[] {
    return (this.db.prepare(
      'SELECT * FROM managed_accounts WHERE tenant_id=? AND revoked_ms IS NULL ' +
      'ORDER BY verified_ms DESC,id LIMIT 100'
    ).all(principal.tenantId) as Row[]).map(row => ({
      credentialId: String(row.id), providerKind: String(row.provider_kind) as ProviderKind,
      label: String(row.label), instanceId: String(row.instance_id),
      providerId: String(row.provider_id), accountRef: '[private]' as string,
      proof: 'vendor_key_control_and_exact_magpie_key' as const,
      verifiedAt: iso(Number(row.verified_ms)), expiresAt: iso(Number(row.verified_ms) + VALIDATION_MS),
      vendorBillingOwnerVerified: false as const, productionDispatchEnabled: false as const
    }));
  }
  hasVerifiedBinding(principal: IdentityPrincipal, candidate: MagpieRoutingCandidate, instanceId: string): boolean {
    return !!this.db.prepare(
      'SELECT 1 FROM managed_accounts WHERE tenant_id=? AND instance_id=? AND provider_id=? ' +
      'AND account_ref=? AND revoked_ms IS NULL AND verified_ms>?'
    ).get(principal.tenantId, instanceId, candidate.providerId, candidate.accountRef,
      this.clock() - VALIDATION_MS);
  }
  filterCatalog(principal: IdentityPrincipal, catalog: MagpieRoutingCatalog): MagpieRoutingCatalog {
    return { ...catalog, candidates: catalog.candidates.filter(candidate =>
      this.hasVerifiedBinding(principal, candidate, catalog.instanceId)) };
  }
  registerAccount(principal: IdentityPrincipal, input: {
    candidate: MagpieRoutingCandidate; instanceId: string; providerKind: ProviderKind;
    label: string; secret: string;
  }): StoredCredentialView {
    isOwner(principal);
    if (!input || !['openai','deepseek'].includes(input.providerKind) ||
        typeof input.secret !== 'string' || input.secret.length < 12 || input.secret.length > 4096 ||
        /[\r\n\0]/.test(input.secret) || !/^[a-f0-9]{32}$/i.test(input.instanceId)) {
      throw new IdentityError(400, 'credential_registration_invalid');
    }
    const label = validateLabel(input.label);
    const { providerId, accountRef } = input.candidate;
    if (!/^[a-z0-9][a-z0-9._/-]{0,99}$/i.test(providerId) ||
        !/^[a-f0-9]{10}$/i.test(accountRef)) throw new IdentityError(400, 'credential_binding_invalid');
    const fingerprint = this.keyFingerprint(input.secret);
    return this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM managed_accounts WHERE key_hmac=?')
        .get(fingerprint)) throw new IdentityError(409, 'credential_already_registered');
      if (this.db.prepare('SELECT 1 FROM managed_accounts WHERE instance_id=? AND provider_id=? AND account_ref=?')
        .get(input.instanceId, providerId, accountRef)) throw new IdentityError(409, 'account_already_claimed');
      const id = randomUUID(), verified = this.clock();
      const ciphertext = this.seal(input.secret, input.instanceId + '\0' + providerId + '\0' + accountRef);
      this.db.prepare(
        'INSERT INTO managed_accounts(id,tenant_id,created_by,provider_kind,instance_id,provider_id,' +
        'account_ref,key_hmac,ciphertext,label,verified_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)'
      ).run(id, principal.tenantId, principal.userId, input.providerKind,
        input.instanceId, providerId, accountRef, fingerprint, ciphertext, label, verified);
      this.audit(principal.tenantId, principal.userId, 'account.key.control.verified', id);
      return { credentialId: id, providerKind: input.providerKind, label, instanceId: input.instanceId,
        providerId, accountRef: '[private]', proof: 'vendor_key_control_and_exact_magpie_key',
        verifiedAt: iso(verified), expiresAt: iso(verified + VALIDATION_MS),
        vendorBillingOwnerVerified: false, productionDispatchEnabled: false };
    });
  }

  /** The submitted credential must match the registered secret, but the API
   * secret is never decrypted, returned to the client, or retained in logs. */
  assertSubmittedKey(principal: IdentityPrincipal, credentialId: string,
    apiKey: string, provider: ProviderKind): void {
    isOwner(principal);
    if (!UUID.test(credentialId) || typeof apiKey !== 'string' ||
        apiKey.length < 12 || apiKey.length > 4096 || /[\r\n\0]/.test(apiKey)) {
      throw new IdentityError(400, 'billing_credential_invalid');
    }
    const entry = this.db.prepare(
      'SELECT provider_kind,key_hmac FROM managed_accounts ' +
      'WHERE id=? AND tenant_id=? AND revoked_ms IS NULL AND verified_ms>?'
    ).get(credentialId, principal.tenantId, this.clock() - VALIDATION_MS) as Row | undefined;
    if (!entry || entry.provider_kind !== provider ||
        !secureEqual(Buffer.from(String(entry.key_hmac), 'hex'),
          Buffer.from(this.keyFingerprint(apiKey), 'hex'))) {
      throw new IdentityError(403, 'billing_credential_not_verified_for_tenant');
    }
  }

  /** Persist only a deidentified observational summary; not a vendor invoice
   * or a permit to spend. A transaction re-checks account revocation/expiry. */
  recordBillingObservation(
    principal: IdentityPrincipal, credentialId: string,
    observation: FinancialObservation
  ): {
    observationId: string; credentialId: string; provider: string;
    source: string; scope: string; scopeHint: string;
    observedAt: string; periodStart: string | null; periodEnd: string | null;
    amounts: Array<{ currency: string; minor: number }>;
    billingOwnerVerified: false; vendorInvoiceVerified: false;
    modelKeyProjectLinkVerified: false; perRequestCashCapGuaranteed: false;
    productionDispatchEnabled: false;
  } {
    isOwner(principal);
    const recognized = observation &&
      ((observation.provider === 'openai' &&
        observation.source === 'openai_admin_cost_api' &&
        observation.scope === 'project' &&
        observation.administratorReadAccess === true &&
        /^proj_[A-Za-z0-9_-]{3,100}$/.test(observation.scopeRef)) ||
       (observation.provider === 'deepseek' &&
        observation.source === 'deepseek_balance_api' &&
        observation.scope === 'api_account' &&
        observation.administratorReadAccess === false &&
        observation.scopeRef === 'deepseek-account'));
    if (!recognized ||
        observation.billingOwnerVerified !== false ||
        observation.vendorInvoiceVerified !== false ||
        observation.modelKeyProjectLinkVerified !== false ||
        observation.perRequestCashCapGuaranteed !== false ||
        observation.productionDispatchEnabled !== false ||
        !Array.isArray(observation.amounts) || observation.amounts.length < 1 ||
        observation.amounts.length > 2 ||
        observation.amounts.some(value =>
          !value || (value.currency !== 'USD' && value.currency !== 'CNY') ||
          !Number.isSafeInteger(value.minor) || value.minor < 0 ||
          value.minor > 1000000000000) ||
        (observation.provider === 'openai' &&
          (observation.amounts.length !== 1 || observation.amounts[0].currency !== 'USD' ||
          !Number.isSafeInteger(observation.periodStart) ||
          !Number.isSafeInteger(observation.periodEnd) ||
          observation.periodEnd! - observation.periodStart! !== 86400000)) ||
        (observation.provider === 'deepseek' &&
          (observation.periodStart !== null || observation.periodEnd !== null))) {
      throw new IdentityError(422, 'billing_observation_invalid');
    }
    return this.transaction(() => {
      const credential = this.db.prepare(
        'SELECT provider_kind FROM managed_accounts ' +
        'WHERE id=? AND tenant_id=? AND revoked_ms IS NULL AND verified_ms>?'
      ).get(credentialId, principal.tenantId, this.clock() - VALIDATION_MS) as
        { provider_kind: string } | undefined;
      if (!credential || credential.provider_kind !== observation.provider) {
        throw new IdentityError(403, 'billing_observation_account_changed');
      }
      const observationId = randomUUID();
      const scopeHash = this.keyFingerprint('billing-scope:' + observation.provider +
        ':' + observation.scopeRef);
      const scopeHint = observation.scope === 'project'
        ? 'Project …' + observation.scopeRef.slice(-4) : 'API balance';
      const observedAt = this.clock();
      const amounts = observation.amounts.map(v => ({
        currency: v.currency, minor: v.minor
      }));
      this.db.prepare(
        'INSERT INTO billing_observations(id,tenant_id,actor_id,credential_id,' +
        'provider,source,scope,scope_hash,scope_hint,amounts_json,' +
        'period_start_ms,period_end_ms,observed_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ).run(observationId, principal.tenantId, principal.userId, credentialId,
        observation.provider, observation.source, observation.scope,
        scopeHash, scopeHint, JSON.stringify(amounts),
        observation.periodStart, observation.periodEnd, observedAt);
      // Bound storage; billing history is a preview, not a vendor ledger.
      this.db.prepare(
        'DELETE FROM billing_observations WHERE tenant_id=? AND id NOT IN ' +
        '(SELECT id FROM billing_observations WHERE tenant_id=? ' +
        'ORDER BY observed_ms DESC,id DESC LIMIT 100)'
      ).run(principal.tenantId, principal.tenantId);
      this.audit(principal.tenantId, principal.userId,
        'billing.observation.readonly', observationId);
      return {
        observationId, credentialId, provider: observation.provider,
        source: observation.source, scope: observation.scope, scopeHint,
        observedAt: iso(observedAt),
        periodStart: observation.periodStart === null ? null : iso(observation.periodStart),
        periodEnd: observation.periodEnd === null ? null : iso(observation.periodEnd),
        amounts, billingOwnerVerified: false as const,
        vendorInvoiceVerified: false as const,
        modelKeyProjectLinkVerified: false as const,
        perRequestCashCapGuaranteed: false as const,
        productionDispatchEnabled: false as const
      };
    });
  }

  listBillingObservations(principal: IdentityPrincipal): Array<{
    observationId: string; credentialId: string; provider: string; source: string;
    scope: string; scopeHint: string; observedAt: string;
    periodStart: string | null; periodEnd: string | null;
    amounts: Array<{ currency: string; minor: number }>;
    vendorInvoiceVerified: false; billingOwnerVerified: false;
    modelKeyProjectLinkVerified: false; perRequestCashCapGuaranteed: false;
    productionDispatchEnabled: false;
  }> {
    const rows = this.db.prepare(
      'SELECT * FROM billing_observations WHERE tenant_id=? ' +
      'ORDER BY observed_ms DESC,id DESC LIMIT 50'
    ).all(principal.tenantId) as Row[];
    return rows.map(row => ({
      observationId: String(row.id), credentialId: String(row.credential_id),
      provider: String(row.provider), source: String(row.source),
      scope: String(row.scope), scopeHint: String(row.scope_hint),
      observedAt: iso(Number(row.observed_ms)),
      periodStart: row.period_start_ms === null ? null : iso(Number(row.period_start_ms)),
      periodEnd: row.period_end_ms === null ? null : iso(Number(row.period_end_ms)),
      amounts: JSON.parse(String(row.amounts_json)) as Array<{ currency: string; minor: number }>,
      billingOwnerVerified: false as const,
      vendorInvoiceVerified: false as const,
      modelKeyProjectLinkVerified: false as const,
      perRequestCashCapGuaranteed: false as const,
      productionDispatchEnabled: false as const
    }));
  }


  /** This account belongs ONLY to the Daming tenant vault. It has no Magpie
   * provider binding, process launch grant, or route execution permit. */
  listIndependentAccounts(principal: IdentityPrincipal): Array<{
    credentialId: string; provider: ProviderKind; modelId: string; label: string;
    verifiedAt: string; expiresAt: string; magpieBindingVerified: false;
    vendorBillingOwnerVerified: false; productionDispatchEnabled: false;
  }> {
    return (this.db.prepare(
      'SELECT a.*,o.expires_ms AS vendor_expires_ms FROM tenant_api_accounts a ' +
      'LEFT JOIN openai_admin_issuances o ON o.credential_id=a.id ' +
      'AND o.tenant_id=a.tenant_id AND o.status=\'issued\' ' +
      'WHERE a.tenant_id=? AND a.revoked_ms IS NULL ' +
      'ORDER BY a.verified_ms DESC,a.id LIMIT 100'
    ).all(principal.tenantId) as Row[]).map(row => ({
      credentialId: String(row.id), provider: String(row.provider) as ProviderKind,
      modelId: String(row.model_id), label: String(row.label),
      verifiedAt: iso(Number(row.verified_ms)),
      expiresAt: iso(Math.min(Number(row.verified_ms) + VALIDATION_MS,
        row.vendor_expires_ms == null ? Number.MAX_SAFE_INTEGER : Number(row.vendor_expires_ms))),
      magpieBindingVerified: false as const,
      vendorBillingOwnerVerified: false as const,
      productionDispatchEnabled: false as const
    }));
  }
  /**
   * Trusted Host ONLY. Never serialize the returned secret or expose this
   * method through an HTTP handler. Rechecks owner, tenant, revocation,
   * freshness and official-issued key expiry at the moment of dispatch.
   */
  trustedEgressAccount(principal: IdentityPrincipal, credentialId: string):
    { provider: ProviderKind; modelId: string; apiKey: string } {
    isOwner(principal);
    if (!UUID.test(credentialId)) throw new IdentityError(404, 'tenant_account_not_found');
    const row = this.db.prepare(
      'SELECT a.*,o.expires_ms AS official_expires FROM tenant_api_accounts a ' +
      'LEFT JOIN openai_admin_issuances o ON o.credential_id=a.id ' +
      "AND o.tenant_id=a.tenant_id AND o.status='issued' " +
      'WHERE a.id=? AND a.tenant_id=? AND a.revoked_ms IS NULL'
    ).get(credentialId, principal.tenantId) as Row | undefined;
    if (!row || Number(row.verified_ms) <= this.clock() - VALIDATION_MS ||
        (row.official_expires != null && Number(row.official_expires) <= this.clock())) {
      throw new IdentityError(403, 'tenant_egress_account_unverified_or_expired');
    }
    const provider = String(row.provider);
    if (provider !== 'deepseek' && provider !== 'openai') {
      throw new IdentityError(403, 'tenant_egress_provider_unsupported');
    }
    const apiKey = this.unseal(String(row.ciphertext),
      'tenant-account:' + principal.tenantId + ':' + credentialId);
    if (apiKey.length < 12 || apiKey.length > 4096 || /[\r\n\0]/.test(apiKey)) {
      throw new IdentityError(503, 'tenant_egress_secret_invalid');
    }
    return { provider, modelId: String(row.model_id), apiKey };
  }

  registerIndependentAccount(principal: IdentityPrincipal, input: {
    provider: ProviderKind; modelId: string; label: string; apiKey: string;
  }): ReturnType<IdentityRegistry['listIndependentAccounts']>[number] {
    isOwner(principal);
    if (!input || (input.provider !== 'deepseek' && input.provider !== 'openai') ||
        typeof input.modelId !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/-]{1,99}$/.test(input.modelId) ||
        typeof input.apiKey !== 'string' || input.apiKey.length < 12 ||
        input.apiKey.length > 4096 || /[\r\n\0]/.test(input.apiKey)) {
      throw new IdentityError(400, 'tenant_key_invalid');
    }
    const label = validateLabel(input.label);
    const secretHmac = this.keyFingerprint(input.apiKey);
    return this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM tenant_api_accounts WHERE key_hmac=?').get(secretHmac) ||
          this.db.prepare('SELECT 1 FROM managed_accounts WHERE key_hmac=?').get(secretHmac)) {
        throw new IdentityError(409, 'tenant_key_already_claimed');
      }
      const credentialId = randomUUID(), verified = this.clock();
      const ciphertext = this.seal(input.apiKey,
        'tenant-account:' + principal.tenantId + ':' + credentialId);
      this.db.prepare('INSERT INTO tenant_api_accounts(id,tenant_id,created_by,' +
        'provider,model_id,label,key_hmac,ciphertext,verified_ms) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(credentialId, principal.tenantId, principal.userId,
          input.provider, input.modelId, label, secretHmac, ciphertext, verified);
      this.audit(principal.tenantId, principal.userId, 'tenant.api_key.verified', credentialId);
      return {
        credentialId, provider: input.provider, modelId: input.modelId, label,
        verifiedAt: iso(verified), expiresAt: iso(verified + VALIDATION_MS),
        magpieBindingVerified: false as const, vendorBillingOwnerVerified: false as const,
        productionDispatchEnabled: false as const
      };
    });
  }
  independentAccountForVerification(principal: IdentityPrincipal, credentialId: string):
    { provider: ProviderKind; modelId: string; keyHmac: string } | null {
    isOwner(principal);
    if (!UUID.test(credentialId)) return null;
    const row = this.db.prepare(
      'SELECT provider,model_id,key_hmac FROM tenant_api_accounts ' +
      'WHERE id=? AND tenant_id=? AND revoked_ms IS NULL'
    ).get(credentialId, principal.tenantId) as Row | undefined;
    return row ? { provider: String(row.provider) as ProviderKind,
      modelId: String(row.model_id), keyHmac: String(row.key_hmac) } : null;
  }
  renewIndependentAccount(
    principal: IdentityPrincipal, credentialId: string, apiKey: string
  ): ReturnType<IdentityRegistry['listIndependentAccounts']>[number] {
    const bound = this.independentAccountForVerification(principal, credentialId);
    if (!bound || typeof apiKey !== 'string' || apiKey.length > 4096 ||
        !secureEqual(Buffer.from(bound.keyHmac, 'hex'),
          Buffer.from(this.keyFingerprint(apiKey), 'hex'))) {
      throw new IdentityError(403, 'tenant_api_key_mismatch');
    }
    return this.transaction(() => {
      const result = this.db.prepare(
        'UPDATE tenant_api_accounts SET verified_ms=? WHERE id=? AND tenant_id=? AND revoked_ms IS NULL'
      ).run(this.clock(), credentialId, principal.tenantId);
      if (result.changes !== 1) throw new IdentityError(409, 'tenant_api_key_revoked');
      this.audit(principal.tenantId, principal.userId, 'tenant.api_key.reverified', credentialId);
      return this.listIndependentAccounts(principal).find(row =>
        row.credentialId === credentialId)!;
    });
  }
  revokeIndependentAccount(principal: IdentityPrincipal, credentialId: string): void {
    isOwner(principal);
    if (!UUID.test(credentialId)) throw new IdentityError(404, 'tenant_account_not_found');
    this.transaction(() => {
      const result = this.db.prepare(
        'UPDATE tenant_api_accounts SET revoked_ms=? ' +
        'WHERE id=? AND tenant_id=? AND revoked_ms IS NULL'
      ).run(this.clock(), credentialId, principal.tenantId);
      if (result.changes !== 1) throw new IdentityError(404, 'tenant_account_not_found');
      this.audit(principal.tenantId, principal.userId, 'tenant.api_key.revoked', credentialId);
    });
  }


  /** Durable one-shot journal written BEFORE the vendor key-creation request.
   * Reusing the same requestId can never create another upstream key.
   */
  beginOpenAiKeyIssuance(principal: IdentityPrincipal, input: {
    requestId: string; projectId: string; serviceAccountId: string; modelId: string;
  }): void {
    isOwner(principal);
    if (!input || !UUID.test(input.requestId) ||
        !/^proj_[A-Za-z0-9_-]{3,100}$/.test(input.projectId) ||
        !/^svc_acct_[A-Za-z0-9_-]{3,100}$/.test(input.serviceAccountId) ||
        typeof input.modelId !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/-]{1,99}$/.test(input.modelId)) {
      throw new IdentityError(400, 'openai_key_issuance_request_invalid');
    }
    this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM openai_admin_issuances WHERE request_id=?')
        .get(input.requestId)) throw new IdentityError(409, 'openai_issuance_id_already_used');
      const blocked = this.db.prepare(
        "SELECT 1 FROM openai_admin_issuances WHERE tenant_id=? AND project_id=? " +
        "AND status IN ('started','uncertain') LIMIT 1"
      ).get(principal.tenantId, input.projectId);
      if (blocked) throw new IdentityError(409, 'openai_prior_issuance_requires_reconciliation');
      this.db.prepare(
        'INSERT INTO openai_admin_issuances(request_id,tenant_id,actor_id,project_id,' +
        'service_account_id,model_id,status,created_ms) VALUES(?,?,?,?,?,?,?,?)'
      ).run(input.requestId, principal.tenantId, principal.userId, input.projectId,
        input.serviceAccountId, input.modelId, 'started', this.clock());
      this.audit(principal.tenantId, principal.userId, 'openai.key_issuance.started',
        input.requestId);
    });
  }
  /** Used for any vendor failure after request journaling. It is NOT rollback:
   * an upstream key may exist and needs administrator intervention. */
  markOpenAiKeyIssuanceUncertain(principal: IdentityPrincipal, requestId: string): void {
    isOwner(principal);
    if (!UUID.test(requestId)) throw new IdentityError(404, 'openai_issuance_not_found');
    this.transaction(() => {
      const changed = this.db.prepare(
        "UPDATE openai_admin_issuances SET status='uncertain' " +
        "WHERE request_id=? AND tenant_id=? AND status='started'"
      ).run(requestId, principal.tenantId);
      if (changed.changes === 1) {
        this.audit(principal.tenantId, principal.userId, 'openai.key_issuance.uncertain', requestId);
      }
    });
  }
  completeOpenAiKeyIssuance(
    principal: IdentityPrincipal, requestId: string, issued: OpenAiIssuedServiceKey
  ): {
    requestId: string; credentialId: string; status: 'issued';
    projectHint: string; serviceAccountHint: string;
    expiresAt: string; officialProjectIssuanceVerified: true;
    vendorBillingOwnerVerified: false; vendorInvoiceVerified: false;
    guaranteedCashCap: false; productionDispatchEnabled: false;
  } {
    isOwner(principal);
    if (!UUID.test(requestId) || !issued ||
        issued.officialProjectIssuanceVerified !== true ||
        issued.vendorBillingOwnerVerified !== false ||
        issued.invoiceReconciled !== false ||
        issued.guaranteedCashCap !== false ||
        issued.paidDispatchPermitted !== false ||
        !/^key_[A-Za-z0-9_-]{3,100}$/.test(issued.keyId) ||
        typeof issued.secret !== 'string' || issued.secret.length < 12 ||
        issued.secret.length > 4096 || /[\r\n\0]/.test(issued.secret) ||
        !Number.isSafeInteger(issued.expiresAtMs) ||
        issued.expiresAtMs <= this.clock() ||
        issued.expiresAtMs > this.clock() + 3900000) {
      throw new IdentityError(422, 'openai_issuance_result_invalid');
    }
    return this.transaction(() => {
      const row = this.db.prepare(
        'SELECT * FROM openai_admin_issuances WHERE request_id=? AND tenant_id=?'
      ).get(requestId, principal.tenantId) as Row | undefined;
      if (!row || row.status !== 'started' || row.actor_id !== principal.userId ||
          row.project_id !== issued.projectId ||
          row.service_account_id !== issued.serviceAccountId) {
        throw new IdentityError(409, 'openai_issuance_not_authorized_or_replayed');
      }
      const fingerprint = this.keyFingerprint(issued.secret);
      if (this.db.prepare('SELECT 1 FROM tenant_api_accounts WHERE key_hmac=?')
        .get(fingerprint) ||
          this.db.prepare('SELECT 1 FROM managed_accounts WHERE key_hmac=?')
            .get(fingerprint)) throw new IdentityError(409, 'openai_issued_key_duplicate');
      const credentialId = randomUUID();
      const encrypted = this.seal(issued.secret,
        'tenant-account:' + principal.tenantId + ':' + credentialId);
      this.db.prepare('INSERT INTO tenant_api_accounts(id,tenant_id,created_by,' +
        'provider,model_id,label,key_hmac,ciphertext,verified_ms) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(credentialId, principal.tenantId, principal.userId,
          'openai', String(row.model_id), 'OpenAI service account ' + issued.keyId.slice(-8),
          fingerprint, encrypted, this.clock());
      this.db.prepare(
        "UPDATE openai_admin_issuances SET status='issued',credential_id=?,key_id=?," +
        "expires_ms=? WHERE request_id=? AND tenant_id=? AND status='started'"
      ).run(credentialId, issued.keyId, issued.expiresAtMs, requestId, principal.tenantId);
      this.audit(principal.tenantId, principal.userId, 'openai.key_issuance.completed', requestId);
      return {
        requestId, credentialId, status: 'issued' as const,
        projectHint: 'proj…' + issued.projectId.slice(-4),
        serviceAccountHint: 'svc…' + issued.serviceAccountId.slice(-4),
        expiresAt: iso(issued.expiresAtMs),
        officialProjectIssuanceVerified: true as const,
        vendorBillingOwnerVerified: false as const,
        vendorInvoiceVerified: false as const,
        guaranteedCashCap: false as const,
        productionDispatchEnabled: false as const
      };
    });
  }
  /** Admin cost aggregation can only be scoped to an official service
   * key we created and recorded for this exact tenant and project. A raw
   * BYOA API key without key_id has no authenticated invoice binding. */
  trustedIssuedOpenAiCostScope(principal: IdentityPrincipal, credentialId: string):
    { credentialId: string; projectId: string; keyId: string } {
    isOwner(principal);
    if (!UUID.test(credentialId)) throw new IdentityError(404, 'openai_issued_key_not_found');
    const row = this.db.prepare(
      'SELECT i.project_id,i.key_id FROM openai_admin_issuances i ' +
      'JOIN tenant_api_accounts a ON a.id=i.credential_id AND a.tenant_id=i.tenant_id ' +
      'WHERE i.tenant_id=? AND i.credential_id=? AND i.status=\'issued\' ' +
      "AND a.provider='openai' AND a.revoked_ms IS NULL"
    ).get(principal.tenantId, credentialId) as Row | undefined;
    if (!row || typeof row.key_id !== 'string' ||
        !/^key_[A-Za-z0-9_-]{3,100}$/.test(row.key_id as string) ||
        typeof row.project_id !== 'string' ||
        !/^proj_[A-Za-z0-9_-]{3,100}$/.test(row.project_id as string)) {
      throw new IdentityError(404, 'openai_issued_key_not_found');
    }
    return { credentialId, projectId: String(row.project_id), keyId: String(row.key_id) };
  }

  /** Append-only provider ADMIN observation. It does not reduce any paid
   * hold; official daily costs are not request invoices or exact cash caps. */
  recordOfficialIssuedKeyDailyCost(principal: IdentityPrincipal,
    credentialId: string, evidence: {
      source: 'openai_admin_daily_costs_api';
      utcDay: string; totalMicroUsd: number;
      issuedKeyProjectBindingChecked: true;
      officialAggregateObserved: true;
      invoiceAuthenticated: false;
      strictPerRequestCashCapVerified: false;
      automaticallyReleasesUnknownHold: false;
    }): { observationId: string; utcDay: string; costMicroUsd: number;
      provider: 'openai'; scope: 'issued_service_key_daily_aggregate';
      invoiceAuthenticated: false; singleRequestSettled: false;
      cashHoldReleased: false } {
    isOwner(principal);
    const scope = this.trustedIssuedOpenAiCostScope(principal, credentialId);
    if (!evidence || evidence.source !== 'openai_admin_daily_costs_api' ||
        evidence.officialAggregateObserved !== true ||
        evidence.issuedKeyProjectBindingChecked !== true ||
        evidence.invoiceAuthenticated !== false ||
        evidence.strictPerRequestCashCapVerified !== false ||
        evidence.automaticallyReleasesUnknownHold !== false ||
        typeof evidence.utcDay !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(evidence.utcDay) ||
        !Number.isSafeInteger(evidence.totalMicroUsd) ||
        evidence.totalMicroUsd < 0 || evidence.totalMicroUsd > 1000000000000) {
      throw new IdentityError(422, 'official_cost_evidence_invalid');
    }
    const observationId = randomUUID();
    this.transaction(() => {
      this.db.prepare('INSERT INTO official_key_cost_observations(' +
        'id,tenant_id,actor_id,credential_id,project_id,api_key_id,' +
        'utc_day,cost_micro_usd,observed_ms) VALUES(?,?,?,?,?,?,?,?,?)'
      ).run(observationId, principal.tenantId, principal.userId,
        credentialId, scope.projectId, scope.keyId, evidence.utcDay,
        evidence.totalMicroUsd, this.clock());
      this.audit(principal.tenantId, principal.userId,
        'billing.official_key_daily_cost_observed', observationId);
    });
    return { observationId, utcDay: evidence.utcDay,
      costMicroUsd: evidence.totalMicroUsd, provider: 'openai',
      scope: 'issued_service_key_daily_aggregate',
      invoiceAuthenticated: false, singleRequestSettled: false,
      cashHoldReleased: false };
  }
  listOfficialIssuedKeyCostObservations(principal: IdentityPrincipal) {
    isOwner(principal);
    return (this.db.prepare(
      'SELECT * FROM official_key_cost_observations WHERE tenant_id=? ' +
      'ORDER BY observed_ms DESC,id DESC LIMIT 100'
    ).all(principal.tenantId) as Row[]).map(r => ({
      observationId: String(r.id), credentialId: String(r.credential_id),
      projectHint: 'proj…' + String(r.project_id).slice(-4),
      keyHint: 'key…' + String(r.api_key_id).slice(-4),
      utcDay: String(r.utc_day), totalMicroUsd: Number(r.cost_micro_usd),
      observedAt: iso(Number(r.observed_ms)),
      invoiceAuthenticated: false as const,
      perRequestCostAttributable: false as const, cashHoldReleased: false as const
    }));
  }

  recordOfficialOpenAiSpendLimit(principal: IdentityPrincipal,
    credentialId: string, evidence: {
      source: 'openai_admin_spend_limit_api';
      project: { enforcementStatus: string; thresholdMinor: number };
      organization: { enforcementStatus: string; thresholdMinor: number };
      officialMonthlyLimitsObserved: true;
      limitMayOvershoot: true;
      precisePerRequestCashCapVerified: false;
      vendorInvoiceAuthenticated: false;
      enablesAutomaticPaidDispatch: false;
    }): { observationId: string; monthlyProviderLimitObserved: true;
      strictCashCapVerified: false; automaticDispatchEnabled: false } {
    isOwner(principal);
    const scope = this.trustedIssuedOpenAiCostScope(principal, credentialId);
    const valid = (item: { enforcementStatus: string; thresholdMinor: number }) =>
      item && ['enforcing','inactive'].includes(item.enforcementStatus) &&
      Number.isSafeInteger(item.thresholdMinor) && item.thresholdMinor > 0 &&
      item.thresholdMinor <= 100000000;
    if (!evidence || evidence.source !== 'openai_admin_spend_limit_api' ||
        evidence.officialMonthlyLimitsObserved !== true ||
        evidence.limitMayOvershoot !== true ||
        evidence.precisePerRequestCashCapVerified !== false ||
        evidence.vendorInvoiceAuthenticated !== false ||
        evidence.enablesAutomaticPaidDispatch !== false ||
        !valid(evidence.project) || !valid(evidence.organization)) {
      throw new IdentityError(422, 'official_spend_limit_evidence_invalid');
    }
    const observationId = randomUUID();
    this.transaction(() => {
      this.db.prepare('INSERT INTO official_spend_limit_observations(' +
        'id,tenant_id,actor_id,credential_id,project_id,observed_ms,' +
        'project_status,project_minor,org_status,org_minor) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(observationId, principal.tenantId, principal.userId,
          credentialId, scope.projectId, this.clock(),
          evidence.project.enforcementStatus, evidence.project.thresholdMinor,
          evidence.organization.enforcementStatus, evidence.organization.thresholdMinor);
      this.audit(principal.tenantId, principal.userId,
        'billing.official_monthly_limit_observed', observationId);
    });
    return { observationId, monthlyProviderLimitObserved: true,
      strictCashCapVerified: false, automaticDispatchEnabled: false };
  }
  listOfficialOpenAiSpendLimits(principal: IdentityPrincipal) {
    isOwner(principal);
    return (this.db.prepare(
      'SELECT * FROM official_spend_limit_observations WHERE tenant_id=? ' +
      'ORDER BY observed_ms DESC,id DESC LIMIT 50'
    ).all(principal.tenantId) as Row[]).map(r => ({
      observationId: String(r.id), credentialId: String(r.credential_id),
      projectHint: 'proj…' + String(r.project_id).slice(-4),
      observedAt: iso(Number(r.observed_ms)),
      project: { enforcementStatus: String(r.project_status),
        thresholdMinor: Number(r.project_minor) },
      organization: { enforcementStatus: String(r.org_status),
        thresholdMinor: Number(r.org_minor) },
      providerMonthlyLimitObserved: true as const,
      strictPerRequestCashCapVerified: false as const,
      limitMayOvershoot: true as const,
      automaticDispatchEnabled: false as const
    }));
  }

  listOpenAiKeyIssuances(principal: IdentityPrincipal): Array<{
    requestId: string; credentialId: string | null; status: string;
    projectHint: string; serviceAccountHint: string;
    expiresAt: string | null; officialProjectIssuanceVerified: boolean;
    productionDispatchEnabled: false;
  }> {
    isOwner(principal);
    return (this.db.prepare(
      'SELECT * FROM openai_admin_issuances WHERE tenant_id=? ' +
      'ORDER BY created_ms DESC,request_id DESC LIMIT 100'
    ).all(principal.tenantId) as Row[]).map(row => ({
      requestId: String(row.request_id), credentialId:
        row.credential_id == null ? null : String(row.credential_id),
      status: String(row.status),
      projectHint: 'proj…' + String(row.project_id).slice(-4),
      serviceAccountHint: 'svc…' + String(row.service_account_id).slice(-4),
      expiresAt: row.expires_ms == null ? null : iso(Number(row.expires_ms)),
      officialProjectIssuanceVerified: row.status === 'issued',
      productionDispatchEnabled: false as const
    }));
  }

  productionReadiness(principal: IdentityPrincipal): {
    tenantId: string; mfaEnabled: boolean; validKeyControlProofs: number;
    billingOrganizationVerified: false; guaranteedPerRequestHardCap: false;
    vendorInvoiceReconciled: false; sharedLegacyServicesIsolated: false;
    paidModelDispatchPermitted: false; blockers: string[];
  } {
    const valid = this.db.prepare(
      'SELECT count(*) AS count FROM managed_accounts WHERE tenant_id=? AND revoked_ms IS NULL AND verified_ms>?'
    ).get(principal.tenantId, this.clock() - VALIDATION_MS) as { count: number };
    const independentlyVerified = this.db.prepare(
      'SELECT count(*) AS count FROM tenant_api_accounts a WHERE a.tenant_id=? ' +
      'AND a.revoked_ms IS NULL AND a.verified_ms>? AND NOT EXISTS(' +
      "SELECT 1 FROM openai_admin_issuances o WHERE o.credential_id=a.id AND o.status='issued')"
    ).get(principal.tenantId, this.clock() - VALIDATION_MS) as { count: number };
    const validProofs = Number(valid.count) + Number(independentlyVerified.count);
    const mfaEnabled = this.hasMfa(principal);
    return {
      tenantId: principal.tenantId, mfaEnabled,
      validKeyControlProofs: validProofs,
      billingOrganizationVerified: false,
      guaranteedPerRequestHardCap: false,
      vendorInvoiceReconciled: false,
      sharedLegacyServicesIsolated: false,
      paidModelDispatchPermitted: false,
      blockers: [
        ...(!mfaEnabled ? ['mfa_enrollment_required'] : []),
        ...(validProofs === 0 ? ['no_recent_verified_api_key'] : []),
        'vendor_billing_organization_proof_missing',
        'vendor_guaranteed_per_request_cash_limit_missing',
        'vendor_authenticated_invoice_reconciliation_missing',
        'legacy_global_services_not_multitenant'
      ]
    };
  }

  listMembers(principal: IdentityPrincipal): { userId: string; username: string; role: MemberRole }[] {
    return (this.db.prepare(
      'SELECT u.id,u.username,m.role FROM memberships m JOIN users u ON u.id=m.user_id ' +
      'WHERE m.tenant_id=? ORDER BY u.username'
    ).all(principal.tenantId) as Row[]).map(row => ({
      userId: String(row.id), username: String(row.username), role: String(row.role) as MemberRole
    }));
  }
  removeMember(principal: IdentityPrincipal, memberId: string): void {
    isOwner(principal);
    if (!UUID.test(memberId) || memberId === principal.userId)
      throw new IdentityError(403, 'cannot_remove_self');
    this.transaction(() => {
      const removed = this.db.prepare(
        "DELETE FROM memberships WHERE tenant_id=? AND user_id=? AND role!='owner'"
      ).run(principal.tenantId, memberId);
      if (removed.changes !== 1) throw new IdentityError(404, 'member_not_found_or_owner');
      this.db.prepare('UPDATE identity_sessions SET revoked=1 WHERE tenant_id=? AND user_id=?')
        .run(principal.tenantId, memberId);
      this.audit(principal.tenantId, principal.userId, 'member.removed', memberId);
    });
  }

  /** Host-only binding; intentionally never serialized to a client. */
  accountForVerification(principal: IdentityPrincipal, credentialId: string):
    (CredentialBinding & { providerKind: ProviderKind; keyHmac: string }) | null {
    isOwner(principal);
    if (!UUID.test(credentialId)) return null;
    const row = this.db.prepare(
      'SELECT * FROM managed_accounts WHERE id=? AND tenant_id=? AND revoked_ms IS NULL'
    ).get(credentialId, principal.tenantId) as Row | undefined;
    if (!row) return null;
    return {
      instanceId: String(row.instance_id), providerId: String(row.provider_id),
      accountRef: String(row.account_ref), providerKind: String(row.provider_kind) as ProviderKind,
      keyHmac: String(row.key_hmac)
    };
  }
  reverifyAccount(principal: IdentityPrincipal, credentialId: string, secret: string): StoredCredentialView {
    isOwner(principal);
    const bound = this.accountForVerification(principal, credentialId);
    if (!bound || typeof secret !== 'string' ||
        !secureEqual(Buffer.from(bound.keyHmac, 'hex'), Buffer.from(this.keyFingerprint(secret), 'hex'))) {
      throw new IdentityError(403, 'credential_reverification_denied');
    }
    return this.transaction(() => {
      const updated = this.db.prepare(
        'UPDATE managed_accounts SET verified_ms=? WHERE id=? AND tenant_id=? AND revoked_ms IS NULL'
      ).run(this.clock(), credentialId, principal.tenantId);
      if (updated.changes !== 1) throw new IdentityError(409, 'credential_revoked_during_verification');
      this.audit(principal.tenantId, principal.userId, 'account.key.control.reverified', credentialId);
      const row = this.db.prepare('SELECT * FROM managed_accounts WHERE id=?').get(credentialId) as Row;
      return {
        credentialId, providerKind: String(row.provider_kind) as ProviderKind,
        label: String(row.label), instanceId: String(row.instance_id),
        providerId: String(row.provider_id), accountRef: '[private]',
        proof: 'vendor_key_control_and_exact_magpie_key',
        verifiedAt: iso(Number(row.verified_ms)), expiresAt: iso(Number(row.verified_ms) + VALIDATION_MS),
        vendorBillingOwnerVerified: false, productionDispatchEnabled: false
      };
    });
  }

  revokeAccount(principal: IdentityPrincipal, credentialId: string): void {
    isOwner(principal);
    if (!UUID.test(credentialId)) throw new IdentityError(404, 'credential_not_found');
    this.transaction(() => {
      const changed = this.db.prepare(
        'UPDATE managed_accounts SET revoked_ms=? WHERE id=? AND tenant_id=? AND revoked_ms IS NULL'
      ).run(this.clock(), credentialId, principal.tenantId);
      if (changed.changes !== 1) throw new IdentityError(404, 'credential_not_found');
      this.audit(principal.tenantId, principal.userId, 'account.revoked', credentialId);
    });
  }
}
