/**
 * S11 — Linux 独立签到/配额采集策略（纯领域，无 I/O）。
 *
 * 约束（见 spec REQ-013）：
 *  - 逐账号/平台显式授权，可撤销；撤销后不得有任何动作。
 *  - 只读配额 / 签到（不改主任务、不接管全局审批）。
 *  - 验证码 / 条款限制 → 转人工，绝不绕过、不自动重试。
 *  - 标注执行所有者（linux / windows），只有对应所有者的 agent 才能动作。
 */

export type CheckinOwner = 'linux' | 'windows';
export type CheckinAction = 'checkin' | 'quota.read';
export type CheckinFrequency = 'daily' | 'weekly' | 'manual';

export interface CheckinAuthorization {
  readonly accountId: string;
  readonly platform: string;
  readonly owner: CheckinOwner;
  readonly actions: readonly CheckinAction[];
  readonly frequency: CheckinFrequency;
  readonly grantedAtMs: number;
  revokedAtMs?: number;
  expiresAtMs?: number;
}

export interface CheckinDecision {
  readonly allowed: boolean;
  readonly reason?: 'not_authorized' | 'revoked' | 'expired' | 'owner_mismatch' | 'action_not_authorized' | 'frequency_limit';
}

export type CheckinOutcomeKind = 'claimed' | 'already' | 'captcha' | 'terms' | 'no_event' | 'failed';
export type CheckinOutcomeStatus = 'ok' | 'needs_human' | 'failed';
export interface CheckinOutcomeVerdict {
  readonly status: CheckinOutcomeStatus;
  /** Whether the agent may automatically try again later (never for captcha/terms/failed). */
  readonly autoRetry: boolean;
}

const ID = /^[A-Za-z0-9_.:-]{1,80}$/;
const PLATFORM = /^[A-Za-z0-9_.:-]{1,80}$/;
const ACTIONS: readonly CheckinAction[] = ['checkin', 'quota.read'];
const OWNERS: readonly CheckinOwner[] = ['linux', 'windows'];
const FREQUENCIES: readonly CheckinFrequency[] = ['daily', 'weekly', 'manual'];
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

function key(accountId: string, platform: string): string { return accountId + '|' + platform; }

export function validateAuthorization(a: CheckinAuthorization): void {
  if (!a || typeof a !== 'object') throw new Error('checkin_authorization_invalid');
  if (!ID.test(a.accountId) || a.accountId.includes('..')) throw new Error('checkin_account_invalid');
  if (!PLATFORM.test(a.platform) || a.platform.includes('..')) throw new Error('checkin_platform_invalid');
  if (!OWNERS.includes(a.owner)) throw new Error('checkin_owner_invalid');
  if (!Array.isArray(a.actions) || a.actions.length < 1 || a.actions.some((x) => !ACTIONS.includes(x))) throw new Error('checkin_actions_invalid');
  if (!FREQUENCIES.includes(a.frequency)) throw new Error('checkin_frequency_invalid');
  if (!Number.isSafeInteger(a.grantedAtMs) || a.grantedAtMs < 0) throw new Error('checkin_granted_invalid');
  if (a.expiresAtMs !== undefined && (!Number.isSafeInteger(a.expiresAtMs) || a.expiresAtMs <= a.grantedAtMs)) throw new Error('checkin_expiry_invalid');
}

/** 验证码 / 条款：转人工、绝不绕过、绝不自动重试。 */
export function evaluateOutcome(kind: CheckinOutcomeKind): CheckinOutcomeVerdict {
  switch (kind) {
    case 'claimed':
    case 'already':
    case 'no_event':
      return { status: 'ok', autoRetry: false };
    case 'captcha':
    case 'terms':
      return { status: 'needs_human', autoRetry: false };
    case 'failed':
      return { status: 'failed', autoRetry: false };
    default:
      return { status: 'failed', autoRetry: false };
  }
}

export class CheckinPolicy {
  private readonly auths = new Map<string, CheckinAuthorization>();
  private readonly lastActedMs = new Map<string, number>();

  authorize(auth: CheckinAuthorization): CheckinAuthorization {
    validateAuthorization(auth);
    const clean: CheckinAuthorization = Object.freeze({
      accountId: auth.accountId, platform: auth.platform, owner: auth.owner,
      actions: Object.freeze([...new Set(auth.actions)]), frequency: auth.frequency,
      grantedAtMs: auth.grantedAtMs,
      ...(auth.expiresAtMs !== undefined ? { expiresAtMs: auth.expiresAtMs } : {}),
    });
    this.auths.set(key(auth.accountId, auth.platform), clean);
    return clean;
  }

  revoke(accountId: string, platform: string, atMs: number): boolean {
    const current = this.auths.get(key(accountId, platform));
    if (!current) return false;
    this.auths.set(key(accountId, platform), { ...current, revokedAtMs: atMs });
    return true;
  }

  get(accountId: string, platform: string): CheckinAuthorization | undefined {
    const a = this.auths.get(key(accountId, platform));
    return a ? Object.freeze({ ...a }) : undefined;
  }

  list(): readonly CheckinAuthorization[] {
    return Object.freeze([...this.auths.values()].map((a) => Object.freeze({ ...a })));
  }

  /** 撤销授权后 canAct 必为 false（无动作）。 */
  canAct(accountId: string, platform: string, action: CheckinAction, owner: CheckinOwner, nowMs: number): CheckinDecision {
    const a = this.auths.get(key(accountId, platform));
    if (!a) return { allowed: false, reason: 'not_authorized' };
    if (a.revokedAtMs !== undefined) return { allowed: false, reason: 'revoked' };
    if (a.expiresAtMs !== undefined && nowMs >= a.expiresAtMs) return { allowed: false, reason: 'expired' };
    if (a.owner !== owner) return { allowed: false, reason: 'owner_mismatch' };
    if (!a.actions.includes(action)) return { allowed: false, reason: 'action_not_authorized' };
    if (a.frequency !== 'manual') {
      const last = this.lastActedMs.get(key(accountId, platform));
      const period = a.frequency === 'daily' ? DAY_MS : WEEK_MS;
      if (last !== undefined && nowMs - last < period) return { allowed: false, reason: 'frequency_limit' };
    }
    return { allowed: true };
  }

  markActed(accountId: string, platform: string, nowMs: number): void {
    this.lastActedMs.set(key(accountId, platform), nowMs);
  }
}
