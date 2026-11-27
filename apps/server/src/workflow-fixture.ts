import { canonicalJson } from '@daming/core';
import type { CheckReceipt, JsonValue, Workflow, WorkflowAssignment } from '@daming/core';
import type { FixtureTool, Operation, RealTool } from '@daming/governance';
import type { WorkerDescriptor, WorkerSession } from '@daming/workers';
import { estimateDeepseekCashMinor } from './deepseek-price.ts';
export interface FixtureRegistration {descriptor:WorkerDescriptor;worker:WorkerSession;behavior?:'echo'|'first_invalid'|'invalid'|'unknown';}
export function workflowFixture(registrations:ReadonlyMap<string,FixtureRegistration>,observe:(op:Readonly<Operation>)=>void):FixtureTool {
 return {id:'workflow.fixture',version:'1',fixtureOnly:true,execute:async op=>{
  const p=op.payload as Record<string,JsonValue>;const registration=registrations.get(String(p.workerId));if(!registration)return {status:'not_executed',reason:'unregistered_fixture'};
  const {worker}=registration;const startedAt=new Date().toISOString();observe(op);
  const context={sessionId:String(p.sessionId),taskId:op.taskId,runId:op.runId,attemptId:op.attemptId,workspace:'synthetic-workspace',input:{text:String(p.input)}};
  worker.createSession(context);const result=await worker.run(context.sessionId);
  for(const k of ['sessionId','taskId','runId','attemptId'] as const)if(result[k]!==context[k])return {status:'unknown',reason:'worker_identity_mismatch'};
  if(registration.behavior==='unknown')return {status:'unknown',reason:'synthetic_unknown'};
  const artifacts:Record<string,JsonValue>={};if(result.status==='completed'){try{artifacts.result=JSON.parse(result.output) as JsonValue;}catch{artifacts.result=result.output;}}
  if(registration.behavior==='invalid'||registration.behavior==='first_invalid'&&p.stepAttempt===1)artifacts.result={invalid:true};
  return {status:'succeeded',actualCashMinor:1,result:{assignmentId:p.assignmentId,sessionId:p.sessionId,taskId:op.taskId,runId:op.runId,attemptId:op.attemptId,planVersion:p.planVersion,contractVersion:p.contractVersion,stepAttempt:p.stepAttempt,status:result.status,artifacts,startedAt}};
 }};
}
export type CashSnapshot=()=>Promise<{readonly currency:string;readonly totalMinor:number}|undefined>;

/** Real executor tool. Only a Host-registered worker can run; Task 3 still owns quote/approval/reservation. */
export function workflowReal(registrations:ReadonlyMap<string,FixtureRegistration>,observe:(op:Readonly<Operation>)=>void,cashSnapshot?:CashSnapshot):RealTool {
 return {id:'workflow.real',version:'1',realExecution:true,execute:async op=>{
  const p=op.payload as Record<string,JsonValue>;const registration=registrations.get(String(p.workerId));
  if(!registration||registration.descriptor.executionMode!=='real')return {status:'not_executed',reason:'unregistered_real_worker'};
  const {worker}=registration;const startedAt=new Date().toISOString();observe(op);
  const billingSource=registration.descriptor.billingSource??'subscription';
  let before:Readonly<{currency:string;totalMinor:number}>|undefined;
  if(billingSource==='official_api'&&cashSnapshot){try{before=await cashSnapshot();}catch{before=undefined;}}
  const context={sessionId:String(p.sessionId),taskId:op.taskId,runId:op.runId,attemptId:op.attemptId,workspace:String(p.workspace??'')||'real-workspace',input:{text:String(p.input)}};
  worker.createSession(context);const result=await worker.run(context.sessionId);
  let after:Readonly<{currency:string;totalMinor:number}>|undefined;
  if(before&&cashSnapshot){try{after=await cashSnapshot();}catch{after=undefined;}}
  for(const k of ['sessionId','taskId','runId','attemptId'] as const)if(result[k]!==context[k])return {status:'unknown',reason:'worker_identity_mismatch'};
  const estimate=billingSource==='official_api'?estimateDeepseekCashMinor(result.usage):0;
  const balanceDelta=before&&after&&before.currency===after.currency&&after.totalMinor<=before.totalMinor?before.totalMinor-after.totalMinor:undefined;
  // A positive official balance delta is authoritative for the call; otherwise use the usage estimate.
  const actualCashMinor=billingSource==='official_api'?(balanceDelta!==undefined&&balanceDelta>0?balanceDelta:estimate):0;
  if(actualCashMinor===undefined)return {status:'unknown',reason:'actual_cash_unverified',observation:{status:result.status,output:result.output,usage:result.usage??null}};
  const artifacts:Record<string,JsonValue>={};
  if(result.status==='completed'&&result.output){
    if(registration.descriptor.executorKind==='local'){
      try{
        const parsed:unknown=JSON.parse(result.output);
        if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||
           !['outline','constraints','draft','verify','snapshot','apply'].includes(String((parsed as Record<string,unknown>).stage))||
           typeof (parsed as Record<string,unknown>).valid!=='boolean')throw new Error('invalid_local_result');
        artifacts.result=parsed as JsonValue;
      }catch{return {status:'unknown',reason:'local_result_unreliable'};}
    }else artifacts.result=result.output;
  }
  const balance=before&&after?{beforeMinor:before.totalMinor,afterMinor:after.totalMinor,deltaMinor:Math.max(0,before.totalMinor-after.totalMinor),currency:after.currency,usedForSettlement:balanceDelta!==undefined&&balanceDelta>0}:undefined;
  return {status:'succeeded',actualCashMinor,result:{assignmentId:p.assignmentId,sessionId:p.sessionId,taskId:op.taskId,runId:op.runId,attemptId:op.attemptId,planVersion:p.planVersion,contractVersion:p.contractVersion,stepAttempt:p.stepAttempt,status:result.status,artifacts,startedAt,...(balance?{balance}:{})}};
 }};
}

/** Only Host calls this with Engine-owned delivery snapshots. No Worker-provided command runs. */
export function checkDelivery(w:Workflow,a:WorkflowAssignment):CheckReceipt[]{
 if(!a.delivery)throw new Error('No delivery');const step=w.plan.steps.find(s=>s.stepId===a.stepId)!;
 return step.contract.checks.map(c=>{
  const present=Object.hasOwn(a.delivery!.artifacts,c.artifactId);const value=a.delivery!.artifacts[c.artifactId];
  let status:'pass'|'fail'|'unknown'=present?'pass':'fail';
  if(present&&c.kind==='json_equals')status=canonicalJson(value)===canonicalJson(c.expected!)?'pass':'fail';
  if(present&&c.kind==='test')status=value===true?'pass':'fail';
  return {assignmentId:a.assignmentId,sessionId:a.sessionId,taskId:a.taskId,runId:a.runId,attemptId:a.attemptId,planVersion:a.planVersion,contractVersion:a.contractVersion,artifactVersion:a.stepAttempt,checkId:c.id,checkVersion:c.version,checkerId:'host:'+c.id,status};
 });
}
