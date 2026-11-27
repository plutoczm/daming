import { canonicalJson } from '@daming/core';
import { GovernanceError } from './model.ts';

export interface ProjectSendIntent {
  readonly projectId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly epoch: number;
  readonly sendId: string;
  readonly provider: string;
  readonly accountRef: string;
  readonly model: string;
  readonly protocol: string;
  readonly requestDigest: string;
  readonly quote: {
    readonly maximumCashMinor: number | null;
    readonly basisRef: string;
    readonly enforcementRef: string;
    readonly source: 'fixed_tariff' | 'verified_subscription';
    readonly expiresMs: number;
  };
}

export interface ProjectSpendBudget {
  readonly projectId: string;
  readonly limitMinor: number;
  readonly heldMinor: number;
  readonly spentMinor: number;
  readonly unresolvedCount: number;
  readonly breached: boolean;
}

export type ProjectSendOutcome =
  | { kind: 'completed'; reference: string; estimatedCashMinor?: number }
  | { kind: 'unknown' | 'not_sent'; reference: string };
export type ProjectCashEvidence = Readonly<{ cashMinor: number; reference: string }>;
export interface ProjectSendPermit {
  readonly intent: ProjectSendIntent;
  readonly maximumCashMinor: number;
  readonly status: 'reserved' | 'in_flight' | 'awaiting_cash' | 'unknown' | 'released' | 'settled' | 'breached';
  readonly outcome?: ProjectSendOutcome;
  readonly suspectUpperBound?: true;
  readonly cashEvidence?: ProjectCashEvidence;
}

export interface ProjectSpendRepository {
  atomic<T>(work: () => T): T;
  getProjectBudget(projectId: string): ProjectSpendBudget | undefined;
  saveProjectBudget(budget: ProjectSpendBudget): void;
  getProjectSend(projectId: string, sendId: string): ProjectSendPermit | undefined;
  saveProjectSend(permit: ProjectSendPermit): void;
}

function isMinor(amount: unknown): amount is number {
  return typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0 && amount <= 1_000_000_000;
}

