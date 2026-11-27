import { randomUUID, createHash } from 'node:crypto';
import { canonicalJson } from '@daming/core';
import type { Engine, JsonValue, TaskState } from '@daming/core';
import { Outbox } from '@daming/store-sqlite';
import type { SqliteStore } from '@daming/store-sqlite';
import { createGovernance } from '@daming/governance';
import type { ToolOperation } from '@daming/governance';
import type { CodexExecResult } from '@daming/worker-process';
import type { MagpiePinnedBinding } from './magpie-host.ts';
import { validPinnedMagpieBinding } from './magpie-codex-subscription.ts';

export const CODEX_SUBSCRIPTION_ACCEPTANCE_TASK = 'codex-magpie-subscription-live-2026-11-16';
export const CODEX_SUBSCRIPTION_ACCEPTANCE_PROMPT = 'Reply with only OK. Do not call tools.';
type Result = { modelStatus: string; output: string; usage: Record<string, number> | null;
  taskStatus: TaskState; cashHeldMinor: number; cashChargedMinor: null; automaticRetry: false };

/** One explicitly approved Host diagnostic, not a production Worker or UI grant.
 * Fixed durable identity prevents a rerun from creating a new CNY5 envelope.
 */
export class CodexSubscriptionAcceptance {
  private readonly store: SqliteStore;
  private readonly engine: Engine;
  private readonly binding: MagpiePinnedBinding;
  private readonly governance: ReturnType<typeof createGovernance>;
  private operation?: ToolOperation;
  private dispatched = false;
  private observation: { modelStatus: string; output: string; usage: Record<string, number> | null } = {
    modelStatus:'unknown', output:'', usage:null
  };
  constructor(store: SqliteStore, engine: Engine, binding: MagpiePinnedBinding, run: (binding: Readonly<MagpiePinnedBinding>) => Promise<CodexExecResult>) {
    if (!validPinnedMagpieBinding(binding) || binding.accountKind !== 'codex-subscription' || binding.modelId !== 'gpt-6.1-sol') {
      throw new Error('codex_subscription_acceptance_binding_invalid');
    }
    this.store = store; this.engine = engine; this.binding = Object.freeze({ ...binding });
    this.governance = createGovernance({ repository:store, engine, tools:[], realTools:[{
      id:'codex.subscription.acceptance', version:'1', realExecution:true,
      execute:async (operation, limits) => {
        if (this.dispatched || !this.operation || canonicalJson(operation) !== canonicalJson(this.operation) || limits.maximumCashMinor !== 500) {
          return { status:'not_executed', reason:'codex_subscription_acceptance_binding_denied' };
        }
        this.dispatched = true;
        try {
          const result = await run(this.binding);
          this.observation = { modelStatus:result.status, output:result.output,
            usage:result.usage ? { ...result.usage } : null };
        } catch { this.observation = { modelStatus:'unknown', output:'', usage:null }; }
        return { status:'unknown', reason:'subscription_cash_requires_manual_reconciliation', observation:this.observation };
      }
    }] });
  }
  private context(eventId: string) {
    const task = this.engine.getTask(CODEX_SUBSCRIPTION_ACCEPTANCE_TASK)!;
    return { taskId:task.taskId,runId:task.runId,attemptId:task.attemptId,sourceId:task.sourceId,eventId,occurredAt:new Date().toISOString() };
  }
  private transition(to: TaskState) {
    this.engine.execute({ type:'transition_task',context:this.context(randomUUID()),
      expectedVersion:this.engine.getTask(CODEX_SUBSCRIPTION_ACCEPTANCE_TASK)!.version,to });
  }
  prepare(): void {
    if (this.engine.getTask(CODEX_SUBSCRIPTION_ACCEPTANCE_TASK)) throw new Error('codex_subscription_acceptance_already_exists_no_replay');
    const taskId = CODEX_SUBSCRIPTION_ACCEPTANCE_TASK, runId = randomUUID(), attemptId = randomUUID();
    const accountBinding = createHash('sha512').update(canonicalJson(this.binding)).digest('hex');
    const operation: ToolOperation = {
      id:taskId+'-single-send',taskId,runId,attemptId,executorKind:'codex',
      toolId:'codex.subscription.acceptance',toolVersion:'1',target:'owned-magpie-codex-subscription',
      payload:{prompt:CODEX_SUBSCRIPTION_ACCEPTANCE_PROMPT,accountBinding},amountMinor:0,quoteId:taskId+'-quote',
      route:{mode:'magpie',provider:'codex',model:this.binding.modelId,accountRef:'host-bound-subscription'}
    };
    this.store.atomic(() => {
      this.engine.execute({type:'create_task',context:{taskId,runId,attemptId,sourceId:'local-user:manual-acceptance',eventId:randomUUID(),occurredAt:new Date().toISOString()},
        title:'Codex subscription through owned Magpie: one approved text turn',goal:CODEX_SUBSCRIPTION_ACCEPTANCE_PROMPT});
      this.transition('planned'); this.transition('awaiting_approval');
      this.governance.admin.setBudget(taskId,500);
    });
    this.operation = Object.freeze(operation);
  }
  async authorizeAndRun(approvedMaximumMinor: number): Promise<Result> {
    if (approvedMaximumMinor !== 500) throw new Error('explicit_500_minor_approval_required');
    if (!this.operation || this.dispatched || this.engine.getTask(CODEX_SUBSCRIPTION_ACCEPTANCE_TASK)?.status !== 'awaiting_approval') {
      throw new Error('codex_subscription_acceptance_already_used_or_not_prepared');
    }
    const operation = this.operation;
    const expiresMs = Date.now()+60000;
    let token = '';
    this.store.atomic(() => {
      this.transition('queued'); this.transition('running');
      this.governance.admin.issueQuote(operation,500,expiresMs,'subscription');
      token = this.governance.admin.approve(operation,expiresMs);
      this.engine.execute({type:'enqueue_effect',context:this.context(randomUUID()),expectedVersion:this.engine.getTask(operation.taskId)!.version,
        effect:{effectId:operation.id,idempotencyKey:operation.id,kind:'governance.tool',payload:{operation:JSON.parse(canonicalJson(operation)) as JsonValue},semantics:'non_idempotent'}});
    });
    await new Outbox(this.store,this.engine,() => new Date().toISOString()).dispatchOne(this.governance.gateway.executor(() => token),operation.taskId);
    return { ...this.observation, taskStatus:this.engine.getTask(operation.taskId)!.status,
      cashHeldMinor:this.governance.ledger.budget(operation.taskId)!.heldMinor,cashChargedMinor:null,automaticRetry:false };
  }
}
