import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '@daming/core';
import type { Engine, JsonValue, Task, TaskState } from '@daming/core';
import { Outbox } from '@daming/store-sqlite';
import type { SqliteStore } from '@daming/store-sqlite';
import { createGovernance } from '@daming/governance';
import type { ToolOperation } from '@daming/governance';
import type { CodexExecResult } from '@daming/worker-process';
import type { CodexApprovalTaskView } from '@daming/contracts';
import type { MagpiePinnedBinding } from './magpie-host.ts';
import { validPinnedMagpieBinding } from './magpie-codex-subscription.ts';

export const CODEX_WEB_SOURCE = 'host:codex-web-approval';
const META = 'codex_web_consent_prepared';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export interface CodexApprovalActor { tenantId: string; userId: string; sessionId: string }
interface Consent {
  tenantId: string; userId: string; sessionHash: string; bootId: string;
  requestId: string; expiresMs: number; limitMinor: number; binding: MagpiePinnedBinding;
}
interface Options {
  binding: () => Promise<MagpiePinnedBinding>;
  run: (binding: MagpiePinnedBinding, prompt: string, signal: AbortSignal) => Promise<CodexExecResult>;
  now?: () => number;
  onChanged?: () => void;
}
export class CodexApprovalError extends Error {
  readonly status: number;
  constructor(status: number, reason: string) { super('codex_web_' + reason); this.status = status; }
}
const fail = (reason: string, status = 409): never => { throw new CodexApprovalError(status, reason); };

