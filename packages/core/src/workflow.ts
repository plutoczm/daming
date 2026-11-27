import type { JsonValue } from './json.ts';
import { canonicalJson } from './json.ts';
import { DomainError } from './errors.ts';
import type { EffectRequest, Task } from './model.ts';
export interface WorkflowCandidate {id:string;executorKind:'dsh'|'codex'|'claude-code'|'local';executionMode?:'fixture'|'real';version:string;provider:string;model:string;routeMode:'native'|'magpie';concurrencyLimit:number;}
export interface AcceptanceCheck {id:string;version:number;artifactId:string;kind:'present'|'json_equals'|'test';expected?:JsonValue;}
export interface AcceptanceContract {version:number;checks:AcceptanceCheck[];}
export interface WorkflowStep {stepId:string;description:string;dependsOn:string[];workerId:string;input:string;maxReworks?:number;contract:AcceptanceContract;}
export interface WorkflowPlan {planId:string;version:number;category:string;policyVersion:'supervisor-v1';candidates:WorkflowCandidate[];steps:WorkflowStep[];}
export interface PolicyState {concurrency:number;maxReworks:number;mode:'stable'|'trial';lastChangeSequence:number;previousConcurrency?:number;trialStartSequence?:number;reworkMode?:'probe'|'measured';}
export interface PolicyDecision {taskPrevious?:PolicyState;sequence:number;group:string;historyCutoff:number;previous:PolicyState;next:PolicyState;reason:string;samples:string[];metrics:JsonValue;}
export interface WorkflowDelivery {status:'completed'|'failed'|'timed_out'|'cancelled';artifacts:Record<string,JsonValue>;cashMinor?:number;startedAt:string;endedAt:string;}
export interface WorkflowAssignment {assignmentId:string;sessionId:string;stepId:string;workerId:string;taskId:string;runId:string;attemptId:string;planVersion:number;contractVersion:number;stepAttempt:number;effectId:string;operationId:string;dispatchedAt:string;concurrency:number;saturated?:boolean;delivery?:WorkflowDelivery;}
export interface CheckReceipt {assignmentId:string;sessionId:string;taskId:string;runId:string;attemptId:string;planVersion:number;contractVersion:number;artifactVersion:number;checkId:string;checkVersion:number;checkerId:string;status:'pass'|'fail'|'unknown';}
export interface WorkflowReview {reviewId:string;assignmentId:string;contractVersion:number;artifactVersion:number;verdict:'pass'|'fail'|'needs_human';reasons:string[];receipts:CheckReceipt[];sequence:number;}
export interface Workflow {plan:WorkflowPlan;group:string;frozenSequence:number;policy:PolicyState;decisions:PolicyDecision[];assignments:WorkflowAssignment[];reviews:WorkflowReview[];}
export type WorkflowAction={kind:'install';plan:WorkflowPlan}|{kind:'assign';stepId:string;workerId:string;assignmentId:string;sessionId:string;effect:EffectRequest}|{kind:'receive';assignmentId:string}|{kind:'review';assignmentId:string;receipts:CheckReceipt[]}|{kind:'supervise'};
export interface SupervisionHistory {tasks:Task[];cutoff:number;}
export function requireText(v:unknown):asserts v is string {if(typeof v!=='string'||!v.trim())throw new DomainError('Expected nonempty workflow text');}
export function bounded(v:unknown,min:number,max:number):asserts v is number {if(!Number.isSafeInteger(v)||Number(v)<min||Number(v)>max)throw new DomainError('Workflow value outside bounds');}
export function validateWorkflowPlan(p:WorkflowPlan):void {
 if(!p||typeof p!=='object')throw new DomainError('Missing workflow plan');
 for(const v of [p.planId,p.category])requireText(v);bounded(p.version,1,Number.MAX_SAFE_INTEGER);
 if(p.policyVersion!=='supervisor-v1'||!Array.isArray(p.steps)||!p.steps.length||p.steps.length>100||!Array.isArray(p.candidates)||!p.candidates.length)throw new DomainError('Invalid plan shape');
 const candidates=new Set<string>();for(const c of p.candidates){for(const v of [c.id,c.version,c.provider,c.model])requireText(v);if(candidates.has(c.id)||!['dsh','codex','claude-code','local'].includes(c.executorKind)||!['native','magpie'].includes(c.routeMode)||(c.executionMode!==undefined&&!['fixture','real'].includes(c.executionMode)))throw new DomainError('Invalid candidate');bounded(c.concurrencyLimit,1,100);candidates.add(c.id);}
 const ids=new Set(p.steps.map(s=>s.stepId));if(ids.size!==p.steps.length)throw new DomainError('Duplicate step');
 for(const s of p.steps){requireText(s.stepId);requireText(s.description);if(typeof s.input!=='string'||!candidates.has(s.workerId)||!Array.isArray(s.dependsOn)||new Set(s.dependsOn).size!==s.dependsOn.length||s.dependsOn.some(d=>!ids.has(d)||d===s.stepId))throw new DomainError('Invalid step dependencies or worker');if(s.maxReworks!==undefined)bounded(s.maxReworks,0,2);bounded(s.contract?.version,1,Number.MAX_SAFE_INTEGER);if(!Array.isArray(s.contract.checks)||!s.contract.checks.length)throw new DomainError('Empty acceptance checks');const seen=new Set<string>();for(const c of s.contract.checks){requireText(c.id);requireText(c.artifactId);bounded(c.version,1,Number.MAX_SAFE_INTEGER);if(seen.has(c.id)||!['present','json_equals','test'].includes(c.kind)||c.kind==='json_equals'&&!Object.hasOwn(c,'expected'))throw new DomainError('Invalid acceptance check');seen.add(c.id);}}
 const visited=new Set<string>();const visiting=new Set<string>();const visit=(id:string)=>{if(visiting.has(id))throw new DomainError('Cyclic workflow');if(visited.has(id))return;visiting.add(id);p.steps.find(s=>s.stepId===id)!.dependsOn.forEach(visit);visiting.delete(id);visited.add(id);};p.steps.forEach(s=>visit(s.stepId));canonicalJson(p);
}
export function workflowGroup(plan:WorkflowPlan):string {return canonicalJson({category:plan.category,policyVersion:plan.policyVersion,candidates:[...plan.candidates].sort((a,b)=>a.id.localeCompare(b.id)),contracts:plan.steps.map(s=>({stepId:s.stepId,contract:s.contract})).sort((a,b)=>a.stepId.localeCompare(b.stepId))});}
export function latestAssignment(w:Workflow,stepId:string){return w.assignments.filter(a=>a.stepId===stepId).at(-1);}
export function latestReview(w:Workflow,id:string){return w.reviews.filter(r=>r.assignmentId===id).at(-1);}
export function stepPassed(w:Workflow,id:string):boolean {const a=latestAssignment(w,id);return !!a&&latestReview(w,a.assignmentId)?.verdict==='pass';}
export function readySteps(w:Workflow):WorkflowStep[]{return w.plan.steps.filter(s=>{if(!s.dependsOn.every(d=>stepPassed(w,d)))return false;const a=latestAssignment(w,s.stepId);if(!a)return true;const r=latestReview(w,a.assignmentId);return r?.verdict==='fail'&&a.stepAttempt<=s.maxReworks!;}).sort((a,b)=>a.stepId<b.stepId?-1:1);}
export function auditAssignment(p:WorkflowPlan,a:WorkflowAssignment,receipts:CheckReceipt[]):Omit<WorkflowReview,'reviewId'|'sequence'> {
 const s=p.steps.find(s=>s.stepId===a.stepId);if(!s||!a.delivery)throw new DomainError('No delivery for audit');const reasons:string[]=[];let human=false;let fail=false;
 if(a.delivery.status==='failed'||a.delivery.status==='timed_out'){fail=true;reasons.push('known_execution_failure');}
 else if(a.delivery.status!=='completed'){human=true;reasons.push('cancelled_execution');}
 else for(const c of s.contract.checks){if(!Object.hasOwn(a.delivery.artifacts,c.artifactId)){fail=true;reasons.push('missing_artifact:'+c.artifactId);continue;}const rs=receipts.filter(r=>r.checkId===c.id);const r=rs[0];
  if(rs.length!==1||!r||r.assignmentId!==a.assignmentId||r.sessionId!==a.sessionId||r.taskId!==a.taskId||r.runId!==a.runId||r.attemptId!==a.attemptId||r.planVersion!==a.planVersion||r.contractVersion!==a.contractVersion||r.artifactVersion!==a.stepAttempt||r.checkVersion!==c.version||r.checkerId!=='host:'+c.id||!['pass','fail','unknown'].includes(r.status)){human=true;reasons.push('untrusted_check:'+c.id);continue;}
  if(r.status==='unknown'){human=true;reasons.push('unknown_check:'+c.id);}else if(r.status==='fail'){fail=true;reasons.push('failed_check:'+c.id);}if(c.kind==='json_equals'&&canonicalJson(a.delivery.artifacts[c.artifactId])!==canonicalJson(c.expected!)){fail=true;reasons.push('content_mismatch:'+c.id);}}
 return {assignmentId:a.assignmentId,contractVersion:a.contractVersion,artifactVersion:a.stepAttempt,verdict:human?'needs_human':fail?'fail':'pass',reasons,receipts};
}
