import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DeepSeekBalanceView } from '@daming/contracts';

const ENDPOINT = 'https://api.deepseek.com/user/balance';

/**
 * Resolve the DeepSeek API key. The managed Host process is spawned with a
 * minimal env whitelist that does not carry secrets, so besides the normal
 * DEEPSEEK_API_KEY env var we also accept a key file: the explicit
 * DEEPSEEK_API_KEY_FILE, or `%LOCALAPPDATA%\Daming\deepseek.key` (LOCALAPPDATA
 * is on the whitelist). The file's first non-empty line is used.
 */
function resolveApiKey(env: Record<string, string | undefined>): string | undefined {
  const direct = env.DEEPSEEK_API_KEY?.trim();
  if (direct) return direct;
  const candidates: string[] = [];
  const explicit = env.DEEPSEEK_API_KEY_FILE?.trim();
  if (explicit) candidates.push(explicit);
  const local = env.LOCALAPPDATA?.trim();
  if (local) candidates.push(join(local, 'Daming', 'deepseek.key'));
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue;
      const value = readFileSync(file, 'utf8').split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
      if (value && value.startsWith('sk-')) return value;
    } catch { /* ignore unreadable key file */ }
  }
  return undefined;
}

export interface DeepSeekBalanceSnapshot {
  readonly currency: string;
  readonly totalMinor: number;
}

export interface DeepSeekBalanceService {
  readonly configured: boolean;
  query(): Promise<DeepSeekBalanceView>;
  snapshot(): Promise<DeepSeekBalanceSnapshot | undefined>;
}

interface BalanceInfo {
  readonly currency: string;
  readonly totalMinor: number;
  readonly grantedMinor: number;
  readonly toppedUpMinor: number;
}

function decimalToMinor(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value)) return undefined;
  const [whole, fraction = ''] = value.split('.');
  const minor = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  return Number.isSafeInteger(minor) ? minor : undefined;
}

function readInfo(value: unknown): BalanceInfo | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.currency !== 'string') return undefined;
  const totalMinor = decimalToMinor(record.total_balance);
  if (totalMinor === undefined) return undefined;
  return {
    currency: record.currency,
    totalMinor,
    grantedMinor: decimalToMinor(record.granted_balance) ?? 0,
    toppedUpMinor: decimalToMinor(record.topped_up_balance) ?? 0
  };
}

export function createDeepSeekBalanceService(
  env: Record<string, string | undefined> = process.env,
  options: { readonly fetchImpl?: typeof fetch; readonly now?: () => number } = {}
): DeepSeekBalanceService {
  const apiKey = resolveApiKey(env);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  if (!apiKey) {
    return {
      configured: false,
      async query() {
        return { configured: false, available: false, currency: null, totalMinor: null, grantedMinor: null, toppedUpMinor: null, checkedAt: new Date(now()).toISOString(), reason: 'not_configured' };
      },
      async snapshot() { return undefined; }
    };
  }

  async function read(): Promise<{ readonly info?: BalanceInfo; readonly available: boolean; readonly reason?: string }> {
    try {
      const response = await fetchImpl(ENDPOINT, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
        redirect: 'error',
        signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) return { available: false, reason: `http_${response.status}` };
      const body = await response.json() as Record<string, unknown>;
      const infos = Array.isArray(body.balance_infos) ? body.balance_infos.map(readInfo).filter((item): item is BalanceInfo => item !== undefined) : [];
      const info = infos.find((item) => item.currency === 'CNY') ?? infos[0];
      if (!info) return { available: false, reason: 'invalid_response' };
      return { info, available: body.is_available === true };
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      return { available: false, reason: timedOut ? 'timeout' : 'unreachable' };
    }
  }

  return {
    configured: true,
    async query() {
      const result = await read();
      return {
        configured: true,
        available: result.info !== undefined && result.available,
        currency: result.info?.currency ?? null,
        totalMinor: result.info?.totalMinor ?? null,
        grantedMinor: result.info?.grantedMinor ?? null,
        toppedUpMinor: result.info?.toppedUpMinor ?? null,
        checkedAt: new Date(now()).toISOString(),
        ...(result.reason ? { reason: result.reason } : {})
      };
    },
    async snapshot() {
      const result = await read();
      return result.info ? { currency: result.info.currency, totalMinor: result.info.totalMinor } : undefined;
    }
  };
}