function isReference(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 512;
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/** Host-only ledger. Prices, observations and cash evidence come from trusted route adapters. */
export class ProjectSpendLedger {
  private readonly repo: ProjectSpendRepository;
  private readonly now: () => number;

  constructor(repo: ProjectSpendRepository, now: () => number) {
    this.repo = repo;
    this.now = now;
  }

  initializeBudget(projectId: string, limitMinor: number): ProjectSpendBudget {
    if (!isReference(projectId) || !isMinor(limitMinor)) throw new GovernanceError('project_budget_invalid');
    return this.repo.atomic(() => {
      const old = this.repo.getProjectBudget(projectId);
      if (old) {
        if (old.limitMinor !== limitMinor) throw new GovernanceError('project_budget_already_set');
        return old;
      }
      const budget = { projectId, limitMinor, heldMinor: 0, spentMinor: 0, unresolvedCount: 0, breached: false };
      this.repo.saveProjectBudget(budget);
      return budget;
    });
  }

  budget(projectId: string): ProjectSpendBudget | undefined {
    return this.repo.getProjectBudget(projectId);
  }

  private requireBudget(projectId: string): ProjectSpendBudget {
    const budget = this.repo.getProjectBudget(projectId);
    if (!budget) throw new GovernanceError('project_budget_missing');
    return budget;
  }

  private requirePermit(projectId: string, sendId: string): ProjectSendPermit {
    const permit = this.repo.getProjectSend(projectId, sendId);
    if (!permit) throw new GovernanceError('project_send_permit_missing');
    return permit;
  }

  private requireClearBudget(projectId: string): ProjectSpendBudget {
    const budget = this.requireBudget(projectId);
    if (budget.breached || budget.unresolvedCount) throw new GovernanceError('project_budget_requires_reconciliation');
    return budget;
  }

  private requireQuote(intent: ProjectSendIntent): number {
    const { quote } = intent;
    const refs = [intent.projectId, intent.taskId, intent.attemptId, intent.sendId, intent.provider,
      intent.accountRef, intent.model, intent.protocol, intent.requestDigest, quote?.basisRef, quote?.enforcementRef];
    if (!refs.every(isReference) || !Number.isSafeInteger(intent.epoch) || intent.epoch < 0 ||
        !quote || !Number.isSafeInteger(quote.expiresMs) || !(quote.expiresMs > this.now()) ||
        !isMinor(quote.maximumCashMinor) ||
        (quote.source === 'fixed_tariff' ? quote.maximumCashMinor === 0 :
          quote.source !== 'verified_subscription' || quote.maximumCashMinor !== 0)) {
      throw new GovernanceError('project_send_upper_bound_unverified');
    }
    return quote.maximumCashMinor;
  }

  reserveProjectSend(intent: ProjectSendIntent): ProjectSendPermit {
    return this.repo.atomic(() => {
      const maximumCashMinor = this.requireQuote(intent);
      const budget = this.requireClearBudget(intent.projectId);
      const prior = this.repo.getProjectSend(intent.projectId, intent.sendId);
      if (prior) {
        if (!same(prior.intent, intent)) throw new GovernanceError('project_send_binding_mismatch');
        return prior;
      }
      if (maximumCashMinor > budget.limitMinor - budget.spentMinor - budget.heldMinor) {
        throw new GovernanceError('project_budget_exhausted');
      }
      const permit = { intent, maximumCashMinor, status: 'reserved' } as const;
      this.repo.saveProjectSend(permit);
      this.repo.saveProjectBudget({ ...budget, heldMinor: budget.heldMinor + maximumCashMinor });
      return permit;
    });
  }

  consumeProjectSend(intent: ProjectSendIntent): ProjectSendPermit {
    return this.repo.atomic(() => {
      this.requireQuote(intent);
      this.requireClearBudget(intent.projectId);
      const permit = this.requirePermit(intent.projectId, intent.sendId);
      if (permit.status !== 'reserved' || !same(permit.intent, intent)) {
        throw new GovernanceError('project_send_permit_unavailable_or_mismatched');
      }
      const started = { ...permit, status: 'in_flight' } as const;
      this.repo.saveProjectSend(started);
      return started;
    });
  }

  beginProjectSend(intent: ProjectSendIntent): ProjectSendPermit {
    return this.repo.atomic(() => {
      this.reserveProjectSend(intent);
      return this.consumeProjectSend(intent);
    });
  }

  recordProjectSendOutcome(projectId: string, sendId: string, outcome: ProjectSendOutcome): ProjectSendPermit {
    return this.repo.atomic(() => {
      const permit = this.requirePermit(projectId, sendId);
      if (permit.outcome && same(permit.outcome, outcome)) return permit;
      if (!isReference(outcome.reference) || !['completed', 'unknown', 'not_sent'].includes(outcome.kind) ||
          (outcome.kind === 'completed' && outcome.estimatedCashMinor !== undefined && !isMinor(outcome.estimatedCashMinor))) {
        throw new GovernanceError('project_send_outcome_invalid');
      }
      if (permit.status !== 'in_flight' && !(permit.status === 'reserved' && outcome.kind === 'not_sent')) {
        throw new GovernanceError('project_send_outcome_conflict');
      }
      const budget = this.requireBudget(projectId);
      const suspect = outcome.kind === 'completed' && outcome.estimatedCashMinor !== undefined &&
        outcome.estimatedCashMinor > permit.maximumCashMinor;
      if (outcome.kind === 'unknown' || suspect) {
        this.repo.saveProjectBudget({ ...budget, unresolvedCount: budget.unresolvedCount + 1 });
      } else if (outcome.kind === 'not_sent') {
        this.repo.saveProjectBudget({ ...budget, heldMinor: budget.heldMinor - permit.maximumCashMinor });
      }
      const status = outcome.kind === 'completed' ? 'awaiting_cash' : outcome.kind === 'unknown' ? 'unknown' : 'released';
      const updated: ProjectSendPermit = { ...permit, outcome, status, ...(suspect ? { suspectUpperBound: true } : {}) };
      this.repo.saveProjectSend(updated);
      return updated;
    });
  }

  confirmProjectSendCash(projectId: string, sendId: string, evidence: ProjectCashEvidence): ProjectSendPermit {
    return this.repo.atomic(() => {
      const permit = this.requirePermit(projectId, sendId);
      if (permit.cashEvidence && same(permit.cashEvidence, evidence)) return permit;
      if (permit.status !== 'awaiting_cash' || !isReference(evidence.reference) || !isMinor(evidence.cashMinor)) {
        throw new GovernanceError('project_cash_confirmation_invalid');
      }
      const budget = this.requireBudget(projectId);
      const breached = evidence.cashMinor > permit.maximumCashMinor;
      const updated = { ...permit, cashEvidence: evidence, status: breached ? 'breached' : 'settled' } as const;
      const spentMinor = budget.spentMinor + evidence.cashMinor;
      if (!Number.isSafeInteger(spentMinor)) throw new GovernanceError('project_cash_out_of_range');
      this.repo.saveProjectBudget({
        ...budget, spentMinor, heldMinor: budget.heldMinor - permit.maximumCashMinor, breached: budget.breached || breached,
        unresolvedCount: budget.unresolvedCount - (permit.suspectUpperBound ? 1 : 0),
      });
      this.repo.saveProjectSend(updated);
      return updated;
    });
  }
}
