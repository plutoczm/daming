import { defaultPolicy,supervise } from './supervision.ts';
import type { CommandContext, EffectRequest, Task } from './model.ts';
import type { TaskRepository } from './ports.ts';
import { DomainError } from './errors.ts';
import { canonicalJson } from './json.ts';
import type { JsonValue } from './json.ts';
import { auditAssignment, bounded, latestAssignment, latestReview, readySteps, requireText, stepPassed, validateWorkflowPlan, workflowGroup } from './workflow.ts';
import type { Workflow, WorkflowAction, WorkflowAssignment } from './workflow.ts';
function object(v:JsonValue|undefined):Record<string,JsonValue>{if(!v||typeof v!=='object'||Array.isArray(v))throw new DomainError('Invalid workflow envelope');return v;}
export function workflowCommand(t:Task,action:WorkflowAction,c:CommandContext,repo:TaskRepository):{task:Task;effect?:EffectRequest}{
 if(!action||typeof action!=='object')throw new DomainError('Missing workflow action');
 if(action.kind==='install'){
  if(t.status!=='draft'||t.workflow)throw new DomainError('Plan is frozen');validateWorkflowPlan(action.plan);const plan=JSON.parse(canonicalJson(action.plan)) as typeof action.plan;
  const group=workflowGroup(plan);const history=repo.workflowHistory();const prior=history.filter(t=>t.workflow?.group===group).flatMap(t=>t.workflow!.decisions).sort((a,b)=>a.sequence-b.sequence).at(-1)?.next??defaultPolicy();const decision=supervise({tasks:history,cutoff:repo.nextSequence()-1},group,prior,true);const policy=decision.next;plan.steps.forEach(s=>s.maxReworks??=policy.maxReworks);
  const workflow:Workflow={plan,group:workflowGroup(plan),frozenSequence:repo.nextSequence(),policy,decisions:[decision],assignments:[],reviews:[]};return {task:{...t,status:'planned',workflow}};
 }
 const w=t.workflow;if(!w)throw new DomainError('Task has no workflow');if(action.kind!=='receive'&&['cancelled','completed','failed'].includes(t.status))throw new DomainError('Terminal workflow');
 if(action.kind==='supervise'){
  if(t.status!=='running'||repo.dispatchBlockers(t.taskId).length)return {task:t};
  const history=repo.workflowHistory();const prior=history.filter(t=>t.workflow?.group===w.group).flatMap(t=>t.workflow!.decisions).sort((a,b)=>a.sequence-b.sequence).at(-1)?.next??w.policy;const decision=supervise({tasks:history,cutoff:repo.nextSequence()-1},w.group,prior,false);decision.taskPrevious={...w.policy};w.policy=decision.next;w.decisions.push(decision);return {task:t};
 }
 if(action.kind==='assign'){
  if(t.status!=='running')throw new DomainError('Only running workflow can assign');if(repo.dispatchBlockers(t.taskId).length||repo.effectsForTask(t.taskId).some(e=>e.status==='needs_reconciliation'))throw new DomainError('Unresolved governance prevents dispatch');const s=readySteps(w).find(s=>s.stepId===action.stepId);if(!s||action.workerId!==s.workerId)throw new DomainError('Step not ready or worker changed');for(const v of [action.assignmentId,action.sessionId])requireText(v);
  if(w.assignments.some(a=>a.assignmentId===action.assignmentId||a.sessionId===action.sessionId))throw new DomainError('Duplicate assignment identity');if(w.assignments.filter(a=>!a.delivery&&!['failed','cancelled'].includes(repo.getEffect(a.effectId)?.status??'pending')).length>=w.policy.concurrency)throw new DomainError('Task concurrency exhausted');
  const worker=w.plan.candidates.find(c=>c.id===action.workerId)!;const active=repo.workflowHistory().flatMap(t=>t.workflow?.assignments??[]).filter(a=>!a.delivery&&a.workerId===worker.id&&!['failed','cancelled'].includes(repo.getEffect(a.effectId)?.status??'pending'));if(active.length>=worker.concurrencyLimit)throw new DomainError('Worker concurrency exhausted');
  const e=action.effect;if(e?.kind!=='governance.tool'||e.semantics!=='non_idempotent')throw new DomainError('Worker requires governed non-idempotent effect');const op=object(object(e.payload).operation);const input=object(op.payload);const stepAttempt=(latestAssignment(w,s.stepId)?.stepAttempt??0)+1;
  const expected={assignmentId:action.assignmentId,sessionId:action.sessionId,stepId:s.stepId,workerId:worker.id,planVersion:w.plan.version,contractVersion:s.contract.version,stepAttempt,input:s.input};
  const expectedTool=worker.executionMode==='real'
    ?{executorKind:worker.executorKind,toolId:'workflow.real',toolVersion:'1',target:'real',accountRef:worker.executorKind}
    :{executorKind:'fixture' as const,toolId:'workflow.fixture',toolVersion:'1',target:'synthetic',accountRef:'fixture'};
  if(canonicalJson(input)!==canonicalJson(expected)||op.id!==e.idempotencyKey||op.taskId!==t.taskId||op.runId!==t.runId||op.attemptId!==t.attemptId||op.executorKind!==expectedTool.executorKind||op.toolId!==expectedTool.toolId||op.toolVersion!==expectedTool.toolVersion||op.target!==expectedTool.target||canonicalJson(op.route)!==canonicalJson({mode:worker.routeMode,provider:worker.provider,model:worker.model,accountRef:expectedTool.accountRef}))throw new DomainError('Assignment operation binding mismatch');
  const occupied=repo.workflowHistory().flatMap(t=>t.workflow?.assignments??[]).filter(a=>!a.delivery&&!['failed','cancelled'].includes(repo.getEffect(a.effectId)?.status??'pending'));
  const available=w.plan.candidates.reduce((n,c)=>n+Math.min(readySteps(w).filter(s=>s.workerId===c.id).length,Math.max(0,c.concurrencyLimit-occupied.filter(a=>a.workerId===c.id).length)),0);
  const saturated=available+occupied.filter(a=>a.taskId===t.taskId).length>=w.policy.concurrency;
  const a:WorkflowAssignment={assignmentId:action.assignmentId,sessionId:action.sessionId,stepId:s.stepId,workerId:worker.id,taskId:t.taskId,runId:t.runId,attemptId:t.attemptId,planVersion:w.plan.version,contractVersion:s.contract.version,stepAttempt,effectId:e.effectId,operationId:e.idempotencyKey,dispatchedAt:c.occurredAt,concurrency:w.policy.concurrency,saturated};w.assignments.push(a);return {task:t,effect:e};
 }
 if(action.kind==='receive'){
  const a=w.assignments.find(a=>a.assignmentId===action.assignmentId);if(!a)throw new DomainError('Unknown assignment');if(a.delivery)return {task:t};const effect=repo.getEffect(a.effectId);if(effect?.status!=='succeeded')throw new DomainError('No durable success receipt');const result=object(effect.result);const d=object(result.toolResult);const gov=object(result.governance);
  for(const key of ['assignmentId','sessionId','taskId','runId','attemptId','planVersion','contractVersion','stepAttempt'] as const)if(d[key]!==a[key])throw new DomainError('Delivery identity mismatch');if(!['completed','failed','timed_out','cancelled'].includes(String(d.status)))throw new DomainError('Unreliable delivery');const artifacts=object(d.artifacts);bounded(gov.actualCashMinor,0,Number.MAX_SAFE_INTEGER);
  a.delivery={status:d.status as 'completed',artifacts,cashMinor:gov.actualCashMinor,startedAt:typeof d.startedAt==='string'?d.startedAt:a.dispatchedAt,endedAt:effect.updatedAt};return {task:t};
 }
 if(action.kind==='review'){
  const a=w.assignments.find(a=>a.assignmentId===action.assignmentId);if(!a||!Array.isArray(action.receipts))throw new DomainError('Unknown audit target');const old=latestReview(w,a.assignmentId);if(old&&old.verdict!=='needs_human')throw new DomainError('Review already final');const review={...auditAssignment(w.plan,a,action.receipts),reviewId:a.assignmentId+'/review/'+(w.reviews.length+1),sequence:repo.nextSequence()};w.reviews.push(review);
  if(review.verdict==='needs_human'||review.verdict==='fail'&&a.stepAttempt>w.plan.steps.find(s=>s.stepId===a.stepId)!.maxReworks!)t={...t,status:'blocked',blockedReason:'workflow_review:'+review.verdict+':'+a.stepId};else if(w.plan.steps.every(s=>stepPassed(w,s.stepId))&&t.status==='running')t={...t,status:'reviewing'};return {task:t};
 }
 throw new DomainError('Unknown workflow action');
}
