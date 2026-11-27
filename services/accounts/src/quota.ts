import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultMagpieConfigDir } from './inventory.ts';
import { WorkBuddyPlatform } from '../../checkin-agent/src/workbuddy.ts';

/** Quota read across providers (ported from Magpie's quota refresh). */
export interface QuotaEntry { provider: string; id: string; remainingMinor?: number; unit?: string; unknown?: boolean; error?: string }
export interface QuotaOptions { magpieDir?: string; pluginAuthPath?: string }

function readJson(p: string): unknown { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return undefined; } }

export async function readQuotas(opts: QuotaOptions = {}): Promise<QuotaEntry[]> {
  const dir = opts.magpieDir || defaultMagpieConfigDir();
  const pa = readJson(opts.pluginAuthPath || join(dir, 'plugin-auth.json'));
  const out: QuotaEntry[] = [];
  if (pa && typeof pa === 'object') {
    for (const [key, v] of Object.entries(pa as Record<string, unknown>)) {
      const provider = key.split('#')[0];
      const rec = (v ?? {}) as Record<string, unknown>;
      if (provider !== 'workbuddy' || typeof rec.access !== 'string' || !rec.access) { out.push({ provider, id: key, unknown: true }); continue; }
      try {
        const q = await new WorkBuddyPlatform().readQuota({ accountId: key, platform: 'workbuddy', owner: '', secret: JSON.stringify(rec) });
        if (typeof q.remainingMinor === 'number') out.push({ provider, id: key, remainingMinor: q.remainingMinor, ...(q.unit ? { unit: q.unit } : {}) });
        else out.push({ provider, id: key, unknown: true });
      } catch (e) { out.push({ provider, id: key, unknown: true, error: e instanceof Error ? e.message.slice(0, 80) : String(e) }); }
    }
  }
  return out;
}
