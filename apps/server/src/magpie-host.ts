import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, closeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { connect } from 'node:net';
import { request as nativeHttpRequest } from 'node:http';
import { inspectLegacyMagpieMeta, migrateLegacyMagpieMeta } from './magpie-migration.ts';
import { protectWindowsSecret, unprotectWindowsSecret } from './windows-secret.ts';
import { secureNewWindowsDirectory } from './windows-private-acl.ts';
import type { MagpieActionView, MagpieReadView, MagpieStatusView } from '@daming/contracts';
import { safeNpmPluginSpec, summarizeMagpieRead } from './magpie-safe.ts';
import { projectMagpieRoutingCatalog } from './magpie-routing.ts';
import { projectMagpieUnifiedTargets } from './magpie-unified-targets.ts';
import type { MagpieUnifiedCatalog } from './magpie-unified-targets.ts';
import type { MagpieRoutingCatalog } from './magpie-routing.ts';
import { proveExactMagpieCredential } from './magpie-owner-proof.ts';
import type { CredentialBinding, ProviderKind } from './identity-registry.ts';
import { withPinnedMagpieTurn } from './magpie-codex-turn.ts';
import type { MagpieForwardAuthorization, MagpieProjectWire } from './magpie-codex-turn.ts';
import type { CodexModelForward } from '@daming/worker-process';
import { selectCodexSubscriptionBinding, validPinnedMagpieBinding } from './magpie-codex-subscription.ts';

const BINARY = resolve('runtime/magpie/windows-x64/daming-magpie-codex-subscription-v2.exe');
const DEFAULT_PORT = 3457;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

interface MagpieMeta {
  readonly version: 2;
  readonly port: number;
  readonly adminPort: number;
  readonly adminKey: string;
  readonly instanceId: string;
  readonly dataDir: string;
  readonly migratedFrom?: 1;
}

export class MagpieHostError extends Error {}

function privateDirs(dataDir: string) {
  const base = resolve(dataDir);
  return {
    base, config: join(base, 'config'), cache: join(base, 'cache'),
    state: join(base, 'state'), local: join(base, 'local'), appdata: join(base, 'appdata')
  };
}

function envFor(dirs: ReturnType<typeof privateDirs>, port: number, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'PATH']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return {
    ...env,
    MAGPIE_ADDR: '127.0.0.1:' + port,
    XDG_CONFIG_HOME: dirs.config,
    XDG_CACHE_HOME: dirs.cache,
    XDG_STATE_HOME: dirs.state,
    XDG_DATA_HOME: join(dirs.state, 'data'),
    XDG_RUNTIME_DIR: join(dirs.state, 'runtime'),
    LOCALAPPDATA: dirs.local,
    APPDATA: dirs.appdata,
    DAMING_CODEX_READONLY_AUTH: '1',
    ...extra
  };
}

function validPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1024 && value <= 65535;
}

function metaPath(dirs: ReturnType<typeof privateDirs>): string {
  return join(dirs.base, 'instance.json');
}

const metaCache = new Map<string, { raw: string; value: MagpieMeta }>();
function readMeta(dirs: ReturnType<typeof privateDirs>): MagpieMeta | undefined {
  const path = metaPath(dirs);
  if (!existsSync(path)) { metaCache.delete(path); return undefined; }
  try {
    const raw = readFileSync(path, 'utf8');
    const cached = metaCache.get(path);
    if (cached?.raw === raw) return cached.value;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const m = value as Record<string, unknown>;
    if (m.version !== 2 || !validPort(m.port) || !validPort(m.adminPort) || m.port === m.adminPort ||
        typeof m.instanceId !== 'string' || !/^[a-f0-9]{32}$/.test(m.instanceId) ||
        m.dataDir !== dirs.base || (m.migratedFrom !== undefined && m.migratedFrom !== 1)) return undefined;
    if (m.adminKey !== undefined && m.adminKeyDpapi !== undefined) return undefined;
    const key = typeof m.adminKeyDpapi === 'string'
      ? unprotectWindowsSecret(m.adminKeyDpapi)
      : m.adminKey;
    if (typeof key !== 'string' || !/^[A-Za-z0-9._~-]{16,128}$/.test(key)) return undefined;
    const result = { ...m, adminKey: key } as unknown as MagpieMeta;
    metaCache.set(path, { raw, value: result });
    return result;
  } catch { metaCache.delete(path); return undefined; }
}