/** One Engine owns task facts. Audit metadata is immutable consent, not another state machine. */
export class CodexWebApproval {
  private readonly bootId = randomUUID();
  private readonly active = new Set<Promise<unknown>>();
  private readonly lifetime = new AbortController();
  private preparing = false;
  private readonly approving = new Set<string>();
  private readonly now: () => number;
  private readonly store: SqliteStore;
  private readonly engine: Engine;
  private readonly options: Options;
  constructor(store: SqliteStore, engine: Engine, options: Options) {
    this.store = store; this.engine = engine; this.options = options;
    this.now = options.now ?? Date.now;
  }
  private changed() { this.options.onChanged?.(); }
  private task(id: string): Task {
    const task = this.engine.getTask(id);
    if (!task || task.sourceId !== CODEX_WEB_SOURCE) return fail('not_found', 404);
    return task;
  }
  private consent(id: string): Consent {
    this.task(id);
    const record = this.store.listGovernanceAudit(id).find(e => e.type === META);
    if (!record?.detail) return fail('not_found', 404);
    return record.detail as unknown as Consent;
  }
  private owned(actor: CodexApprovalActor, id: string): Consent {
    const c = this.consent(id);
    if (c.tenantId !== actor.tenantId || c.userId !== actor.userId) return fail('not_found', 404);
    return c;
  }
  private ids(): string[] {
    return this.store.listEvents().filter(e => e.sourceId === CODEX_WEB_SOURCE && e.type === 'task_created').map(e => e.taskId);
  }
  private context(id: string) {
    const t = this.task(id);
    return { taskId: id, runId: t.runId, attemptId: t.attemptId, sourceId: t.sourceId,
      eventId: randomUUID(), occurredAt: new Date(this.now()).toISOString() };
  }
  private transition(id: string, to: TaskState) {
    this.engine.execute({ type: 'transition_task', context: this.context(id), expectedVersion: this.task(id).version, to });
  }
  private approvalReason(actor: CodexApprovalActor, id: string): string | null {
    const c = this.owned(actor, id);
    if (this.task(id).status !== 'awaiting_approval') return 'not_awaiting';
    if (c.sessionHash !== hash(actor.sessionId)) return 'session_changed';
    if (c.bootId !== this.bootId || c.expiresMs <= this.now() || this.lifetime.signal.aborted) return 'expired';
    return null;
  }
  detail(actor: CodexApprovalActor, id: string): CodexApprovalTaskView {
    const c = this.owned(actor, id), task = this.task(id);
    const raw = this.store.governanceList('executions', id)[0]?.observation;
    const observation = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const usage: Record<string, number> = {};
    const values = observation.usage;
    if (values && typeof values === 'object' && !Array.isArray(values)) {
      for (const key of ['input_tokens', 'output_tokens', 'cached_input_tokens']) {
        const value = values[key];
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) usage[key] = value;
      }
    }
    const reason = this.approvalReason(actor, id);
    return { taskId: id, prompt: task.goal, model: 'codex/gpt-6.1-sol',
      accountLabel: 'Codex 订阅 · …' + hash(c.binding.accountRef).slice(-6),
      limitMinor: c.limitMinor, expiresAt: new Date(c.expiresMs).toISOString(), status: task.status,
      approvalAvailable: reason === null, approvalUnavailableReason: reason,
      recoveryRequired: c.bootId !== this.bootId && ['queued', 'running', 'reviewing'].includes(task.status),
      cashHeldMinor: this.store.governanceGet('budgets', id)?.heldMinor ?? 0, cashChargedMinor: null,
      modelStatus: typeof observation.modelStatus === 'string' ? observation.modelStatus : null,
      output: typeof observation.output === 'string' ? observation.output : '',
      usage: Object.keys(usage).length ? usage : null, automaticRetry: false };
  }
  list(actor: CodexApprovalActor): CodexApprovalTaskView[] {
    return this.ids().filter(id => {
      const c = this.consent(id); return c.userId === actor.userId && c.tenantId === actor.tenantId;
    }).reverse().map(id => this.detail(actor, id));
  }
  async prepare(actor: CodexApprovalActor, input: { requestId: string; prompt: string; limitMinor: number }, assertCurrent = () => {}): Promise<CodexApprovalTaskView> {
    if (this.lifetime.signal.aborted) return fail('closed');
    if (!input || typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(input.requestId) ||
        typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 4000 ||
        !Number.isSafeInteger(input.limitMinor) || input.limitMinor < 1 || input.limitMinor > 500) return fail('input_invalid', 400);
    const digest = hash(canonicalJson([CODEX_WEB_SOURCE, actor.tenantId, actor.userId, input.requestId]));
    const id = [digest.slice(0, 8), digest.slice(8, 12), digest.slice(12, 16), digest.slice(16, 20), digest.slice(20, 32)].join('-');
    if (this.engine.getTask(id)) {
      const old = this.owned(actor, id);
      if (this.task(id).goal !== input.prompt || old.limitMinor !== input.limitMinor) return fail('request_conflict');
      return this.detail(actor, id);
    }
    if (this.preparing) return fail('prepare_in_progress');
    // One unresolved web task globally; old diagnostic tasks are never adopted or changed.
    for (const other of this.ids()) {
      const task = this.task(other);
      if (['awaiting_approval', 'queued', 'running', 'reviewing'].includes(task.status) ||
          this.store.effectsForTask(other).some(e => ['pending', 'executing', 'needs_reconciliation'].includes(e.status)) ||
          this.store.governanceList('reservations', other).some(r => ['reserved', 'unknown', 'breached'].includes(r.status))) return fail('unresolved');
    }
    this.preparing = true;
    try {
      const binding = { ...await this.options.binding() };
      assertCurrent();
      if (this.lifetime.signal.aborted) return fail('closed');
      if (!validPinnedMagpieBinding(binding) || binding.accountKind !== 'codex-subscription' ||
          binding.providerId !== 'codex' || binding.modelId !== 'gpt-6.1-sol') return fail('binding_invalid', 503);
      const consent: Consent = { tenantId: actor.tenantId, userId: actor.userId, sessionHash: hash(actor.sessionId),
        requestId: input.requestId, bootId: this.bootId, expiresMs: this.now() + 300000, limitMinor: input.limitMinor, binding };
      this.store.atomic(() => {
        this.engine.execute({ type: 'create_task', context: { taskId: id, runId: randomUUID(), attemptId: randomUUID(),
          sourceId: CODEX_WEB_SOURCE, eventId: randomUUID(), occurredAt: new Date(this.now()).toISOString() },
          title: 'Codex 单次手动审批', goal: input.prompt });
        this.transition(id, 'planned'); this.transition(id, 'awaiting_approval');
        createGovernance({ repository: this.store, engine: this.engine, tools: [] }).admin.setBudget(id, input.limitMinor);
        this.store.appendGovernanceAudit({ taskId: id, type: META, atMs: this.now(), detail: JSON.parse(canonicalJson(consent)) as JsonValue });
      });
      this.changed(); return this.detail(actor, id);
    } finally { this.preparing = false; }
  }
  async approve(actor: CodexApprovalActor, id: string, approvedMaximumMinor: number, assertCurrent = () => {}): Promise<CodexApprovalTaskView> {
    const c = this.owned(actor, id);
    const check = () => {
      assertCurrent();
      const reason = this.approvalReason(actor, id); if (reason) fail(reason);
      if (approvedMaximumMinor !== c.limitMinor) fail('budget_mismatch', 400);
    };
    check();
    if (this.approving.has(id)) return fail('approval_in_progress');
    this.approving.add(id);
    try {
      const binding = await this.options.binding();
      check();
      if (canonicalJson(binding) !== canonicalJson(c.binding)) return fail('binding_changed');
      const task = this.task(id);
      const operation: ToolOperation = { id: id + '-send', taskId: id, runId: task.runId, attemptId: task.attemptId,
        executorKind: 'codex', toolId: 'codex.web.single-turn', toolVersion: '1', target: 'owned-magpie-codex-subscription',
        payload: { prompt: task.goal, accountBinding: hash(canonicalJson(c.binding)) }, amountMinor: 0, quoteId: id + '-quote',
        route: { mode: 'magpie', provider: 'codex', model: c.binding.modelId, accountRef: 'host-bound-subscription' } };
      let dispatched = false;
      const governance = createGovernance({ repository: this.store, engine: this.engine, tools: [], realTools: [{
        id: operation.toolId, version: '1', realExecution: true,
        execute: async (op, limits) => {
          if (dispatched || canonicalJson(op) !== canonicalJson(operation) || limits.maximumCashMinor !== c.limitMinor) {
            return { status: 'not_executed', reason: 'codex_web_binding_denied' };
          }
          dispatched = true;
          try { assertCurrent(); } catch { return { status: 'not_executed', reason: 'codex_web_session_changed' }; }
          if (this.lifetime.signal.aborted) return { status: 'not_executed', reason: 'codex_web_closed' };
          try {
            const result = await this.options.run({ ...c.binding }, task.goal, this.lifetime.signal);
            return { status: 'unknown', reason: 'subscription_cash_requires_manual_reconciliation', observation: {
              modelStatus: result.status, output: result.output.slice(0, 32768), usage: result.usage ? { ...result.usage } : null
            } };
          } catch { return { status: 'unknown', reason: 'subscription_cash_requires_manual_reconciliation',
            observation: { modelStatus: 'unknown', output: '', usage: null } }; }
        }
      }] });
      let token = '';
      this.store.atomic(() => {
        check();
        this.transition(id, 'queued'); this.transition(id, 'running');
        const expires = Math.min(c.expiresMs, this.now() + 60000);
        governance.admin.issueQuote(operation, c.limitMinor, expires, 'subscription');
        token = governance.admin.approve(operation, expires);
        this.engine.execute({ type: 'enqueue_effect', context: this.context(id), expectedVersion: this.task(id).version,
          effect: { effectId: operation.id, idempotencyKey: operation.id, kind: 'governance.tool',
            payload: { operation: JSON.parse(canonicalJson(operation)) as JsonValue }, semantics: 'non_idempotent' } });
      });
      const run = new Outbox(this.store, this.engine, () => new Date(this.now()).toISOString())
        .dispatchOne(governance.gateway.executor(() => token), id).catch(() => undefined);
      this.active.add(run);
      void run.finally(() => { this.active.delete(run); this.changed(); });
      this.changed(); return this.detail(actor, id);
    } finally { this.approving.delete(id); }
  }
  cancel(actor: CodexApprovalActor, id: string): CodexApprovalTaskView {
    this.owned(actor, id);
    if (this.task(id).status !== 'awaiting_approval') return fail('not_awaiting');
    this.transition(id, 'cancelled'); this.changed(); return this.detail(actor, id);
  }
  async drain(): Promise<void> { await Promise.allSettled([...this.active]); }
  async close(): Promise<void> { this.lifetime.abort(); await this.drain(); }
}
