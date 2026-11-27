import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Read-only projection of the user's existing Magpie inventory into Daming.
 * Never returns secrets: accounts expose only provider, account label, type and token presence.
 */
export interface MagpieProviderView {
  readonly id: string;
  readonly name: string;
  readonly models: readonly string[];
  readonly accountCount: number;
  readonly accountLabels: readonly string[];
  readonly kind: 'native' | 'plugin';
}
export interface MagpieAccountView {
  readonly provider: string;
  readonly id: string;
  readonly accountId?: string;
  readonly type?: string;
  readonly expiresAt?: number;
  readonly hasAccess: boolean;
  readonly hasRefresh: boolean;
  readonly detail?: string;
}
export interface MagpieAgentView {
  readonly id: string;
  readonly name: string;
  readonly detected: boolean;
  readonly supported: boolean;
  readonly detail: string;
}
export interface MagpieInventoryView {
  readonly providers: readonly MagpieProviderView[];
  readonly accounts: readonly MagpieAccountView[];
  readonly agents: readonly MagpieAgentView[];
  readonly checkedAt: string;
}

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}
function str(value: unknown): string | undefined { return typeof value === 'string' && value ? value : undefined; }
function num(value: unknown): number | undefined { return typeof value === 'number' ? value : undefined; }

export function defaultMagpieDir(): string {
  // The Daming-hosted engine runs with XDG_CONFIG_HOME=<dataDir>/config, so it reads
  // <dataDir>/config/magpie — that copy is what the live gateway actually honours.
  // Prefer it when present; otherwise fall back to the user's ~/.config/magpie.
  const instanceDir = join(process.env.LOCALAPPDATA || '', 'Daming', 'magpie-headless', 'config', 'magpie');
  if (existsSync(instanceDir)) return instanceDir;
  return join(process.env.USERPROFILE || process.env.HOME || '', '.config', 'magpie');
}

interface ScannedAccounts { accounts: MagpieAccountView[]; authCounts: Map<string, number> }
function normProvider(value: unknown): string {
  return String(value ?? 'unknown').replace(/^plugin:/, '');
}

function scanAccounts(dir: string): ScannedAccounts {
  // logins.json is the authoritative *account list* (it carries the user label and
  // the OAuth token pair). plugin-auth.json is the per-plugin credential store that
  // mirrors those same logins — treating both as independent accounts double-counts
  // (e.g. workbuddy 3 real accounts were shown as 6). So we count logins first and
  // only fall back to plugin-auth for a provider that has no login entry at all.
  const accounts: MagpieAccountView[] = [];
  const loginCounts = new Map<string, number>();
  const logins = readJson(join(dir, 'logins.json'));
  if (Array.isArray(logins)) {
    for (const raw of logins as Array<Record<string, unknown>>) {
      const tokens = ((raw?.auth as Record<string, unknown>)?.tokens ?? {}) as Record<string, unknown>;
      const provider = normProvider(raw?.agent);
      accounts.push({
        provider, id: String(raw?.id ?? provider),
        ...(str(tokens.account_id) ? { accountId: str(tokens.account_id) } : {}),
        type: 'oauth',
        ...(num(tokens.expires_at) !== undefined ? { expiresAt: num(tokens.expires_at) } : {}),
        hasAccess: Boolean(str(tokens.access_token)), hasRefresh: Boolean(str(tokens.refresh_token)),
        ...(str(raw?.user) ? { detail: String(raw.user) } : {})
      });
      loginCounts.set(provider, (loginCounts.get(provider) ?? 0) + 1);
    }
  }
  const authCounts = new Map<string, number>();
  const pluginAuth = readJson(join(dir, 'plugin-auth.json'));
  if (pluginAuth && typeof pluginAuth === 'object') {
    for (const [key, value] of Object.entries(pluginAuth as Record<string, unknown>)) {
      const record = (value ?? {}) as Record<string, unknown>;
      const provider = key.split('#')[0];
      authCounts.set(provider, (authCounts.get(provider) ?? 0) + 1);
      // Only synthesize an account when this provider is not already covered by logins.json.
      if ((loginCounts.get(provider) ?? 0) > 0) continue;
      accounts.push({
        provider, id: key,
        ...(str(record.accountId) ?? str(record.uid) ? { accountId: str(record.accountId) ?? str(record.uid) } : {}),
        ...(str(record.type) ? { type: str(record.type) } : {}),
        ...(num(record.expires) !== undefined ? { expiresAt: num(record.expires) } : {}),
        hasAccess: Boolean(str(record.access)), hasRefresh: Boolean(str(record.refresh)),
        ...(str(record.name) ? { detail: String(record.name) } : {})
      });
    }
  }
  // If plugin-auth shows MORE distinct credentials for a provider than logins lists,
  // surface the surplus so the count still reflects every usable credential.
  for (const [provider, authCount] of authCounts) {
    const loginCount = loginCounts.get(provider) ?? 0;
    for (let i = loginCount; i < authCount; i += 1) {
      accounts.push({ provider, id: `${provider}#extra-${i}`, type: 'plugin', hasAccess: true, hasRefresh: false });
    }
  }
  return { accounts, authCounts };
}