function writeMeta(dirs: ReturnType<typeof privateDirs>, port: number, adminPort: number): MagpieMeta {
  const m: MagpieMeta = {
    version: 2, port, adminPort, adminKey: randomBytes(24).toString('base64url'),
    instanceId: randomBytes(16).toString('hex'), dataDir: dirs.base
  };
  const disk = process.platform === 'win32'
    ? { ...m, adminKey: undefined, adminKeyDpapi: protectWindowsSecret(m.adminKey) }
    : m;
  writeFileSync(metaPath(dirs), JSON.stringify(disk, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return m;
}

async function portOccupied(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolveResult) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(600);
    socket.once('connect', () => { socket.destroy(); resolveResult(true); });
    socket.once('timeout', () => { socket.destroy(); resolveResult(true); });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      resolveResult(error.code !== 'ECONNREFUSED');
    });
  });
}

async function gatewayReady(port: number): Promise<boolean> {
  try {
    const response = await fetch('http://127.0.0.1:' + port + '/api/hello', {
      signal: AbortSignal.timeout(1200), redirect: 'error'
    });
    if (!response.ok) return false;
    const value: unknown = await response.json();
    return !!value && typeof value === 'object' && (value as Record<string, unknown>).name === 'magpie';
  } catch { return false; }
}

function cookie(m: MagpieMeta): string {
  return 'magpie_web_' + m.adminPort + '=' + m.adminKey;
}

async function adminReady(m: MagpieMeta): Promise<boolean> {
  try {
    const response = await fetch('http://127.0.0.1:' + m.adminPort + '/api/groups', {
      headers: { Cookie: cookie(m), Accept: 'application/json' },
      signal: AbortSignal.timeout(1500), redirect: 'error'
    });
    return response.ok && (response.headers.get('content-type') ?? '').includes('json');
  } catch { return false; }
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new MagpieHostError('magpie_http_' + response.status);
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new MagpieHostError('magpie_response_too_large');
  const reader = response.body?.getReader();
  if (!reader) throw new MagpieHostError('magpie_empty_response');
  let total = 0;
  const chunks: Buffer[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new MagpieHostError('magpie_response_too_large');
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new MagpieHostError('magpie_invalid_json'); }
}

// Fixed allowlists: requests cannot be used as a proxy to arbitrary internal or model endpoints.
// API Key, account login details, recent prompts and vendor responses are never returned to the UI.
const READ_ALIASES = new Map<string, string>([
  ['models', '/v1/models'], ['providers', '/api/providers'], ['groups', '/api/groups'],
  ['plugins', '/api/plugins'], ['usage', '/v1/magpie/usage'],
  ['quota-cards', '/v1/magpie/quotas/cards'], ['agents', '/api/agents/cli'],
  ['quotas', '/api/usage/quotas'], ['plugin-updates', '/api/plugins/updates']
]);
const POST_ALIASES = new Map<string, string>([
  ['refresh-quotas', '/api/usage/quotas?asked=1&all=1'],
  ['plugin-check', '/api/plugins/check'],
  ['plugin-update', '/api/plugins/update'],
  ['plugin-add', '/api/plugins/add'],
  ['plugin-toggle', '/api/plugins/off'],
  ['workbuddy-checkin', '/api/usage/workbuddy-checkin']
]);

export function magpieActionRisk(alias: string): 'medium' | 'high' {
  if (!POST_ALIASES.has(alias)) throw new MagpieHostError('unsupported_magpie_path');
  return alias === 'plugin-add' || alias === 'plugin-update' || alias === 'plugin-toggle' || alias === 'workbuddy-checkin'
    ? 'high' : 'medium';
}

