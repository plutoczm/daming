import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { CheckinOutcomeKind } from '../../../packages/governance/src/index.ts';

export interface CheckinCredential {
  readonly accountId: string;
  readonly platform: string;
  readonly secret: string;
  readonly owner: string;
}
export interface CheckinResult {
  readonly kind: CheckinOutcomeKind;
  readonly credits?: number;
  readonly detail?: string;
}
export interface QuotaSnapshot {
  readonly platform: string;
  readonly totalMinor?: number;
  readonly remainingMinor?: number;
  readonly unit?: string;
}
export interface CheckinPlatform {
  readonly id: string;
  checkin(credential: CheckinCredential): Promise<CheckinResult>;
  readQuota(credential: CheckinCredential): Promise<QuotaSnapshot>;
}

const SECRET = /[\u0000-\u001f]/;

function assertCredential(c: CheckinCredential): void {
  if (!c || typeof c.secret !== 'string' || !c.secret || SECRET.test(c.secret) || c.secret.length > 4096) {
    throw new Error('checkin_credential_invalid');
  }
}

function requestJson(url: string, method: 'GET' | 'POST', body?: unknown, timeoutMs = 10000, extraHeaders: Record<string, string> = {}): Promise<{ status: number; json: unknown }> {
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? httpsRequest : httpRequest;
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise((resolve, reject) => {
    const req = lib({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}), ...extraHeaders },
      timeout: timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on('data', (d: Buffer) => { bytes += d.length; if (bytes > 65536) { req.destroy(); reject(new Error('checkin_response_too_large')); } else chunks.push(d); });
      res.on('end', () => {
        let json: unknown;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { reject(new Error('checkin_response_invalid')); return; }
        resolve({ status: res.statusCode ?? 0, json });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('checkin_timeout')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Deterministic, offline platform for tests. Records how many times it was actually called. */
export class SimulatedPlatform implements CheckinPlatform {
  readonly id = 'simulated';
  readonly calls: CheckinCredential[] = [];
  private readonly queue: CheckinOutcomeKind[];
  private readonly quota: QuotaSnapshot;
  constructor(options: { outcomes?: readonly CheckinOutcomeKind[]; quota?: QuotaSnapshot } = {}) {
    this.queue = [...(options.outcomes ?? [])];
    this.quota = options.quota ?? { platform: 'simulated', remainingMinor: 500, unit: 'credits' };
  }
  async checkin(credential: CheckinCredential): Promise<CheckinResult> {
    assertCredential(credential);
    this.calls.push(credential);
    const kind = this.queue.shift() ?? 'claimed';
    return { kind, ...(kind === 'claimed' ? { credits: 10 } : {}) };
  }
  async readQuota(): Promise<QuotaSnapshot> {
    return this.quota;
  }
}

/** Read-only HTTP platform client (used against a local fixture server or a real platform endpoint). */
export class HttpCheckinPlatform implements CheckinPlatform {
  readonly id: string;
  private readonly baseUrl: string;
  constructor(options: { baseUrl: string; id?: string }) {
    const u = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('checkin_base_url_invalid');
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.id = options.id ?? u.host;
  }
  async checkin(credential: CheckinCredential): Promise<CheckinResult> {
    assertCredential(credential);
    const { status, json } = await requestJson(this.baseUrl + '/checkin', 'POST', {
      accountId: credential.accountId, platform: credential.platform,
    });
    if (status !== 200 || !json || typeof json !== 'object') throw new Error('checkin_http_failed');
    const rec = json as Record<string, unknown>;
    const kind = String(rec.kind ?? '') as CheckinOutcomeKind;
    if (!['claimed', 'already', 'captcha', 'terms', 'no_event', 'failed'].includes(kind)) throw new Error('checkin_outcome_invalid');
    return { kind, ...(typeof rec.credits === 'number' ? { credits: rec.credits } : {}) };
  }
  async readQuota(credential: CheckinCredential): Promise<QuotaSnapshot> {
    const { status, json } = await requestJson(
      this.baseUrl + '/quota?platform=' + encodeURIComponent(credential.platform) + '&account=' + encodeURIComponent(credential.accountId), 'GET');
    if (status !== 200 || !json || typeof json !== 'object') throw new Error('checkin_quota_http_failed');
    const rec = json as Record<string, unknown>;
    return {
      platform: credential.platform,
      ...(typeof rec.totalMinor === 'number' ? { totalMinor: rec.totalMinor } : {}),
      ...(typeof rec.remainingMinor === 'number' ? { remainingMinor: rec.remainingMinor } : {}),
      ...(typeof rec.unit === 'string' ? { unit: rec.unit } : {}),
    };
  }
}

export interface WorkBuddyStatus {
  readonly active: boolean;
  readonly todayCheckedIn: boolean;
  readonly streakDays?: number;
  readonly todayCredit?: number;
}

/**
 * Daming 原生 WorkBuddy（中国版）签到适配器 —— 从 Magpie 的 workbuddy_checkin.go 移植。
 * token（Bearer）来自导入的账号凭据（plugin-auth.json 的 `access`）。
 * status: POST /v2/billing/meter/checkin-activity-status
 * claim : POST /v2/billing/meter/daily-checkin   （1001 已签 / 1002 不合格 / 1003 活动结束；401=需官方 App→转人工）
 */
export class WorkBuddyPlatform implements CheckinPlatform {
  readonly id = 'workbuddy';
  private readonly baseUrl: string;
  constructor(options: { baseUrl?: string } = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://www.workbuddy.cn').replace(/\/+$/, '');
  }
  private token(credential: CheckinCredential): string {
    let rec: Record<string, unknown> = {};
    try { rec = JSON.parse(credential.secret) as Record<string, unknown>; } catch { rec = {}; }
    const t = rec.access ?? rec.accessToken ?? rec.token ?? credential.secret;
    if (typeof t !== 'string' || !t) throw new Error('workbuddy_token_missing');
    return t;
  }
  private post(path: string, credential: CheckinCredential): Promise<{ status: number; json: unknown }> {
    const token = this.token(credential);
    return requestJson(this.baseUrl + path, 'POST', {}, 15000, { authorization: 'Bearer ' + token });
  }
  async status(credential: CheckinCredential): Promise<WorkBuddyStatus> {
    assertCredential(credential);
    const r = await this.post('/v2/billing/meter/checkin-activity-status', credential);
    if (r.status !== 200 || !r.json || typeof r.json !== 'object') throw new Error('workbuddy_status_failed');
    const raw = r.json as Record<string, unknown>;
    const s = (raw.data && typeof raw.data === 'object' ? raw.data : raw) as Record<string, unknown>;
    return {
      active: s.active === true, todayCheckedIn: s.today_checked_in === true,
      ...(typeof s.streak_days === 'number' ? { streakDays: s.streak_days } : {}),
      ...(typeof s.today_credit === 'number' ? { todayCredit: s.today_credit } : {}),
    };
  }
  async checkin(credential: CheckinCredential): Promise<CheckinResult> {
    assertCredential(credential);
    const st = await this.post('/v2/billing/meter/checkin-activity-status', credential);
    if (st.status === 401) return { kind: 'terms', detail: 'workbuddy_401_own_app' };
    if (st.status !== 200 || !st.json || typeof st.json !== 'object') return { kind: 'failed' };
    const raw = st.json as Record<string, unknown>;
    const s = (raw.data && typeof raw.data === 'object' ? raw.data : raw) as Record<string, unknown>;
    if (s.active === false) return { kind: 'no_event' };
    if (s.today_checked_in === true) return { kind: 'already', ...(typeof s.today_credit === 'number' ? { credits: s.today_credit } : {}) };
    const cl = await this.post('/v2/billing/meter/daily-checkin', credential);
    if (cl.status === 401) return { kind: 'terms', detail: 'workbuddy_401_own_app' };
    const body = (cl.json && typeof cl.json === 'object' ? cl.json : {}) as Record<string, unknown>;
    const code = body.code ?? (body.data as Record<string, unknown> | undefined)?.code;
    if (cl.status !== 200) {
      if (code === 1001 || code === 10001) return { kind: 'already' };
      if (code === 1002) return { kind: 'failed', detail: 'ineligible' };
      if (code === 1003) return { kind: 'no_event' };
      return { kind: 'failed', detail: typeof body.msg === 'string' ? body.msg : undefined };
    }
    const d = (body.data && typeof body.data === 'object' ? body.data : body) as Record<string, unknown>;
    return { kind: 'claimed', ...(typeof d.credit === 'number' ? { credits: d.credit } : {}) };
  }
  async readQuota(credential: CheckinCredential): Promise<QuotaSnapshot> {
    // Read-only quota. WorkBuddy's resource summary requires the official app's
    // device-signed request; a bare bearer is refused (403/10085, same class as
    // own-app). We never fabricate numbers: on any error/non-200 return only the platform.
    try {
      const r = await this.post('/billing/meter/get-user-resource-summary', credential);
      if (r.status !== 200 || !r.json || typeof r.json !== 'object') return { platform: 'workbuddy' };
      const raw = r.json as Record<string, unknown>;
      const d = (raw.data && typeof raw.data === 'object' ? raw.data : raw) as Record<string, unknown>;
      const remaining = typeof d.remaining === 'number' ? d.remaining : (typeof d.balance === 'number' ? d.balance : (typeof d.credits === 'number' ? d.credits : undefined));
      return { platform: 'workbuddy', ...(typeof remaining === 'number' ? { remainingMinor: remaining } : {}) };
    } catch {
      return { platform: 'workbuddy' };
    }
  }
}
