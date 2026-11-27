import { CheckinPolicy } from '../../../packages/governance/src/index.ts';
import type { CheckinOwner } from '../../../packages/governance/src/index.ts';
import type { LocalCredentialStore } from './credentials.ts';

/**
 * Import accounts that currently live in Magpie into Daming's OWN check-in store,
 * so Daming can sign in by itself (no Magpie runtime at check-in time).
 * Accepts Magpie's `logins.json` shape: an array of records with
 * { id, agent, user, auth, ... }. Records with no usable secret are skipped.
 */
export interface MagpieAccountRecord {
  readonly id?: unknown;
  readonly agent?: unknown;
  readonly user?: unknown;
  readonly auth?: unknown;
  readonly on?: unknown;
}
export interface ListedAccount {
  readonly accountId: string;
  readonly platform: string;
  readonly user?: string;
  readonly hasSecret: boolean;
}
export interface ImportSummary {
  readonly imported: number;
  readonly skipped: number;
  readonly accounts: readonly { accountId: string; platform: string; user?: string }[];
}

const ID = /^[A-Za-z0-9_.:-]{1,80}$/;

function asArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }

function secretOf(auth: unknown): string | undefined {
  if (auth === undefined || auth === null || auth === '') return undefined;
  if (typeof auth === 'string') return auth.trim() ? auth : undefined;
  const json = JSON.stringify(auth);
  return json === '{}' || json === '[]' || json === '""' || json === 'null' ? undefined : json;
}

function fields(rec: unknown): { platform: string; accountId: string; user?: string; secret?: string } | undefined {
  if (!rec || typeof rec !== 'object') return undefined;
  const r = rec as MagpieAccountRecord;
  const platform = typeof r.agent === 'string' ? r.agent : '';
  const accountId = typeof r.id === 'string' ? r.id : (typeof r.user === 'string' ? r.user : '');
  if (!ID.test(platform) || !ID.test(accountId)) return undefined;
  const secret = secretOf(r.auth);
  return { platform, accountId, ...(typeof r.user === 'string' ? { user: r.user } : {}), ...(secret !== undefined ? { secret } : {}) };
}

/** Dry-run: list accounts found in a Magpie logins payload (no secrets returned). */
export function listMagpieAccounts(input: unknown): ListedAccount[] {
  const out: ListedAccount[] = [];
  for (const rec of asArray(input)) {
    const f = fields(rec);
    if (!f) continue;
    out.push({ accountId: f.accountId, platform: f.platform, ...(f.user ? { user: f.user } : {}), hasSecret: f.secret !== undefined });
  }
  return out;
}

export interface ImportMagpieOptions {
  readonly store: LocalCredentialStore;
  readonly policy: CheckinPolicy;
  readonly owner: CheckinOwner;
  readonly nowMs: number;
  /** Only import records whose agent/platform is in this list (e.g. ['workbuddy','trae']). Omit = all with secrets. */
  readonly include?: readonly string[];
}

export function importMagpieAccounts(input: unknown, options: ImportMagpieOptions): ImportSummary {
  if (!options || !options.store || !(options.policy instanceof CheckinPolicy)) throw new Error('magpie_import_options_invalid');
  const include = options.include ? new Set(options.include) : undefined;
  let imported = 0, skipped = 0;
  const accounts: { accountId: string; platform: string; user?: string }[] = [];
  for (const rec of asArray(input)) {
    const f = fields(rec);
    if (!f || !f.secret || (include && !include.has(f.platform))) { skipped++; continue; }
    options.store.put({ accountId: f.accountId, platform: f.platform, owner: options.owner, secret: f.secret });
    options.policy.authorize({
      accountId: f.accountId, platform: f.platform, owner: options.owner,
      actions: ['checkin', 'quota.read'], frequency: 'daily', grantedAtMs: options.nowMs,
    });
    imported++;
    accounts.push({ accountId: f.accountId, platform: f.platform, ...(f.user ? { user: f.user } : {}) });
  }
  return { imported, skipped, accounts };
}