export function validateMagpieAction(alias: string, body: unknown): Record<string, unknown> {
  if (!POST_ALIASES.has(alias)) throw new MagpieHostError('unsupported_magpie_path');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new MagpieHostError('invalid_magpie_action_body');
  const input = body as Record<string, unknown>;
  if (alias === 'plugin-add') {
    if (!safeNpmPluginSpec(input.spec) || Object.keys(input).length !== 1) throw new MagpieHostError('invalid_magpie_action_body');
    return { spec: input.spec };
  }
  if (alias === 'plugin-toggle') {
    if (!safeNpmPluginSpec(input.spec) || typeof input.off !== 'boolean' || Object.keys(input).length !== 2) {
      throw new MagpieHostError('invalid_magpie_action_body');
    }
    return { spec: input.spec, off: input.off };
  }
  if (Object.keys(input).length > 0) throw new MagpieHostError('invalid_magpie_action_body');
  return {};
}

export function summarizeMagpieCheckin(raw: unknown): Pick<MagpieActionView, 'completed' | 'result' | 'checkin'> {
  if (!Array.isArray(raw)) throw new MagpieHostError('magpie_invalid_checkin_result');
  const summary = { total: raw.length, claimed: 0, already: 0, captcha: 0, failed: 0, other: 0, creditsReported: 0 };
  for (const item of raw) {
    const entry = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const outcome = entry.outcome;
    if (outcome === 'claimed') {
      summary.claimed++;
      if (typeof entry.credit === 'number' && Number.isFinite(entry.credit) && entry.credit >= 0) {
        summary.creditsReported += Math.min(entry.credit, 100_000_000);
      }
    } else if (outcome === 'done') summary.already++;
    else if (outcome === 'captcha' || outcome === 'own-app') summary.captcha++;
    else if (outcome === 'failed') summary.failed++;
    else summary.other++;
  }
  const problematic = summary.failed + summary.captcha + summary.other;
  const result = summary.total === 0 ? 'no_accounts' :
    problematic === 0 ? 'succeeded' :
    summary.failed === summary.total ? 'failed' :
    problematic === summary.total ? 'needs_attention' : 'partial';
  return { completed: result === 'succeeded' || result === 'no_accounts', result, checkin: summary };
}

export interface MagpiePinnedScopeProbe {
  readonly verified: boolean;
  readonly keyRevoked: boolean;
  readonly reason: string;
}
export interface MagpiePinnedBinding {
  readonly instanceId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly accountRef: string;
  readonly accountKind?: 'api-key' | 'codex-subscription';
}
function supportsDamingTaskScope(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.schemaVersion === 1 && v.fixedAccount === true &&
    v.singleUpstream === true && v.revokedLocalKeyFailsClosed === true;
}

export interface MagpieHost {
  ensure(): Promise<MagpieStatusView>;
  status(): Promise<MagpieStatusView>;
  read(alias: string): Promise<MagpieReadView>;
  routingCatalog?(): Promise<MagpieRoutingCatalog>;
  /** Native Magpie models + subscription-backed Agents + route groups. Read only. */
  unifiedTargets?(): Promise<MagpieUnifiedCatalog>;
  provePinnedCredential?(binding: CredentialBinding, provider: ProviderKind, secret: string): Promise<boolean>;
  scopeCapability?(): Promise<boolean>;
  /** Private stable account binding from Magpie's native picker, not API-key discovery. */
  codexSubscriptionBinding?(modelId: string): Promise<MagpiePinnedBinding>;
  /** Explicit non-inference probe: temporary pinned key, inspect scope, revoke. */
  probePinnedScope?(binding: MagpiePinnedBinding): Promise<MagpiePinnedScopeProbe>;
  /** Trusted Host only; does NOT grant paid dispatch or reconcile cash. */
  withPinnedModel?<T>(binding: MagpiePinnedBinding, use: (send: CodexModelForward) => Promise<T>,
    authorizeForward?: MagpieForwardAuthorization, wire?: MagpieProjectWire): Promise<T>;
  post(alias: string, body?: unknown): Promise<MagpieActionView>;
  stop(): void;
}

