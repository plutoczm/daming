import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Daming account inventory — ported from Magpie's account scanning (logins.json + plugin-auth.json). */
export interface AccountEntry {
  provider: string; id: string; accountId?: string; type?: string;
  expiresAt?: number; hasAccess: boolean; hasRefresh: boolean; detail?: string;
}
export interface ScanResult { accounts: AccountEntry[]; errors: string[] }
export interface ScanOptions { magpieDir?: string; loginsPath?: string; pluginAuthPath?: string }

export function defaultMagpieConfigDir(): string {
  return join(process.env.USERPROFILE || process.env.HOME || '', '.config', 'magpie');
}
function readJson(p: string): unknown {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return undefined; }
}
function num(v: unknown): number | undefined { return typeof v === 'number' ? v : undefined; }
function str(v: unknown): string | undefined { return typeof v === 'string' && v ? v : undefined; }

/** Enumerate accounts from Magpie's logins.json (agent OAuth logins) and plugin-auth.json (plugin OAuth creds). */
export function scanAccounts(opts: ScanOptions = {}): ScanResult {
  const dir = opts.magpieDir || defaultMagpieConfigDir();
  const loginsPath = opts.loginsPath || join(dir, 'logins.json');
  const pluginAuthPath = opts.pluginAuthPath || join(dir, 'plugin-auth.json');
  const accounts: AccountEntry[] = []; const errors: string[] = [];

  const logins = readJson(loginsPath);
  if (Array.isArray(logins)) {
    for (const raw of logins as Array<Record<string, unknown>>) {
      const t = ((raw?.auth as Record<string, unknown>)?.tokens ?? {}) as Record<string, unknown>;
      const agent = String(raw?.agent ?? 'unknown');
      accounts.push({ provider: agent, id: agent, ...(str(t.account_id) ? { accountId: str(t.account_id) } : {}), type: 'oauth', ...(num(t.expires_at) !== undefined ? { expiresAt: num(t.expires_at) } : {}), hasAccess: Boolean(str(t.access_token)), hasRefresh: Boolean(str(t.refresh_token)) });
    }
  } else if (logins !== undefined) errors.push('logins_not_array');

  const pa = readJson(pluginAuthPath);
  if (pa && typeof pa === 'object') {
    for (const [key, v] of Object.entries(pa as Record<string, unknown>)) {
      const rec = (v ?? {}) as Record<string, unknown>;
      const provider = key.split('#')[0];
      const parts: string[] = [];
      if (str(rec.domain)) parts.push('domain=' + rec.domain);
      if (str(rec.profileArn)) parts.push('profileArn');
      if (str(rec.region)) parts.push('region=' + rec.region);
      accounts.push({ provider, id: key, ...(str(rec.accountId) ?? str(rec.uid) ? { accountId: str(rec.accountId) ?? str(rec.uid) } : {}), ...(str(rec.type) ? { type: str(rec.type) } : {}), ...(num(rec.expires) !== undefined ? { expiresAt: num(rec.expires) } : {}), hasAccess: Boolean(str(rec.access)), hasRefresh: Boolean(str(rec.refresh)), ...(parts.length ? { detail: parts.join(' ') } : {}) });
    }
  } else if (pa !== undefined) errors.push('plugin_auth_not_object');

  return { accounts, errors };
}