function scanProviders(dir: string, accounts: readonly MagpieAccountView[]): MagpieProviderView[] {
  const providers = new Map<string, { id: string; name: string; models: string[]; kind: 'native' | 'plugin' }>();
  const native = readJson(join(dir, 'providers.json'));
  if (native && typeof native === 'object' && Array.isArray((native as { providers?: unknown }).providers)) {
    for (const raw of (native as { providers: Array<Record<string, unknown>> }).providers) {
      const id = str(raw.id);
      if (!id) continue;
      providers.set(id, {
        id, name: str(raw.name) || id,
        models: Array.isArray(raw.models) ? raw.models.map((model) => String(model)) : [],
        kind: 'native'
      });
    }
  }
  const plugin = readJson(join(dir, 'plugin-providers.json'));
  if (Array.isArray(plugin)) {
    for (const raw of plugin as Array<Record<string, unknown>>) {
      const id = str(raw.id);
      if (!id) continue;
      const existing = providers.get(id);
      providers.set(id, {
        id, name: existing?.name || str(raw.name) || id,
        models: existing?.models ?? [],
        kind: 'plugin'
      });
    }
  }
  for (const account of accounts) {
    const id = account.provider.replace(/^plugin:/, '');
    if (!providers.has(id)) providers.set(id, { id, name: id, models: [], kind: account.provider.startsWith('plugin:') ? 'plugin' : 'native' });
  }
  return [...providers.values()].map((provider) => {
    const related = accounts.filter((account) => account.provider.replace(/^plugin:/, '') === provider.id);
    return {
      ...provider,
      accountCount: related.length,
      accountLabels: [...new Set(related.map((account) => account.detail || account.accountId || account.id))]
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function scanAgents(dir: string): MagpieAgentView[] {
  const stash = readJson(join(dir, 'stash.json'));
  const keys = stash && typeof stash === 'object' ? Object.keys(stash as Record<string, unknown>) : [];
  const has = (prefix: string) => keys.some((key) => key === prefix || key.startsWith(prefix + '.') || key.startsWith(prefix + ':'));
  const agents: MagpieAgentView[] = [
    { id: 'dsh', name: 'DeepSeek Harness', detected: has('dsh') || existsSync('D:/dsh/DeepSeek Harness.exe'), supported: true, detail: 'DSH · ACP' },
    { id: 'codex', name: 'Codex', detected: has('codex') || existsSync(join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin')), supported: true, detail: 'Codex CLI / app-server' },
    { id: 'claude-code', name: 'Claude Code', detected: has('claude') || existsSync(join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')), supported: true, detail: 'Claude Code CLI' }
  ];
  return agents;
}

export function scanMagpieInventory(magpieDir = defaultMagpieDir()): MagpieInventoryView {
  const { accounts } = scanAccounts(magpieDir);
  return {
    providers: scanProviders(magpieDir, accounts),
    accounts,
    agents: scanAgents(magpieDir),
    checkedAt: new Date().toISOString()
  };
}
