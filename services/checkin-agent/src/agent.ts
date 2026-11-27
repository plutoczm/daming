import { CheckinPolicy, evaluateOutcome } from '../../../packages/governance/src/index.ts';
import type { CheckinOutcomeKind, CheckinOwner } from '../../../packages/governance/src/index.ts';
import type { CheckinCredential, CheckinPlatform, QuotaSnapshot } from './platform.ts';
import type { LocalCredentialStore } from './credentials.ts';

export interface CheckinItem {
  readonly accountId: string;
  readonly platform: string;
  readonly action: 'checkin' | 'quota.read';
  readonly result: 'done' | 'skipped' | 'needs_human' | 'failed';
  readonly reason?: string;
  readonly outcome?: CheckinOutcomeKind;
  readonly credits?: number;
  readonly quota?: QuotaSnapshot;
}
export interface HumanTask {
  readonly accountId: string;
  readonly platform: string;
  readonly reason: 'captcha' | 'terms';
}
export interface CheckinReport {
  readonly owner: CheckinOwner;
  readonly atMs: number;
  readonly items: readonly CheckinItem[];
  readonly needsHuman: readonly HumanTask[];
}

export interface CheckinAgentOptions {
  readonly policy: CheckinPolicy;
  readonly platform: CheckinPlatform;
  readonly store: LocalCredentialStore;
  readonly owner: CheckinOwner;
  readonly now?: () => number;
}

/**
 * Runs authorized, idempotent, READ-ONLY check-in / quota collection for accounts owned by `owner`.
 * Never acts without authorization, never after revoke, never auto-solves captcha/terms.
 */
export class CheckinAgent {
  private readonly opts: CheckinAgentOptions;
  constructor(options: CheckinAgentOptions) {
    if (!options || !(options.policy instanceof CheckinPolicy)) throw new Error('checkin_agent_policy_required');
    if (!options.platform || typeof options.platform.checkin !== 'function') throw new Error('checkin_agent_platform_required');
    if (!options.store || typeof options.store.get !== 'function') throw new Error('checkin_agent_store_required');
    if (options.owner !== 'linux' && options.owner !== 'windows') throw new Error('checkin_agent_owner_invalid');
    this.opts = options;
  }

  async run(nowMs: number = this.opts.now ? this.opts.now() : Date.now()): Promise<CheckinReport> {
    const items: CheckinItem[] = [];
    const needsHuman: HumanTask[] = [];
    for (const auth of this.opts.policy.list()) {
      // Only the owner's agent participates; other owner's accounts are untouched.
      const checkinDecision = this.opts.policy.canAct(auth.accountId, auth.platform, 'checkin', this.opts.owner, nowMs);
      if (!checkinDecision.allowed) {
        items.push({ accountId: auth.accountId, platform: auth.platform, action: 'checkin', result: 'skipped', ...(checkinDecision.reason ? { reason: checkinDecision.reason } : {}) });
        continue;
      }
      let credential: CheckinCredential;
      try {
        const stored = this.opts.store.get(auth.accountId, auth.platform);
        credential = { accountId: stored.accountId, platform: stored.platform, owner: stored.owner, secret: stored.secret };
      } catch {
        items.push({ accountId: auth.accountId, platform: auth.platform, action: 'checkin', result: 'skipped', reason: 'no_credential' });
        continue;
      }
      const outcome = await this.opts.platform.checkin(credential);
      const verdict = evaluateOutcome(outcome.kind);
      if (verdict.status === 'ok') {
        this.opts.policy.markActed(auth.accountId, auth.platform, nowMs);
        items.push({ accountId: auth.accountId, platform: auth.platform, action: 'checkin', result: 'done', outcome: outcome.kind, ...(outcome.credits !== undefined ? { credits: outcome.credits } : {}) });
      } else if (verdict.status === 'needs_human') {
        // captcha / terms: hand off to the human; never solve, never auto-retry.
        needsHuman.push({ accountId: auth.accountId, platform: auth.platform, reason: outcome.kind === 'terms' ? 'terms' : 'captcha' });
        items.push({ accountId: auth.accountId, platform: auth.platform, action: 'checkin', result: 'needs_human', outcome: outcome.kind });
      } else {
        items.push({ accountId: auth.accountId, platform: auth.platform, action: 'checkin', result: 'failed', outcome: outcome.kind });
      }

      // Read-only quota collection (separately authorized; never mutates remote state).
      if (auth.actions.includes('quota.read') && this.opts.policy.canAct(auth.accountId, auth.platform, 'quota.read', this.opts.owner, nowMs).allowed) {
        try {
          const quota = await this.opts.platform.readQuota(credential);
          items.push({ accountId: auth.accountId, platform: auth.platform, action: 'quota.read', result: 'done', quota });
        } catch {
          items.push({ accountId: auth.accountId, platform: auth.platform, action: 'quota.read', result: 'failed', reason: 'quota_read_failed' });
        }
      }
    }
    return { owner: this.opts.owner, atMs: nowMs, items, needsHuman };
  }
}
