import type { BillingSource,Budget,GovernanceRepository,Operation,Quote,Reservation,UnknownHoldReduction } from './model.ts';
import { GovernanceError } from './model.ts';
import { add,subtract,money,normalizeOperation,operationHash,now,text } from './binding.ts';
function currentHold(reservation:Reservation):number {
  const held=reservation.heldCashMinor??reservation.maximumCashMinor;
  money(held);
  if(held>reservation.maximumCashMinor)throw new GovernanceError('invalid_remaining_hold');
  return held;
}
export class CostLedger {
  private readonly repo:GovernanceRepository;private readonly clock:()=>number;
  constructor(repo:GovernanceRepository,clock:()=>number){this.repo=repo;this.clock=clock;}
  budget(taskId:string):Budget|undefined{return this.repo.governanceGet('budgets',taskId);}
  setBudget(taskId:string,limitMinor:number):Budget {
    money(limitMinor);
    return this.repo.atomic(()=>{
      if(!this.repo.getTask(taskId))throw new GovernanceError('task_missing');
      const old=this.budget(taskId);
      if(old&&limitMinor<add(old.spentMinor,old.heldMinor))throw new GovernanceError('limit_below_commitment');
      const budget:Budget={id:taskId,taskId,version:(old?.version??0)+1,currency:'CNY',limitMinor,spentMinor:old?.spentMinor??0,heldMinor:old?.heldMinor??0,breached:false};
      this.repo.governancePut('budgets',budget,old?.version??null);
      this.repo.appendGovernanceAudit({taskId,type:'budget_set',atMs:now(this.clock),amountMinor:limitMinor});return budget;
    });
  }
  issueQuote(input:Operation,maximumCashMinor:number|null,expiresMs:number,billingSource:BillingSource,comprehensiveEstimateMinor?:number):Quote {
    const operation=normalizeOperation(input);money(expiresMs);if(comprehensiveEstimateMinor!==undefined)money(comprehensiveEstimateMinor);
    if(maximumCashMinor!==null){money(maximumCashMinor);if(maximumCashMinor<operation.amountMinor)throw new GovernanceError('quote_below_action_amount');}
    if(!['fixture','official_api','subscription','local'].includes(billingSource))throw new GovernanceError('unknown_billing_source');
    return this.repo.atomic(()=>{
      const task=this.repo.getTask(operation.taskId);
      if(!task||task.runId!==operation.runId||task.attemptId!==operation.attemptId)throw new GovernanceError('task_identity_mismatch');
      if(expiresMs<=now(this.clock)||this.repo.governanceGet('quotes',operation.quoteId))throw new GovernanceError('invalid_or_reused_quote');
      const quote:Quote={id:operation.quoteId,taskId:operation.taskId,version:1,bindingHash:operationHash(operation),maximumCashMinor,expiresMs,billingSource,...(comprehensiveEstimateMinor!==undefined?{comprehensiveEstimateMinor}:{})};
      this.repo.governancePut('quotes',quote,null);
      this.repo.appendGovernanceAudit({taskId:operation.taskId,operationId:operation.id,type:'quote_issued',atMs:now(this.clock),detail:{routeMode:operation.route.mode,billingSource}});return quote;
    });
  }
  quote(operation:Operation):Quote {
    const quote=this.repo.governanceGet('quotes',operation.quoteId);
    if(!quote||quote.taskId!==operation.taskId||quote.bindingHash!==operationHash(operation))throw new GovernanceError('quote_binding_mismatch');
    if(quote.expiresMs<=now(this.clock))throw new GovernanceError('quote_expired');
    if(quote.maximumCashMinor===null)throw new GovernanceError('unknown_price');
    money(quote.maximumCashMinor);return quote;
  }
  reserve(input:Operation):Reservation {
    const operation=normalizeOperation(input);
    return this.repo.atomic(()=>{
      const hash=operationHash(operation);const existing=this.repo.governanceGet('reservations',operation.id);
      if(existing){if(existing.bindingHash!==hash)throw new GovernanceError('reservation_binding_mismatch');return existing;}
      const quote=this.quote(operation);const maximum=quote.maximumCashMinor!;
      const budget=this.budget(operation.taskId);if(!budget)throw new GovernanceError('budget_missing');
      if(budget.breached||add(add(budget.spentMinor,budget.heldMinor),maximum)>budget.limitMinor)throw new GovernanceError('cash_limit');
      const reservation:Reservation={id:operation.id,taskId:operation.taskId,version:1,bindingHash:hash,maximumCashMinor:maximum,route:operation.route,billingSource:quote.billingSource,...(quote.comprehensiveEstimateMinor!==undefined?{comprehensiveEstimateMinor:quote.comprehensiveEstimateMinor}:{}),status:'reserved'};
      this.repo.governancePut('budgets',{...budget,version:budget.version+1,heldMinor:add(budget.heldMinor,maximum)},budget.version);
      this.repo.governancePut('reservations',reservation,null);
      this.repo.appendGovernanceAudit({taskId:operation.taskId,operationId:operation.id,type:'budget_reserved',atMs:now(this.clock),amountMinor:maximum});return reservation;
    });
  }
  markUnknown(id:string):Reservation {
    return this.repo.atomic(()=>{
      const r=this.repo.governanceGet('reservations',id);if(!r)throw new GovernanceError('reservation_missing');
      if(r.status==='unknown')return r;if(r.status!=='reserved')throw new GovernanceError('reservation_not_open');
      const next:Reservation={...r,version:r.version+1,status:'unknown'};this.repo.governancePut('reservations',next,r.version);return next;
    });
  }
  /** Trusted Host only: a bounded unknown expense stays unknown and cannot resume/replay work. */
  reduceUnknownHold(id:string,input:UnknownHoldReduction):Reservation {
    this.repo.assertOutsideTransaction();
    if(!input||input.executorStopped!==true)throw new GovernanceError('executor_stop_confirmation_required');
    money(input.remainingCashMinor);text(input.evidence);
    if(input.remainingCashMinor===0||input.evidence.length>8192)throw new GovernanceError('invalid_unknown_hold_reduction');
    return this.repo.atomic(()=>{
      const r=this.repo.governanceGet('reservations',id);
      if(!r||r.status!=='unknown')throw new GovernanceError('reservation_not_unknown');
      const execution=this.repo.governanceGet('executions',id);
      const effect=execution?this.repo.getEffect(execution.effectId):undefined;
      const task=this.repo.getTask(r.taskId);
      if(!execution||execution.status!=='needs_reconciliation'||execution.taskId!==r.taskId||execution.operation.id!==id||execution.bindingHash!==r.bindingHash||operationHash(execution.operation)!==r.bindingHash||!effect||effect.status!=='needs_reconciliation'||effect.taskId!==r.taskId||effect.attempts!==execution.effectAttempt||!task||task.status!=='blocked'||task.runId!==execution.operation.runId||task.attemptId!==execution.operation.attemptId)throw new GovernanceError('unknown_execution_not_quiescent');
      const previous=currentHold(r);
      if(input.remainingCashMinor>previous)throw new GovernanceError('unknown_hold_cannot_increase');
      if(input.remainingCashMinor===previous)return r;
      const released=subtract(previous,input.remainingCashMinor);
      const budget=this.budget(r.taskId)!;
      const next:Reservation={...r,version:r.version+1,heldCashMinor:input.remainingCashMinor};
      this.repo.governancePut('budgets',{...budget,version:budget.version+1,heldMinor:subtract(budget.heldMinor,released)},budget.version);
      this.repo.governancePut('reservations',next,r.version);
      this.repo.appendGovernanceAudit({taskId:r.taskId,operationId:id,type:'unknown_hold_reduced',atMs:now(this.clock),amountMinor:released,detail:{previousHeldMinor:previous,remainingHeldMinor:input.remainingCashMinor,originalMaximumCashMinor:r.maximumCashMinor,cashConfirmed:false,executorStopped:true,evidence:input.evidence}});
      return next;
    });
  }
  settle(id:string,actualCashMinor:number):Reservation {
    money(actualCashMinor);
    return this.repo.atomic(()=>{
      const r=this.repo.governanceGet('reservations',id);if(!r)throw new GovernanceError('reservation_missing');
      if(r.status==='settled'||r.status==='breached'){if(r.actualCashMinor!==actualCashMinor)throw new GovernanceError('settlement_conflict');return r;}
      if(!['reserved','unknown'].includes(r.status))throw new GovernanceError('reservation_not_open');
      const budget=this.budget(r.taskId)!;
      const committed=currentHold(r);const spent=add(budget.spentMinor,actualCashMinor);const held=subtract(budget.heldMinor,committed);
      const breach=actualCashMinor>committed||add(spent,held)>budget.limitMinor;
      const next:Reservation={...r,version:r.version+1,status:breach?'breached':'settled',actualCashMinor,...(r.heldCashMinor!==undefined?{heldCashMinor:0}:{})};
      this.repo.governancePut('budgets',{...budget,version:budget.version+1,spentMinor:spent,heldMinor:held,breached:budget.breached||breach},budget.version);
      this.repo.governancePut('reservations',next,r.version);
      this.repo.appendGovernanceAudit({taskId:r.taskId,operationId:id,type:breach?'budget_breach':'budget_settled',atMs:now(this.clock),amountMinor:actualCashMinor});return next;
    });
  }
  release(id:string):Reservation {
    return this.repo.atomic(()=>{
      const r=this.repo.governanceGet('reservations',id);if(!r)throw new GovernanceError('reservation_missing');
      if(r.status==='released')return r;
      if(!['reserved','unknown'].includes(r.status))throw new GovernanceError('known_cost_cannot_be_erased');
      const budget=this.budget(r.taskId)!;const next:Reservation={...r,version:r.version+1,status:'released',actualCashMinor:0,...(r.heldCashMinor!==undefined?{heldCashMinor:0}:{})};
      this.repo.governancePut('budgets',{...budget,version:budget.version+1,heldMinor:subtract(budget.heldMinor,currentHold(r))},budget.version);
      this.repo.governancePut('reservations',next,r.version);
      this.repo.appendGovernanceAudit({taskId:r.taskId,operationId:id,type:'budget_released',atMs:now(this.clock),amountMinor:currentHold(r)});return next;
    });
  }
}
