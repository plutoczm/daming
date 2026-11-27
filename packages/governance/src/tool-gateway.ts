import { randomUUID } from 'node:crypto';
import { canonicalJson } from '@daming/core';
import type { Engine,EffectOutcome,JsonValue,OutboxEffect } from '@daming/core';
import type { CostLedger } from './cost-ledger.ts';
import type { Approvals } from './approval.ts';
import type { Execution,FixtureTool,ModelRequestTool,RealTool,GovernanceRepository,Operation,Reconciliation,ToolOutcome } from './model.ts';
import { GovernanceError } from './model.ts';
import { capabilityId,freeze,money,normalizeOperation,now,operationHash,text } from './binding.ts';
class PreflightDenied extends GovernanceError {}
interface RegisteredTool {id:string;version:string;kind:'fixture'|'real'|'model_request';execute:(operation:Readonly<Operation>,limits:{maximumCashMinor:number;expiresMs:number})=>Promise<ToolOutcome>;}
function definition(effect:OutboxEffect) {
  return {effectId:effect.effectId,taskId:effect.taskId,runId:effect.runId,attemptId:effect.attemptId,idempotencyKey:effect.idempotencyKey,kind:effect.kind,payload:effect.payload,semantics:effect.semantics};
}
function receipt(input:ToolOutcome):ToolOutcome {
  try {
    const value=JSON.parse(canonicalJson(input)) as ToolOutcome;
    if(!value||!['succeeded','not_executed','unknown'].includes(value.status))throw new GovernanceError('invalid_receipt');
    if(value.status==='succeeded'){money(value.actualCashMinor);if(!Object.hasOwn(value,'result'))throw new GovernanceError('invalid_receipt');}
    else text(value.reason);
    return value;
  } catch {return {status:'unknown',reason:'unreliable_receipt'};}
}
export class ToolGateway {
  private readonly repo:GovernanceRepository;private readonly engine:Engine;private readonly ledger:CostLedger;private readonly approvals:Approvals;private readonly clock:()=>number;
  private readonly tools=new Map<string,RegisteredTool>();
  constructor(repo:GovernanceRepository,engine:Engine,ledger:CostLedger,approvals:Approvals,clock:()=>number,tools:readonly FixtureTool[],modelTools:readonly ModelRequestTool[]=[],realTools:readonly RealTool[]=[]) {
    this.repo=repo;this.engine=engine;this.ledger=ledger;this.approvals=approvals;this.clock=clock;
    for(const tool of tools) {
      text(tool.id);text(tool.version);
      if(tool.fixtureOnly!==true||typeof tool.execute!=='function'||this.tools.has(tool.id))throw new GovernanceError('unverified_or_duplicate_tool');
      this.tools.set(tool.id,Object.freeze({id:tool.id,version:tool.version,kind:'fixture',execute:tool.execute}));
    }
    for(const tool of realTools) {
      text(tool.id);text(tool.version);
      if(tool.realExecution!==true||typeof tool.execute!=='function'||this.tools.has(tool.id))throw new GovernanceError('unverified_or_duplicate_real_tool');
      const handler=tool.execute;
      this.tools.set(tool.id,Object.freeze({id:tool.id,version:tool.version,kind:'real',execute:(op:Readonly<Operation>,limits:{maximumCashMinor:number;expiresMs:number})=>{
        if(op.operationKind==='model_request'||op.executorKind==='fixture')throw new GovernanceError('real_executor_required');
        return handler(op,{maximumCashMinor:limits.maximumCashMinor});
      }}));
    }
    for(const tool of modelTools){
      text(tool.id);text(tool.version);
      if(tool.operationKind!=='model_request'||typeof tool.execute!=='function'||this.tools.has(tool.id))throw new GovernanceError('unverified_or_duplicate_tool');
      const handler=tool.execute;
      this.tools.set(tool.id,Object.freeze({id:tool.id,version:tool.version,kind:'model_request',execute:(op:Readonly<Operation>,limits:{maximumCashMinor:number;expiresMs:number})=>{
        if(op.operationKind!=='model_request')throw new GovernanceError('model_operation_required');
        return handler(op,limits);
      }}));
    }
  }
  private authoritative(input:OutboxEffect):OutboxEffect {
    const stored=this.repo.getEffect(input.effectId);
    if(!stored||stored.attempts!==input.attempts||canonicalJson(definition(stored))!==canonicalJson(definition(input)))throw new GovernanceError('outbox_identity_mismatch');
    if(stored.kind!=='governance.tool'||stored.semantics!=='non_idempotent')throw new GovernanceError('unsupported_effect_contract');
    return stored;
  }
  private operation(effect:OutboxEffect):Operation {
    const payload=effect.payload;
    if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(key=>key!=='operation'))throw new GovernanceError('invalid_operation_envelope');
    const op=normalizeOperation(payload.operation as unknown as Operation);
    if(op.id!==effect.idempotencyKey||op.taskId!==effect.taskId||op.runId!==effect.runId||op.attemptId!==effect.attemptId)throw new GovernanceError('operation_identity_mismatch');
    return op;
  }
  async execute(input:OutboxEffect,token:string):Promise<EffectOutcome> {
    // No callback may execute under an enclosing savepoint rather than a committed transaction.
    try{this.repo.assertOutsideTransaction();}catch{throw new PreflightDenied('outer_transaction_forbidden');}
    let op:Operation|undefined;
    let prepared:{execution:Execution;tool:RegisteredTool;maximum:number;expiresMs:number}|{cached:EffectOutcome};
    try {
      prepared=this.repo.atomic(()=>{
        const effect=this.authoritative(input);op=this.operation(effect);
        const hash=operationHash(op);const id=capabilityId(token);
        const existing=this.repo.governanceGet('executions',op.id);
        if(existing) {
          if(existing.bindingHash!==hash||existing.capabilityId!==id||existing.effectId!==effect.effectId||existing.effectAttempt!==effect.attempts)throw new GovernanceError('execution_binding_mismatch');
          if(existing.status==='started'||!existing.outcome)throw new GovernanceError('execution_in_progress');
          return {cached:existing.outcome};
        }
        if(effect.status!=='executing')throw new GovernanceError('effect_not_claimed');
        const task=this.repo.getTask(op.taskId);
        if(!task||task.status!=='running'||task.runId!==op.runId||task.attemptId!==op.attemptId)throw new GovernanceError('task_not_authorized_for_execution');
        const tool=this.tools.get(op.toolId);
        const expectedKind=op.operationKind==='model_request'?'model_request':op.executorKind==='fixture'?'fixture':'real';
        if(!tool||tool.version!==op.toolVersion||tool.kind!==expectedKind)throw new GovernanceError('executor_or_tool_boundary_unverified');
        const quote=this.ledger.quote(op);if(op.operationKind==='model_request'&&quote.billingSource!=='official_api')throw new GovernanceError('model_quote_requires_official_api');const approval=this.approvals.check(op,token);
        const reservation=this.ledger.reserve(op);
        if(reservation.status!=='reserved')throw new GovernanceError('reservation_not_open');
        this.approvals.consume(approval);
        const execution:Execution={id:op.id,taskId:op.taskId,version:1,operation:op,bindingHash:hash,capabilityId:id,effectId:effect.effectId,effectAttempt:effect.attempts,status:'started'};
        this.repo.governancePut('executions',execution,null);
        this.repo.appendGovernanceAudit({taskId:op.taskId,operationId:op.id,type:'tool_started',atMs:now(this.clock),amountMinor:reservation.maximumCashMinor});
        return {execution,tool,maximum:reservation.maximumCashMinor,expiresMs:Math.min(quote.expiresMs,approval.expiresMs)};
      });
    } catch(error) {
      if(op&&this.repo.getTask(op.taskId))this.repo.atomic(()=>this.repo.appendGovernanceAudit({taskId:op!.taskId,operationId:op!.id,type:'denied',atMs:now(this.clock),detail:{code:error instanceof GovernanceError?error.code:'storage_failure'}}));
      if(error instanceof GovernanceError&&error.code!=='execution_in_progress')throw new PreflightDenied(error.code);
      throw error;
    }
    if('cached' in prepared)return JSON.parse(canonicalJson(prepared.cached)) as EffectOutcome;
    const execution=prepared.execution;
    let outcome:ToolOutcome;let expiredBeforeTool=false;
    try {
      const snapshot=freeze(JSON.parse(canonicalJson(execution.operation)) as Operation);
      const limits=freeze({maximumCashMinor:prepared.maximum,expiresMs:prepared.expiresMs});
      // Recheck after the durable commit and snapshot preparation, at the last tool entry.
      expiredBeforeTool=now(this.clock)>=prepared.expiresMs;
      outcome=expiredBeforeTool?{status:'not_executed',reason:'authorization_expired_before_tool'}:receipt(await prepared.tool.execute(snapshot,limits));
    }
    catch {outcome={status:'unknown',reason:'unreliable_receipt'};}
    return this.repo.atomic(()=>{
      const current=this.repo.governanceGet('executions',execution.id);
      if(!current||current.status!=='started'||current.version!==execution.version)throw new GovernanceError('execution_changed_before_settlement');
      let result:EffectOutcome;let status:Execution['status'];
      if(outcome.status==='succeeded') {
        const reservation=this.ledger.settle(execution.id,outcome.actualCashMinor);
        if(reservation.status==='breached'){result={status:'unknown',reason:'cash_bound_breached'};status='needs_reconciliation';}
        else {result={status:'succeeded',result:{toolResult:outcome.result,governance:{operationId:execution.id,actualCashMinor:outcome.actualCashMinor,routeMode:reservation.route.mode,billingSource:reservation.billingSource}}};status='settled';}
      } else if(outcome.status==='not_executed') {
        this.ledger.release(execution.id);result={status:'not_executed',reason:expiredBeforeTool?'authorization_expired_before_tool':'tool_confirmed_not_executed',retryable:false};status='not_executed';
      } else {this.ledger.markUnknown(execution.id);result={status:'unknown',reason:'tool_outcome_unknown'};status='needs_reconciliation';}
      this.engine.settleEffect(execution.effectId,execution.effectAttempt,result,new Date(now(this.clock)).toISOString());
      this.repo.governancePut('executions',{...current,version:current.version+1,status,outcome:result,...(outcome.status==='unknown'&&outcome.observation!==undefined?{observation:outcome.observation}:{})},current.version);
      this.repo.appendGovernanceAudit({taskId:execution.taskId,operationId:execution.id,type:status==='needs_reconciliation'?'tool_unknown':'tool_settled',atMs:now(this.clock)});
      return result;
    });
  }
  executor(resolveCapability:(effectId:string)=>string|undefined):(effect:OutboxEffect)=>Promise<EffectOutcome> {
    return async effect=>{
      try {return await this.execute(effect,resolveCapability(effect.effectId)??'');}
      catch(error) {
        return error instanceof PreflightDenied?{status:'not_executed',reason:'gateway_denied:'+error.code,retryable:false}:{status:'unknown',reason:'gateway_internal_failure'};
      }
    };
  }
  recoverInterrupted():void {
    this.repo.assertOutsideTransaction();
    for(const execution of this.repo.governanceList('executions'))if(execution.status==='started')this.repo.atomic(()=>{
      const current=this.repo.governanceGet('executions',execution.id);
      if(!current||current.status!=='started')return;
      this.ledger.markUnknown(current.id);
      const outcome:EffectOutcome={status:'unknown',reason:'governance_host_interrupted'};
      const effect=this.repo.getEffect(current.effectId);
      if(effect?.status==='executing'&&effect.attempts===current.effectAttempt)this.engine.settleEffect(current.effectId,current.effectAttempt,outcome,new Date(now(this.clock)).toISOString());
      this.repo.governancePut('executions',{...current,version:current.version+1,status:'needs_reconciliation',outcome},current.version);
      this.repo.appendGovernanceAudit({taskId:current.taskId,operationId:current.id,type:'recovery_unknown',atMs:now(this.clock)});
    });
  }
  reconcile(operationId:string,input:Reconciliation):void {
    this.repo.assertOutsideTransaction();text(input.evidence);
    if(!['succeeded','not_executed'].includes(input.resolution))throw new GovernanceError('invalid_reconciliation');
    if(input.resolution==='succeeded')money(input.actualCashMinor);
    const result=input.result===undefined?null:JSON.parse(canonicalJson(input.result)) as JsonValue;
    this.repo.atomic(()=>{
      const execution=this.repo.governanceGet('executions',operationId);
      if(!execution||execution.status!=='needs_reconciliation')throw new GovernanceError('execution_not_awaiting_reconciliation');
      if(input.resolution==='succeeded')this.ledger.settle(operationId,input.actualCashMinor!);
      else this.ledger.release(operationId);
      const task=this.repo.getTask(execution.taskId)!;
      this.engine.execute({type:'reconcile_effect',context:{taskId:task.taskId,runId:task.runId,attemptId:task.attemptId,sourceId:task.sourceId,eventId:'governance-reconcile-'+randomUUID(),occurredAt:new Date(now(this.clock)).toISOString()},expectedVersion:task.version,effectId:execution.effectId,resolution:input.resolution,evidence:input.evidence,...(input.resolution==='succeeded'?{result}:{})});
      // Preserve the original tool receipt for replay; reconciliation is a separate audited fact.
      this.repo.governancePut('executions',{...execution,version:execution.version+1,status:input.resolution==='succeeded'?'settled':'not_executed'},execution.version);
      this.repo.appendGovernanceAudit({taskId:execution.taskId,operationId,type:'reconciled',atMs:now(this.clock),...(input.actualCashMinor!==undefined?{amountMinor:input.actualCashMinor}:{}),detail:{evidence:input.evidence,resolution:input.resolution}});
    });
  }
}
