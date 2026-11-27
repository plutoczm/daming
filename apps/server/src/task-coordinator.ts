import { randomUUID } from 'node:crypto';
import { canonicalJson } from '@daming/core';
import type { Engine, Task, TaskState, WorkflowAction, WorkflowPlan } from '@daming/core';
import { readySteps,validateWorkflowPlan } from '@daming/planning';
import { auditAssignment } from '@daming/auditor';
import { createGovernance } from '@daming/governance';
import type { Operation, Reconciliation, ToolOperation } from '@daming/governance';
import { Outbox } from '@daming/store-sqlite';
import type { SqliteStore } from '@daming/store-sqlite';
import { routeWorkers } from '@daming/workers';
import { checkDelivery,workflowFixture,workflowReal } from './workflow-fixture.ts';
import type { CashSnapshot,FixtureRegistration } from './workflow-fixture.ts';
export class TaskCoordinator {
 private readonly store:SqliteStore;private readonly engine:Engine;
 private readonly workers:Map<string,FixtureRegistration>;
 private readonly governance:ReturnType<typeof createGovernance>;private readonly tokens=new Map<string,string>();
 private readonly advancing=new Set<string>();private readonly authorization:'synthetic-approved'|'deny';
 private readonly executionMode:'fixture'|'real';readonly approvalMode:'auto'|'manual';
 readonly observations:{operationId:string;active:number;heldMinor:number;approvalConsumed:boolean}[]=[];
 readonly externalModelRequests=0;
 constructor(options:{store:SqliteStore;engine:Engine;workers:FixtureRegistration[];authorization:'synthetic-approved'|'deny';executionMode?:'fixture'|'real';approvalMode?:'auto'|'manual';cashSnapshot?:CashSnapshot}){
  this.store=options.store;this.engine=options.engine;this.authorization=options.authorization;this.executionMode=options.executionMode??'fixture';this.approvalMode=options.approvalMode??'auto';
  this.workers=new Map(options.workers.map(r=>[r.descriptor.id,{...r,descriptor:structuredClone(r.descriptor)}]));if(this.workers.size!==options.workers.length)throw new Error('Duplicate fixture Worker');
  const observe=(op:Readonly<Operation>)=>{const heldMinor=this.store.governanceGet('budgets',op.taskId)!.heldMinor;const approvalConsumed=this.store.governanceList('approvals',op.taskId).some(a=>a.operationId===op.id&&a.status==='consumed');const active=this.store.effectsForTask(op.taskId).filter(e=>e.status==='executing').length;this.observations.push({operationId:op.id,active,heldMinor,approvalConsumed});};
  const tool=workflowFixture(this.workers,observe);
  const realTool=workflowReal(this.workers,observe,options.cashSnapshot);
  this.governance=createGovernance({repository:this.store,engine:this.engine,tools:[tool],realTools:[realTool]});
 }
 private task(id:string):Task{const t=this.engine.getTask(id);if(!t)throw new Error('Unknown task');return t;}
 private context(t:Task,eventId:string=randomUUID()){return {taskId:t.taskId,runId:t.runId,attemptId:t.attemptId,sourceId:t.sourceId,eventId,occurredAt:new Date().toISOString()};}
 private command(id:string,action:WorkflowAction,eventId?:string){const t=this.task(id);return this.engine.execute({type:'workflow',context:this.context(t,eventId),expectedVersion:t.version,action});}
 private transition(id:string,to:TaskState,reason?:string){const t=this.task(id);return this.engine.execute({type:'transition_task',context:this.context(t),expectedVersion:t.version,to,...(reason?{reason}:{})});}
 createTask(input:{taskId:string;title:string;goal:string;plan:WorkflowPlan;limitMinor:number}):Task{
  validateWorkflowPlan(input.plan);for(const c of input.plan.candidates){const r=this.workers.get(c.id)?.descriptor;if(!r||(c.executionMode??'fixture')!==r.executionMode||c.version!==r.runtime||c.executorKind!==r.executorKind||c.provider!==r.provider||c.model!==r.model||c.routeMode!==r.routeMode||c.concurrencyLimit!==r.concurrencyLimit)throw new Error('Frozen candidate identity mismatch');}
  const context={taskId:input.taskId,runId:randomUUID(),attemptId:randomUUID(),sourceId:'host:workflow',eventId:randomUUID(),occurredAt:new Date().toISOString()};
  // Local synchronous operations roll back together, including the initial budget.
  this.store.atomic(()=>{this.engine.execute({type:'create_task',context,title:input.title,goal:input.goal});this.command(input.taskId,{kind:'install',plan:input.plan});this.governance.admin.setBudget(input.taskId,input.limitMinor);if(this.approvalMode==='manual'){this.transition(input.taskId,'awaiting_approval','awaiting_human_approval');}else{this.transition(input.taskId,'queued');this.transition(input.taskId,'running');}});return this.task(input.taskId);
 }
 /** Explicit human approval for a task waiting at awaiting_approval; only Host/UI may call this. */
 approve(id:string):Task{
  const t=this.task(id);if(t.status!=='awaiting_approval')throw new Error('Task is not awaiting approval');
  this.store.atomic(()=>{this.transition(id,'queued','human_approved');this.transition(id,'running');});return this.task(id);
 }
 private owns(id:string):boolean {
  const t=this.task(id),w=t.workflow;if(!w)throw new Error('Not a workflow task');
  const mismatch=t.sourceId!=='host:workflow'||w.assignments.some(a=>a.taskId!==t.taskId||a.runId!==t.runId||a.attemptId!==t.attemptId)||w.plan.candidates.some(c=>{const d=this.workers.get(c.id)?.descriptor;return !d||(c.executionMode??'fixture')!==d.executionMode||c.version!==d.runtime||c.executorKind!==d.executorKind||c.provider!==d.provider||c.model!==d.model||c.routeMode!==d.routeMode||c.concurrencyLimit!==d.concurrencyLimit;});
  if(mismatch){if(!['cancelled','failed','completed','blocked'].includes(t.status))this.transition(id,'blocked','workflow_source_or_candidate_identity_changed');return false;}return true;
 }
 queueReady(id:string):number {
  let count=0;if(!this.owns(id))return 0;const first=this.task(id);if(first.status!=='running'||!first.workflow)return 0;if(this.store.dispatchBlockers(id).length){this.transition(id,'blocked','unresolved_governance');return 0;}
  for(const step of readySteps(first.workflow)){
   const t=this.task(id);const w=t.workflow!;const active=w.assignments.filter(a=>!a.delivery&&!['failed','cancelled'].includes(this.store.getEffect(a.effectId)?.status??'pending')).length;if(active>=w.policy.concurrency)break;
   const frozen=w.plan.candidates.find(c=>c.id===step.workerId)!;const registered=this.workers.get(step.workerId);if(!registered||registered.descriptor.runtime!==frozen.version){this.transition(id,'blocked','candidate_identity_changed');break;}
   const descriptor=structuredClone(registered.descriptor);descriptor.activeCount=this.store.workflowHistory().flatMap(t=>t.workflow!.assignments).filter(a=>a.workerId===descriptor.id&&!a.delivery&&!['failed','cancelled'].includes(this.store.getEffect(a.effectId)?.status??'pending')).length;
   const budget=this.governance.ledger.budget(id);if(!budget)throw new Error('Task budget missing');const ceiling=budget.limitMinor-budget.spentMinor-budget.heldMinor;
   const route=routeWorkers([descriptor],{os:'win32',provider:frozen.provider,model:frozen.model,routeMode:frozen.routeMode,capabilities:['text'],permissions:descriptor.executorKind==='local'?['workspace.read','workspace.write']:[],network:descriptor.network,dataScope:w.plan.category==='task8-project-agent-preview'?'workspace':'synthetic',maxCashMinor:ceiling,allowFixture:this.executionMode==='fixture',allowReal:this.executionMode==='real'});
   if(!route.selected){if(descriptor.activeCount>=descriptor.concurrencyLimit)continue;this.transition(id,'blocked','routing:'+canonicalJson(route.excluded));break;}
   const assignmentId=randomUUID(),sessionId=randomUUID(),effectId=randomUUID(),operationId=randomUUID();
   const stepAttempt=w.assignments.filter(a=>a.stepId===step.stepId).length+1;
   const real=this.executionMode==='real';
   const op:ToolOperation={id:operationId,taskId:id,runId:t.runId,attemptId:t.attemptId,executorKind:real?descriptor.executorKind:'fixture',toolId:real?'workflow.real':'workflow.fixture',toolVersion:'1',target:real?'real':'synthetic',payload:{assignmentId,sessionId,stepId:step.stepId,workerId:step.workerId,planVersion:w.plan.version,contractVersion:step.contract.version,stepAttempt,input:step.input},amountMinor:0,quoteId:randomUUID(),route:{mode:frozen.routeMode,provider:frozen.provider,model:frozen.model,accountRef:real?descriptor.executorKind:'fixture'}};
   const expiresMs=Date.now()+60000;this.governance.admin.issueQuote(op,descriptor.maxCashMinor!,expiresMs,real?(descriptor.billingSource??'subscription'):'fixture');
   if(this.authorization==='synthetic-approved')this.tokens.set(effectId,this.governance.admin.approve(op,expiresMs));
   this.command(id,{kind:'assign',stepId:step.stepId,workerId:step.workerId,assignmentId,sessionId,effect:{effectId,idempotencyKey:op.id,kind:'governance.tool',payload:{operation:JSON.parse(canonicalJson(op))},semantics:'non_idempotent'}});count++;
  }return count;
 }
 private ingest(id:string):boolean {
  let changed=false;for(const a of this.task(id).workflow!.assignments){if(!a.delivery&&this.store.getEffect(a.effectId)?.status==='succeeded'){try{this.command(id,{kind:'receive',assignmentId:a.assignmentId});changed=true;}catch(error){if(!['cancelled','failed','completed','blocked'].includes(this.task(id).status))this.transition(id,'blocked','receipt_identity_or_content_mismatch');throw error;}}}
  if(['cancelled','failed','completed'].includes(this.task(id).status))return changed;
  for(const a of this.task(id).workflow!.assignments){const w=this.task(id).workflow!;if(a.delivery&&!w.reviews.some(r=>r.assignmentId===a.assignmentId)){const receipts=checkDelivery(w,a);auditAssignment(w.plan,a,receipts);this.command(id,{kind:'review',assignmentId:a.assignmentId,receipts});changed=true;}}
  return changed;
 }
 async advance(id:string,options:{ingest?:boolean}={}):Promise<void>{
  if(this.advancing.has(id))throw new Error('Coordinator already advancing this task');this.advancing.add(id);
  try{
   if(!this.owns(id))return;
   if(this.ingest(id))return;
   if(this.task(id).status==='reviewing'){this.transition(id,'completed');return;}
   if(this.task(id).status!=='running')return;
   if(this.store.effectsForTask(id).some(e=>['executing','needs_reconciliation'].includes(e.status))){this.transition(id,'blocked','interrupted_or_unknown_requires_explicit_recovery');return;}
   this.command(id,{kind:'supervise'});this.queueReady(id);
   const pending=this.store.effectsForTask(id).filter(e=>e.status==='pending');
   const outbox=new Outbox(this.store,this.engine,()=>new Date().toISOString());
   await Promise.all(pending.map(()=>outbox.dispatchOne(this.governance.gateway.executor(effectId=>this.tokens.get(effectId)),id)));
   if(options.ingest!==false)this.ingest(id);
  }finally{this.advancing.delete(id);}
 }
 async run(id:string):Promise<Task>{if(!this.owns(id))return this.task(id);for(let i=0;i<1000;i++){const old=this.task(id);if(['blocked','failed','cancelled','completed'].includes(old.status)){this.ingest(id);return this.task(id);}await this.advance(id);const t=this.task(id);if(t.version===old.version||canonicalJson({status:t.status,assignments:t.workflow!.assignments,reviews:t.workflow!.reviews,policy:t.workflow!.policy})===canonicalJson({status:old.status,assignments:old.workflow!.assignments,reviews:old.workflow!.reviews,policy:old.workflow!.policy}))return t;if(t.status==='running'&&readySteps(t.workflow!).length===0&&t.workflow!.assignments.every(a=>a.delivery))return t;}throw new Error('Workflow iteration bound exceeded');}
 cancel(id:string):void{this.transition(id,'cancelled');for(const a of this.task(id).workflow!.assignments)if(!a.delivery)this.workers.get(a.workerId)?.worker.cancel(a.sessionId);}
 /** Human reconciliation of an unknown tool result; the Task stays blocked until explicitly resumed. */
 reconcile(id:string,operationId:string,input:Reconciliation):Task{
  const t=this.task(id);if(t.status!=='blocked')throw new Error('Task is not blocked');this.governance.admin.reconcile(operationId,input);return this.task(id);
 }
 /** Host must ensure ALL old dispatchers/tools using this store have stopped first. */
 recover(id:string,oldExecutorsStopped:boolean):Task {if(oldExecutorsStopped!==true||this.advancing.size)throw new Error('Confirm old executors stopped before recovery');if(!this.owns(id))return this.task(id);this.governance.admin.recoverInterrupted();new Outbox(this.store,this.engine,()=>new Date().toISOString()).recoverInterrupted();this.ingest(id);return this.task(id);}
}