export function createMagpieHost(options: {
  readonly dataDir?: string; readonly port?: number; readonly adminPort?: number; readonly binary?: string;
  readonly profile?: 'default' | 'selected' | 'environment';
} = {}): MagpieHost {
  const root = resolve(options.dataDir ?? process.env.DAMING_DATA_DIR ??
    join(process.env.LOCALAPPDATA ?? '.', 'Daming', 'magpie-headless'));
  const dirs = privateDirs(root);
  const binary = options.binary ? resolve(options.binary) : BINARY;
  const port = options.port ?? DEFAULT_PORT;
  const adminPort = options.adminPort ?? port + 1;
  if (!validPort(port) || !validPort(adminPort) || port === adminPort) throw new MagpieHostError('invalid_magpie_ports');
  let childPid: number | undefined;
  let actionInFlight = false;

  const view = (m: MagpieMeta, running: boolean, configured: boolean, reason?: string): MagpieStatusView => ({
    enabled: existsSync(binary), running, configured, version: 'v1',
    port: m.port, adminPort: m.adminPort, instanceId: m.instanceId,
    profile: options.profile ?? 'default',
    ...(m.migratedFrom ? { migratedFrom: m.migratedFrom } : {}),
    checkedAt: new Date().toISOString(), ...(reason ? { reason } : {})
  });

  async function request(m: MagpieMeta, method: 'GET' | 'POST' | 'DELETE', path: string, body?: object): Promise<unknown> {
    const isGateway = path.startsWith('/v1/');
    if (isGateway ? !await gatewayReady(m.port) : !await adminReady(m)) throw new MagpieHostError('magpie_not_ready');
    // Credential issuance rejects browser Fetch Metadata. Use native Host HTTP
    // only for this fixed endpoint; never relax Magpie's browser-origin guard.
    if (path === '/v1/magpie/keys' || /^\/v1\/magpie\/keys\/[A-Za-z0-9_-]{10,80}$/.test(path)) {
      const payload = method === 'POST' ? JSON.stringify(body ?? {}) : undefined;
      return new Promise((resolveResult, reject) => {
        const req = nativeHttpRequest({ hostname: '127.0.0.1', port: m.port, path, method,
          headers: { Accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) }
        }, res => {
          const chunks: Buffer[] = []; let bytes = 0;
          res.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > MAX_RESPONSE_BYTES) req.destroy(new MagpieHostError('magpie_response_too_large'));
            else chunks.push(chunk);
          });
          res.on('error', () => reject(new MagpieHostError('magpie_key_response_failed')));
          res.on('end', () => {
            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) return reject(new MagpieHostError('magpie_http_' + res.statusCode));
            try { resolveResult(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch { reject(new MagpieHostError('magpie_invalid_json')); }
          });
        });
        const deadline = setTimeout(() => req.destroy(new MagpieHostError('magpie_key_request_timeout')), 15000);
        req.once('close', () => clearTimeout(deadline));
        req.on('error', () => reject(new MagpieHostError('magpie_key_request_failed')));
        req.end(payload);
      });
    }
    const response = await fetch('http://127.0.0.1:' + (isGateway ? m.port : m.adminPort) + path, {
      method, headers: {
        Cookie: cookie(m), Accept: 'application/json',
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {})
      },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
      signal: AbortSignal.timeout(method === 'POST' ? 330000 : 15000),
      redirect: 'error'
    });
    return await boundedJson(response);
  }

  async function assertPinnedCurrent(m: MagpieMeta, binding: MagpiePinnedBinding): Promise<void> {
    if (!validPinnedMagpieBinding(binding)) throw new MagpieHostError('pinned_route_invalid');
    if (binding.accountKind === 'codex-subscription') {
      const current = selectCodexSubscriptionBinding(await request(m, 'GET', '/api/caller-keys/models'), m.instanceId, binding.modelId);
      if (current.accountRef !== binding.accountRef) throw new MagpieHostError('magpie_codex_route_changed');
    } else {
      const catalog = projectMagpieRoutingCatalog(await request(m, 'GET', '/api/providers'), m.instanceId, m.adminKey);
      if (!catalog.candidates.some(c => c.providerId === binding.providerId && c.modelId === binding.modelId && c.accountRef === binding.accountRef)) {
        throw new MagpieHostError('magpie_codex_route_changed');
      }
    }
  }

  return {
    async ensure() {
      const newDataDir = !existsSync(dirs.base);
      mkdirSync(dirs.base, { recursive: true });
      if (newDataDir) secureNewWindowsDirectory(dirs.base);
      for (const dir of [dirs.config, dirs.cache, dirs.state, dirs.local, dirs.appdata]) {
        mkdirSync(dir, { recursive: true });
      }
      if (!existsSync(binary)) return {
        enabled: false, running: false, configured: false, version: 'v1',
        checkedAt: new Date().toISOString(), reason: 'binary_missing'
      };
      let m = readMeta(dirs);
      if (!m && existsSync(metaPath(dirs))) {
        const legacy = inspectLegacyMagpieMeta(dirs.base);
        const migrationAdminPort = options.adminPort ?? (legacy ? legacy.port + 1 : adminPort);
        if (!legacy || !validPort(migrationAdminPort) || migrationAdminPort === legacy.port) return {
          enabled: true, running: false, configured: false, version: 'v1',
          checkedAt: new Date().toISOString(), reason: 'unmanaged_instance_requires_manual_restart'
        };
        if (await portOccupied(legacy.port) || await portOccupied(migrationAdminPort)) return {
          enabled: true, running: await gatewayReady(legacy.port), configured: false,
          version: 'v1', port: legacy.port, checkedAt: new Date().toISOString(),
          reason: 'legacy_ports_in_use'
        };
        try {
          migrateLegacyMagpieMeta(dirs.base, migrationAdminPort);
          m = readMeta(dirs);
        } catch {
          return { enabled: true, running: false, configured: false, version: 'v1',
            checkedAt: new Date().toISOString(), reason: 'legacy_migration_failed' };
        }
      }
      if (!m) {
        if (await portOccupied(port) || await portOccupied(adminPort)) return {
          enabled: true, running: false, configured: false,
          version: 'v1', checkedAt: new Date().toISOString(), reason: 'ports_in_use'
        };
        m = writeMeta(dirs, port, adminPort);
      }
      if (await gatewayReady(m.port)) {
        const ready = await adminReady(m);
        return view(m, true, ready, ready ? undefined : 'admin_unavailable');
      }
      // Never launch over an unrelated listener or an orphaned admin process.
      if (await portOccupied(m.port) || await portOccupied(m.adminPort)) {
        return view(m, false, false, 'ports_in_use');
      }
      const output = openSync(join(dirs.base, 'magpie.log'), 'a');
      try {
        const child = spawn(binary, ['serve', '--web=127.0.0.1:' + m.adminPort], {
          cwd: dirs.base,
          env: envFor(dirs, m.port, { MAGPIE_WEB_KEY: m.adminKey, DAMING_MAGPIE_INSTANCE: m.instanceId }),
          shell: false, windowsHide: true, stdio: ['ignore', output, output]
        });
        child.once('error', () => undefined);
        child.unref();
        childPid = child.pid;
      } finally { closeSync(output); }
      for (let i = 0; i < 40; i++) {
        if (await gatewayReady(m.port) && await adminReady(m)) return view(m, true, true);
        await new Promise((r) => setTimeout(r, 300));
      }
      const running = await gatewayReady(m.port);
      return view(m, running, false, running ? 'admin_unavailable' : 'startup_timeout');
    },
    async status() {
      const m = readMeta(dirs);
      if (!m) return {
        enabled: existsSync(binary), running: false, configured: false, version: 'v1',
        checkedAt: new Date().toISOString(),
        reason: existsSync(metaPath(dirs)) ? 'unmanaged_instance_requires_manual_restart' : 'not_started'
      };
      const running = await gatewayReady(m.port);
      const ready = running && await adminReady(m);
      return view(m, running, ready, !running ? 'unreachable' : ready ? undefined : 'admin_unavailable');
    },
    async read(alias) {
      const path = READ_ALIASES.get(alias);
      if (!path) throw new MagpieHostError('unsupported_magpie_path');
      const m = readMeta(dirs);
      if (!m) throw new MagpieHostError('magpie_not_ready');
      return summarizeMagpieRead(alias, await request(m, 'GET', path));
    },
    async provePinnedCredential(binding, provider, secret) {
      const m = readMeta(dirs);
      if (!m || m.instanceId !== binding.instanceId) return false;
      return proveExactMagpieCredential(dirs.config, binding, provider, secret);
    },
    async unifiedTargets() {
      const m = readMeta(dirs);
      if (!m) throw new MagpieHostError('magpie_not_ready');
      // Fetch the same effective catalog the Magpie Routing UI uses. No user
      // secrets, raw accounts or provider credentials leave this Host.
      return projectMagpieUnifiedTargets(await request(m, 'GET', '/api/groups'));
    },
    async routingCatalog() {
      const m = readMeta(dirs);
      if (!m) throw new MagpieHostError('magpie_not_ready');
      return projectMagpieRoutingCatalog(await request(m, 'GET', '/api/providers'), m.instanceId, m.adminKey);
    },
    async scopeCapability() {
      const m = readMeta(dirs);
      if (!m) return false;
      try {
        return supportsDamingTaskScope(await request(m, 'GET', '/v1/magpie/daming-task-scope'));
      } catch { return false; }
    },
    async codexSubscriptionBinding(modelId) {
      const m = readMeta(dirs);
      if (!m) throw new MagpieHostError('magpie_not_ready');
      const capability = await request(m, 'GET', '/v1/magpie/daming-task-scope');
      if (!supportsDamingTaskScope(capability) ||
          (capability as Record<string, unknown>).codexPersonalLoginReadOnly !== true) {
        throw new MagpieHostError('magpie_scope_binary_outdated');
      }
      return selectCodexSubscriptionBinding(await request(m, 'GET', '/api/caller-keys/models'), m.instanceId, modelId);
    },
    async probePinnedScope(binding) {
      const m = readMeta(dirs);
      if (!m || binding.instanceId !== m.instanceId || !validPinnedMagpieBinding(binding)) {
        return { verified: false, keyRevoked: false, reason: 'pinned_route_invalid' };
      }
      // A source rebuild without the matching deployed binary MUST NOT issue
      // temporary credentials against an older local-auth implementation.
      try {
        const capability = await request(m, 'GET', '/v1/magpie/daming-task-scope');
        if (!supportsDamingTaskScope(capability) || binding.accountKind === 'codex-subscription' &&
            (capability as Record<string, unknown>).codexPersonalLoginReadOnly !== true) {
          return { verified: false, keyRevoked: false, reason: 'magpie_scope_binary_outdated' };
        }
      } catch {
        return { verified: false, keyRevoked: false, reason: 'magpie_scope_binary_outdated' };
      }
      // Re-read the live provider and key before generating any credential.
      try {
        await assertPinnedCurrent(m, binding);
      } catch {
        return { verified: false, keyRevoked: false, reason: 'pinned_route_unavailable' };
      }
      let issuedId: string | undefined;
      let verified = false;
      let reason = 'pinned_probe_failed';
      let keyRevoked = false;
      try {
        // The scoped key is NEVER used to generate text in this probe.
        // A 1-minute expiry is the crash/revocation safety net.
        const raw = await request(m, 'POST', '/v1/magpie/keys', {
          name: 'daming-scope-probe', ttl: '1m',
          models: [binding.providerId + '/' + binding.modelId],
          accounts: [binding.providerId + '/' + binding.accountRef],
          tokens: 1, cost: 0, readOnly: true, singleUpstream: true
        });
        const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
        if (typeof value.id === 'string' && /^[a-zA-Z0-9_-]{10,80}$/.test(value.id)) issuedId = value.id;
        if (!issuedId ||
            typeof value.key !== 'string' || !/^sk-magpie-key-[A-Za-z0-9_-]+$/.test(value.key) ||
            !Array.isArray(value.models) || value.models.length !== 1 ||
            value.models[0] !== binding.providerId + '/' + binding.modelId ||
            !Array.isArray(value.accounts) || value.accounts.length !== 1 ||
            value.accounts[0] !== binding.providerId + '/' + binding.accountRef ||
            value.readOnly !== true || value.singleUpstream !== true ||
            typeof value.expires !== 'string' || Number.isNaN(Date.parse(value.expires)) ||
            Date.parse(value.expires) > Date.now() + 65000) {
          reason = 'pinned_key_scope_mismatch';
        } else {
          const response = await fetch('http://127.0.0.1:' + m.port + '/v1/models', {
            headers: { Authorization: 'Bearer ' + value.key, Accept: 'application/json' },
            signal: AbortSignal.timeout(10000), redirect: 'error'
          });
          const models = await boundedJson(response) as Record<string, unknown>;
          const rows = Array.isArray(models?.data) ? models.data : [];
          const ids = rows.map((row) => row && typeof row === 'object' ? (row as Record<string, unknown>).id : null);
          if (ids.includes(binding.providerId + '/' + binding.modelId) &&
              ids.every((model) => model === binding.providerId + '/' + binding.modelId)) {
            verified = true;
            reason = 'pinned_scope_verified_no_inference';
          } else reason = 'pinned_model_visibility_mismatch';
        }
      } catch {
        reason = 'pinned_scope_check_unavailable';
      } finally {
        if (issuedId) {
          try {
            await request(m, 'DELETE', '/v1/magpie/keys/' + issuedId);
            keyRevoked = true;
          } catch {
            reason = 'pinned_key_revocation_uncertain';
          }
        }
      }
      return { verified: verified && keyRevoked, keyRevoked, reason };
    },
    async withPinnedModel(binding, use, authorizeForward, wire = 'responses_http') {
      if (wire !== 'responses_http' && (wire !== 'messages_http' || !authorizeForward)) {
        throw new MagpieHostError('magpie_project_wire_denied');
      }
      const messages = wire === 'messages_http';
      const m = readMeta(dirs);
      if (!m || m.instanceId !== binding.instanceId) throw new MagpieHostError('magpie_codex_instance_changed');
      const frozen = { ...binding };
      return withPinnedMagpieTurn({
        binding: frozen,
        async checkCurrent() {
          const currentMeta = readMeta(dirs);
          if (!currentMeta || currentMeta.instanceId !== m.instanceId || currentMeta.port !== m.port ||
              currentMeta.adminPort !== m.adminPort || currentMeta.adminKey !== m.adminKey) {
            throw new MagpieHostError('magpie_codex_instance_changed');
          }
          const capability = await request(m, 'GET', '/v1/magpie/daming-task-scope');
          if (!supportsDamingTaskScope(capability) || frozen.accountKind === 'codex-subscription' &&
              (capability as Record<string, unknown>).codexPersonalLoginReadOnly !== true) {
            throw new MagpieHostError('magpie_scope_binary_outdated');
          }
          if (authorizeForward && (capability as Record<string, unknown>).strictWireSingleUpstreamHTTP !== true) {
            throw new MagpieHostError('magpie_project_scope_binary_outdated');
          }
          await assertPinnedCurrent(m, frozen);
        },
        ...(authorizeForward ? { authorizeForward } : {}),
        request: (method, path, body) => request(m, method, path, body),
        forward: (key, body, signal) => fetch('http://127.0.0.1:' + m.port + (messages ? '/v1/messages' : '/v1/responses'), {
          method: 'POST', redirect: 'error', signal,
          headers: {
            Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Accept: 'text/event-stream',
            ...(messages ? { 'anthropic-version': '2023-06-01' } : {}),
          }, body
        })
      }, use);
    },
    async post(alias, body) {
      const path = POST_ALIASES.get(alias);
      const payload = validateMagpieAction(alias, body);
      if (!path) throw new MagpieHostError('unsupported_magpie_path');
      const m = readMeta(dirs);
      if (!m) throw new MagpieHostError('magpie_not_ready');
      if (actionInFlight) throw new MagpieHostError('magpie_action_in_progress');
      actionInFlight = true;
      try {
        if (alias === 'plugin-toggle') {
          const plugins = await request(m, 'GET', '/api/plugins') as { plugins?: unknown };
          if (!Array.isArray(plugins?.plugins) || !plugins.plugins.some(
            (row: unknown) => !!row && typeof row === 'object' && (row as Record<string, unknown>).spec === payload.spec
          )) throw new MagpieHostError('magpie_plugin_not_installed');
        }
        const response = alias === 'refresh-quotas' ? await request(m, 'GET', path) : await request(m, 'POST', path, payload);
        return {
          action: alias, checkedAt: new Date().toISOString(),
          ...(alias === 'workbuddy-checkin' ? summarizeMagpieCheckin(response) : { completed: true, result: 'succeeded' as const })
        };
      } finally {
        actionInFlight = false;
      }
    },
    stop() {
      if (!childPid) return;
      try { process.kill(childPid); } catch { /* already gone */ }
      childPid = undefined;
    }
  };
}
