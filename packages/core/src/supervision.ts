import type { JsonValue } from './json.ts';
import type { PolicyDecision, PolicyState, SupervisionHistory, WorkflowAssignment } from './workflow.ts';
export const defaultPolicy=():PolicyState=>({concurrency:3,maxReworks:1,mode:'stable',lastChangeSequence:0});
interface Sample {id:string;sequence:number;pass:boolean;assignment:WorkflowAssignment;frozen:number;}
function measurements(samples:Sample[]){
 const passed=samples.filter(s=>s.pass).length;
 const cash=samples.every(s=>Number.isSafeInteger(s.assignment.delivery?.cashMinor))?samples.reduce((v,s)=>v+s.assignment.delivery!.cashMinor!,0):null;
 const intervals=samples.map(s=>[Date.parse(s.assignment.dispatchedAt),Date.parse(s.assignment.delivery!.endedAt)]).sort((a,b)=>a[0]-b[0]);
 let ms=0,end=-Infinity;let valid=intervals.length>0;for(const [start,stop] of intervals){if(!Number.isFinite(start)||!Number.isFinite(stop)||stop<=start){valid=false;break;}ms+=Math.max(0,stop-Math.max(start,end));end=Math.max(end,stop);}
 return {passed,total:samples.length,rate:samples.length?passed/samples.length:null,costPerPass:cash!==null&&passed>0?cash/passed:null,timePerPass:valid&&passed>0?ms/passed:null,throughput:valid&&ms>0?passed/ms:null};
}
export function supervise(history:SupervisionHistory,group:string,current:PolicyState,future=false):PolicyDecision {
 const tasks=history.tasks.filter(t=>t.workflow?.group===group).sort((a,b)=>a.workflow!.frozenSequence-b.workflow!.frozenSequence);
 const samples:Sample[]=[];const seen=new Set<string>();
 for(const t of tasks){const w=t.workflow!;for(const a of w.assignments){const id=t.taskId+'|'+a.assignmentId;if(seen.has(id)||!a.delivery||t.status==='cancelled')continue;seen.add(id);const r=w.reviews.find(r=>r.assignmentId===a.assignmentId);if(!r||r.sequence>history.cutoff||r.verdict==='needs_human'||a.delivery.status==='cancelled')continue;samples.push({id,sequence:r.sequence,pass:r.verdict==='pass',assignment:a,frozen:w.frozenSequence});}}
 samples.sort((a,b)=>a.sequence-b.sequence);
 const decisions=tasks.flatMap(t=>t.workflow!.decisions).filter(d=>d.sequence<=history.cutoff).sort((a,b)=>a.sequence-b.sequence);
 const next:PolicyState={...current};let reason='insufficient_evidence_or_stable';
 const window=samples.filter(s=>s.assignment.concurrency===current.concurrency).slice(-20);
 const since=samples.filter(s=>s.sequence>current.lastChangeSequence);
 const cool=current.lastChangeSequence===0||since.length>=10;
 const stable=()=>{next.mode='stable';delete next.previousConcurrency;delete next.trialStartSequence;};
 if(current.mode==='trial'){
  const trial=samples.filter(s=>s.sequence>(current.trialStartSequence??0)&&s.assignment.concurrency===current.concurrency).slice(0,10);
  let rollback=trial.some(s=>!s.pass);
  if(trial.length>=10&&!rollback){const baseline=samples.filter(s=>s.sequence<=(current.trialStartSequence??0)&&s.assignment.concurrency===current.previousConcurrency&&s.assignment.saturated===true).slice(-20);const tested=trial.filter(s=>s.assignment.saturated===true);const b=measurements(baseline);const v=measurements(tested);rollback=baseline.length<10||tested.length<10||b.throughput===null||v.throughput===null||b.costPerPass===null||v.costPerPass===null||v.rate!<b.rate!||v.throughput<b.throughput*1.1||v.costPerPass>b.costPerPass;stable();reason=rollback?'trial_insufficient_evidence_or_no_gain':'trial_gain_confirmed';}
  if(rollback){next.concurrency=current.previousConcurrency??Math.max(1,current.concurrency-1);stable();reason='trial_rollback';}
 }else if(cool&&window.length>=10){
  if(window.filter(s=>!s.pass).length/window.length>=0.3&&current.concurrency>1){next.concurrency--;reason='failure_rate_decrease';}
  else if(current.concurrency<3&&window.slice(-10).length===10&&window.slice(-10).every(s=>s.pass)){next.previousConcurrency=current.concurrency;next.concurrency++;next.mode='trial';next.trialStartSequence=history.cutoff;reason='concurrency_trial';}
 }
 if(next.concurrency!==current.concurrency||next.mode!==current.mode)next.lastChangeSequence=history.cutoff;
 if(future){
  const recentTasks=tasks.slice(-50);const allowed=new Set(recentTasks.map(t=>t.workflow!.frozenSequence));const first=samples.filter(s=>allowed.has(s.frozen)&&s.assignment.stepAttempt===2).slice(-20);const second=samples.filter(s=>allowed.has(s.frozen)&&s.assignment.stepAttempt===3).slice(-20);
  const changed=decisions.filter(d=>d.previous.maxReworks!==d.next.maxReworks).at(-1);const newTasks=changed?tasks.filter(t=>t.workflow!.frozenSequence>changed.sequence).length:10;
  // A probe is an allocation for one future task, never the inherited retry default.
  next.maxReworks=current.maxReworks===2&&current.reworkMode!=='measured'?1:current.maxReworks;
  if(newTasks>=10){
   if(first.length<10){next.maxReworks=1;}
   else if(first.filter(s=>s.pass).length/first.length<=0.1){next.maxReworks=0;reason+=';rework_low_yield';}
   else {next.maxReworks=1;const f=measurements(first),v=measurements(second);if(second.length>=10&&v.rate!>=0.5&&v.costPerPass!==null&&f.costPerPass!==null&&v.timePerPass!==null&&f.timePerPass!==null&&v.costPerPass<=f.costPerPass&&v.timePerPass<=f.timePerPass){next.maxReworks=2;next.reworkMode='measured';reason+=';rework2_measured';}else if(second.length<10&&f.rate!>=0.8){const lastProbe=decisions.filter(d=>d.reason.includes('rework_probe')).at(-1);if(!lastProbe||tasks.filter(t=>t.workflow!.frozenSequence>lastProbe.sequence).length>=10){next.maxReworks=2;next.reworkMode='probe';reason+=';rework_probe';}}}
  }
 }
 if(next.maxReworks!==2)delete next.reworkMode;
 return {sequence:history.cutoff+1,historyCutoff:history.cutoff,group,previous:{...current},next,reason,samples:samples.map(s=>s.id),metrics:measurements(window) as unknown as JsonValue};
}
