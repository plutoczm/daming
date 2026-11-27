import type { EffectOutcome,JsonValue,OutboxEffect,Task } from '@daming/core';
export class GovernanceError extends Error {readonly code:string;constructor(code:string){super(code);this.code=code;}}
interface OperationBase {
  readonly id:string;readonly taskId:string;readonly runId:string;readonly attemptId:string;
  readonly toolId:string;readonly toolVersion:string;readonly target:string;readonly payload:JsonValue;
  readonly amountMinor:number;readonly quoteId:string;
  readonly route:{readonly mode:'native'|'magpie';readonly provider:string;readonly model:string;readonly accountRef:string};
}
export interface ToolOperation extends OperationBase {readonly executorKind:'fixture'|'dsh'|'codex'|'claude-code'|'local';readonly operationKind?:never;}
export interface ModelRequestOperation extends OperationBase {readonly operationKind:'model_request';readonly executorKind?:never;}
export type Operation=ToolOperation|ModelRequestOperation;
export type BillingSource='fixture'|'official_api'|'subscription'|'local';
interface RecordBase {readonly id:string;readonly taskId:string;readonly version:number;}
export interface Budget extends RecordBase {readonly currency:'CNY';readonly limitMinor:number;readonly spentMinor:number;readonly heldMinor:number;readonly breached:boolean;}
export interface Quote extends RecordBase {readonly bindingHash:string;readonly maximumCashMinor:number|null;readonly comprehensiveEstimateMinor?:number;readonly expiresMs:number;readonly billingSource:BillingSource;}
export interface Approval extends RecordBase {readonly operationId:string;readonly bindingHash:string;readonly expiresMs:number;readonly status:'active'|'revoked'|'consumed';}
export interface Reservation extends RecordBase {
  readonly bindingHash:string;readonly maximumCashMinor:number;readonly comprehensiveEstimateMinor?:number;readonly actualCashMinor?:number;
  /** Current hold after an audited reduction; absent legacy records retain their original maximum while open. */
  readonly heldCashMinor?:number;
  readonly route:Operation['route'];readonly billingSource:BillingSource;
  readonly status:'reserved'|'unknown'|'settled'|'released'|'breached';
}
export interface Execution extends RecordBase {
  readonly operation:Operation;readonly bindingHash:string;readonly capabilityId:string;
  readonly effectId:string;readonly effectAttempt:number;
  readonly status:'started'|'needs_reconciliation'|'settled'|'not_executed';
  readonly outcome?:EffectOutcome;readonly observation?:JsonValue;
}
export interface GovRecords {budgets:Budget;quotes:Quote;approvals:Approval;reservations:Reservation;executions:Execution;}
export interface GovernanceAudit {readonly sequence?:number;readonly taskId:string;readonly operationId?:string;readonly type:string;readonly atMs:number;readonly amountMinor?:number;readonly detail?:JsonValue;}
export interface GovernanceRepository {
  atomic<T>(work:()=>T):T;assertOutsideTransaction():void;
  getTask(id:string):Task|undefined;getEffect(id:string):OutboxEffect|undefined;
  governanceGet<K extends keyof GovRecords>(collection:K,id:string):GovRecords[K]|undefined;
  governancePut<K extends keyof GovRecords>(collection:K,value:GovRecords[K],expectedVersion:number|null):void;
  governanceList<K extends keyof GovRecords>(collection:K,taskId?:string):GovRecords[K][];
  appendGovernanceAudit(event:GovernanceAudit):void;
  listGovernanceAudit(taskId:string):GovernanceAudit[];
}
export type ToolOutcome={readonly status:'succeeded';readonly actualCashMinor:number;readonly result:JsonValue}|{readonly status:'not_executed';readonly reason:string}|{readonly status:'unknown';readonly reason:string;readonly observation?:JsonValue};
export interface FixtureTool {readonly id:string;readonly version:string;readonly fixtureOnly:true;readonly execute:(operation:Readonly<Operation>,limits:{readonly maximumCashMinor:number})=>Promise<ToolOutcome>;}
/** Host-registered real executor tool; never exposed to Workers or Web. */
export interface RealTool {readonly id:string;readonly version:string;readonly realExecution:true;readonly execute:(operation:Readonly<ToolOperation>,limits:{readonly maximumCashMinor:number})=>Promise<ToolOutcome>;}
export interface ModelRequestTool {readonly id:string;readonly version:string;readonly operationKind:'model_request';readonly execute:(operation:Readonly<ModelRequestOperation>,limits:{readonly maximumCashMinor:number;readonly expiresMs:number})=>Promise<ToolOutcome>;}
export interface Reconciliation {readonly resolution:'succeeded'|'not_executed';readonly evidence:string;readonly actualCashMinor?:number;readonly result?:JsonValue;}

export interface UnknownHoldReduction {readonly remainingCashMinor:number;readonly evidence:string;readonly executorStopped:true;}
