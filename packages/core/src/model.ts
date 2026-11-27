import type { Workflow,WorkflowAction } from './workflow.ts';
import type { JsonValue } from './json.ts';
export const TASK_STATES = ['draft','planned','awaiting_approval','queued','running','reviewing','completed','blocked','failed','cancelled'] as const;
export type TaskState = (typeof TASK_STATES)[number];
export interface TaskSnapshot {
  readonly taskId:string;
  readonly title:string;
  readonly goal:string;
  readonly status:TaskState;
  readonly createdAt:string;
}
export interface Task extends TaskSnapshot {
  readonly runId:string;
  readonly attemptId:string;
  readonly sourceId:string;
  readonly version:number;
  readonly updatedAt:string;
  readonly blockedReason?:string;
  readonly workflow?:Workflow;
}
export interface CommandContext {
  readonly taskId:string;
  readonly runId:string;
  readonly attemptId:string;
  readonly eventId:string;
  readonly occurredAt:string;
  readonly sourceId:string;
}
export interface TaskEvent extends CommandContext { readonly sequence:number; readonly type:string; }
export interface StoredEvent extends TaskEvent {
  readonly commandJson:string;
  readonly snapshot:Task;
  readonly details:JsonValue;
}
export interface Plan {
  readonly planId:string; readonly taskId:string; readonly version:number;
  readonly steps:readonly {readonly stepId:string;readonly description:string;readonly dependsOn:readonly string[]}[];
}
export interface Decision { readonly decisionId:string;readonly taskId:string;readonly kind:'policy'|'approval'|'routing'|'reconciliation';readonly reason:string;readonly occurredAt:string; }
export interface Assignment { readonly assignmentId:string;readonly taskId:string;readonly runId:string;readonly attemptId:string;readonly workerId:string; }
export interface Review { readonly reviewId:string;readonly taskId:string;readonly assignmentId:string;readonly contractVersion:number;readonly verdict:'pass'|'fail'|'needs_human';readonly evidenceRefs:readonly string[]; }
export interface EffectRequest {
  readonly effectId:string;
  readonly idempotencyKey:string;
  readonly kind:string;
  readonly payload:JsonValue;
  readonly semantics:'idempotent'|'non_idempotent';
}
export type EffectStatus='pending'|'executing'|'succeeded'|'needs_reconciliation'|'failed'|'cancelled';
export interface OutboxEffect extends EffectRequest {
  readonly taskId:string;readonly runId:string;readonly attemptId:string;
  readonly status:EffectStatus;readonly attempts:number;
  readonly createdAt:string;readonly updatedAt:string;
  readonly result?:JsonValue;readonly error?:string;
}
export type EffectOutcome =
  | {readonly status:'succeeded';readonly result:JsonValue}
  | {readonly status:'not_executed';readonly reason:string;readonly retryable:boolean}
  | {readonly status:'unknown';readonly reason:string};
export type Command =
  | {readonly type:'workflow';readonly context:CommandContext;readonly expectedVersion:number;readonly action:WorkflowAction}
  | {readonly type:'create_task';readonly context:CommandContext;readonly title:string;readonly goal:string}
  | {readonly type:'transition_task';readonly context:CommandContext;readonly expectedVersion:number;readonly to:TaskState;readonly reason?:string;readonly effects?:readonly EffectRequest[]}
  | {readonly type:'enqueue_effect';readonly context:CommandContext;readonly expectedVersion:number;readonly effect:EffectRequest}
  | {readonly type:'reconcile_effect';readonly context:CommandContext;readonly expectedVersion:number;readonly effectId:string;readonly resolution:'succeeded'|'not_executed';readonly evidence:string;readonly result?:JsonValue};
export interface CommandResult { readonly duplicate:boolean;readonly task:Task;readonly event:StoredEvent; }
