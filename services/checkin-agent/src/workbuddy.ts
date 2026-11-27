import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { CheckinCredential, CheckinPlatform, CheckinResult, QuotaSnapshot } from './platform.ts';
import type { CheckinOutcomeKind } from '../../../packages/governance/src/index.ts';

/**
 * Daming 原生 WorkBuddy（腾讯 CodeBuddy 桌面版，CN）——从 Magpie 的 opencode-workbuddy-auth 插件
 * 的 sign()/call() 移植。关键：请求必须打 `https://copilot.tencent.com` 且带 WorkBuddy 客户端头
 * （UA `WorkBuddy/<app>`、X-Product、X-User-Id、X-Domain、X-IDE-*、X-Agent-*），否则 10085。
 */
export const WB_DEFAULT_ENDPOINT = 'https://copilot.tencent.com';
export const WB_APP = '5.9.3';

export interface WorkBuddyAccount { readonly access: string; readonly uid?: string; readonly domain?: string }
export interface WorkBuddyStatus { readonly active: boolean; readonly todayCheckedIn: boolean; readonly streakDays?: number; readonly todayCredit?: number }

export function buildWorkBuddyHeaders(account: WorkBuddyAccount, app: string = WB_APP): Record<string, string> {
  return {
    'content-type': 'application/json', accept: 'application/json',
    authorization: 'Bearer ' + account.access,
    'user-agent': 'WorkBuddy/' + app,
    'x-user-id': account.uid ?? '',
    'x-domain': account.domain ?? 'www.workbuddy.cn',
    'x-product': 'SaaS',
    'x-ide-type': 'WorkBuddy', 'x-ide-name': 'WorkBuddy', 'x-ide-version': app,
    'x-requested-with': 'XMLHttpRequest',
    'x-agent-intent': 'craft', 'x-agent-purpose': 'conversation',
    'x-request-id': 'daming-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
  };
}

export function wbPost(url: string, headers: Record<string, string>, body: string, timeoutMs = 20000): Promise<{ status: number; bodyText: string }> {
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? httpsRequest : httpRequest;
  const payload = Buffer.from(body, 'utf8');
  return new Promise((resolve, reject) => {
    const req = lib({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'POST', headers: { ...headers, 'content-length': String(payload.length) }, timeout: timeoutMs }, (r) => {
      const chunks: Buffer[] = [];
      r.on('data', (d: Buffer) => chunks.push(d));
      r.on('end', () => resolve({ status: r.statusCode ?? 0, bodyText: Buffer.concat(chunks).toString('utf8') }));
      r.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('workbuddy_timeout')); });
    req.on('error', reject);
    req.end(payload);
  });
}

function accountOf(credential: CheckinCredential): WorkBuddyAccount {
  let rec: Record<string, unknown> = {};
  try { rec = JSON.parse(credential.secret) as Record<string, unknown>; } catch { rec = {}; }
  const access = (rec.access ?? rec.accessToken ?? rec.token ?? credential.secret) as unknown;
  if (typeof access !== 'string' || !access) throw new Error('workbuddy_token_missing');
  return { access, ...(typeof rec.uid === 'string' ? { uid: rec.uid } : {}), ...(typeof rec.domain === 'string' ? { domain: rec.domain } : {}) };
}
function dataOf(json: Record<string, unknown>): Record<string, unknown> { return (json.data && typeof json.data === 'object' ? json.data : json) as Record<string, unknown>; }

export class WorkBuddyPlatform implements CheckinPlatform {
  readonly id = 'workbuddy';
  private readonly baseUrl: string;
  private readonly app: string;
  constructor(options: { baseUrl?: string; app?: string } = {}) {
    this.baseUrl = (options.baseUrl ?? WB_DEFAULT_ENDPOINT).replace(/\/+$/, '');
    this.app = options.app ?? WB_APP;
  }
  private async post(path: string, credential: CheckinCredential): Promise<{ status: number; json: Record<string, unknown> }> {
    const account = accountOf(credential);
    const r = await wbPost(this.baseUrl + path, buildWorkBuddyHeaders(account, this.app), '{}');
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(r.bodyText) as Record<string, unknown>; } catch { json = {}; }
    return { status: r.status, json };
  }
  async status(credential: CheckinCredential): Promise<WorkBuddyStatus> {
    const r = await this.post('/v2/billing/meter/checkin-activity-status', credential);
    if (r.status !== 200) throw new Error('workbuddy_status_failed');
    const s = dataOf(r.json);
    return { active: s.active === true, todayCheckedIn: s.today_checked_in === true, ...(typeof s.streak_days === 'number' ? { streakDays: s.streak_days } : {}), ...(typeof s.today_credit === 'number' ? { todayCredit: s.today_credit } : {}) };
  }
  async checkin(credential: CheckinCredential): Promise<CheckinResult> {
    const st = await this.post('/v2/billing/meter/checkin-activity-status', credential);
    if (st.status === 401) return { kind: 'terms', detail: 'workbuddy_401' };
    if (st.status !== 200) return { kind: 'failed' };
    const s = dataOf(st.json);
    if (s.active === false) return { kind: 'no_event' };
    if (s.today_checked_in === true) return { kind: 'already', ...(typeof s.today_credit === 'number' ? { credits: s.today_credit } : {}) };
    const cl = await this.post('/v2/billing/meter/daily-checkin', credential);
    return this.mapClaim(cl.status, cl.json);
  }
  private mapClaim(status: number, json: Record<string, unknown>): CheckinResult {
    if (status === 401) return { kind: 'terms', detail: 'workbuddy_401' };
    const code = json.code ?? (json.data as Record<string, unknown> | undefined)?.code;
    if (status !== 200) {
      if (code === 1001 || code === 10001) return { kind: 'already' };
      if (code === 1002) return { kind: 'failed', detail: 'ineligible' };
      if (code === 1003) return { kind: 'no_event' };
      return { kind: 'failed', detail: typeof json.msg === 'string' ? json.msg : undefined };
    }
    const d = dataOf(json);
    return { kind: 'claimed' as CheckinOutcomeKind, ...(typeof d.credit === 'number' ? { credits: d.credit } : {}) };
  }
  async readQuota(credential: CheckinCredential): Promise<QuotaSnapshot> {
    try {
      const r = await this.post('/billing/meter/get-user-resource-summary', credential);
      if (r.status !== 200) return { platform: 'workbuddy' };
      const s = dataOf(r.json);
      const pkgs = Array.isArray(s.Packages) ? s.Packages as Array<Record<string, unknown>> : [];
      let remaining = 0, unit: string | undefined;
      for (const p of pkgs) { const v = Number(p.CycleRemainCapacity); if (Number.isFinite(v)) remaining += v; if (typeof p.CapacityUnit === 'string') unit = p.CapacityUnit; }
      return { platform: 'workbuddy', ...(pkgs.length ? { remainingMinor: Math.round(remaining) } : {}), ...(unit ? { unit } : {}) };
    } catch { return { platform: 'workbuddy' }; }
  }
}