// ---------------------------------------------------------------------------
// Full Magpie data dir: built-in sign-ins live in `logins.json`, PLUGIN
// sign-ins (workbuddy / kiro / zcode / …) live in `plugin-auth.json` as
// { "<provider>" | "<provider>#<id>": { type, accountId, uid, access, refresh, … } }.
// ---------------------------------------------------------------------------

export interface MagpieSources { readonly logins?: unknown; readonly pluginAuth?: unknown }

function sanitizeId(value: string): string { return value.replace(/[^A-Za-z0-9_.:-]/g, '_'); }

function builtinEntries(logins: unknown): { platform: string; accountId: string; user?: string; secret?: string }[] {
  const out: { platform: string; accountId: string; user?: string; secret?: string }[] = [];
  for (const rec of asArray(logins)) { const f = fields(rec); if (f) out.push(f); }
  return out;
}

function pluginEntries(pluginAuth: unknown): { platform: string; accountId: string; user?: string; secret?: string }[] {
  if (!pluginAuth || typeof pluginAuth !== 'object' || Array.isArray(pluginAuth)) return [];
  const out: { platform: string; accountId: string; user?: string; secret?: string }[] = [];
  for (const [key, rec] of Object.entries(pluginAuth as Record<string, unknown>)) {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
    const r = rec as Record<string, unknown>;
    const platform = sanitizeId(String(key).split('#')[0]);
    const accountId = sanitizeId(String(key));
    const hasIdentity = typeof r.uid === 'string' || typeof r.accountId === 'string'
      || typeof r.access === 'string' || typeof r.refresh === 'string'
      || typeof r.accessToken === 'string' || typeof r.refreshToken === 'string' || typeof r.cookie === 'string';
    if (!ID.test(platform) || !ID.test(accountId)) continue;
    out.push({ platform, accountId, ...(typeof r.accountId === 'string' ? { user: r.accountId } : {}), ...(hasIdentity ? { secret: JSON.stringify(rec) } : {}) });
  }
  return out;
}

function mergedSources(sources: MagpieSources): { platform: string; accountId: string; user?: string; secret?: string }[] {
  const seen = new Set<string>();
  const out: { platform: string; accountId: string; user?: string; secret?: string }[] = [];
  for (const f of [...builtinEntries(sources.logins), ...pluginEntries(sources.pluginAuth)]) {
    // Plugin accounts also appear in logins.json as plugin:<id> placeholders with no secret;
    // prefer the plugin-auth entry which carries the credential.
    const key = f.platform + '|' + f.accountId;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

export function listMagpieSources(sources: MagpieSources): ListedAccount[] {
  return mergedSources(sources).map((f) => ({ accountId: f.accountId, platform: f.platform, ...(f.user ? { user: f.user } : {}), hasSecret: f.secret !== undefined }));
}

export function importMagpieSources(sources: MagpieSources, options: ImportMagpieOptions): ImportSummary {
  if (!options || !options.store || !(options.policy instanceof CheckinPolicy)) throw new Error('magpie_import_options_invalid');
  const include = options.include ? new Set(options.include) : undefined;
  let imported = 0, skipped = 0;
  const accounts: { accountId: string; platform: string; user?: string }[] = [];
  for (const f of mergedSources(sources)) {
    if (!f.secret || (include && !include.has(f.platform))) { skipped++; continue; }
    options.store.put({ accountId: f.accountId, platform: f.platform, owner: options.owner, secret: f.secret });
    options.policy.authorize({
      accountId: f.accountId, platform: f.platform, owner: options.owner,
      actions: ['checkin', 'quota.read'], frequency: 'daily', grantedAtMs: options.nowMs,
    });
    imported++;
    accounts.push({ accountId: f.accountId, platform: f.platform, ...(f.user ? { user: f.user } : {}) });
  }
  return { imported, skipped, accounts };
}
