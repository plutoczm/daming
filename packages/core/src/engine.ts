import { workflowCommand } from './workflow-engine.ts';
import { stepPassed } from './workflow.ts';
import type { Command, CommandContext, CommandResult, EffectOutcome, EffectRequest, OutboxEffect, StoredEvent, Task } from './model.ts';
import { TASK_STATES } from './model.ts';
import type { ProjectRepository, TaskRepository } from './ports.ts';
import { applyProjectCommand } from './project.ts';
import type { Project, ProjectCommand, ProjectCommandResult, ProjectEvent } from './project.ts';
import { DomainError, ConflictError } from './errors.ts';
import { canonicalJson } from './json.ts';
import type { JsonValue } from './json.ts';
import { assertTransition } from './state-machine.ts';

function text(value:unknown,name:string):asserts value is string {
  if(typeof value!=='string'||!value.trim()) throw new DomainError(name+' must be nonempty text');
}
function timestamp(value:unknown):asserts value is string {
  text(value,'occurredAt');
  if(!/(?:Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value))) throw new DomainError('Expected a timestamp with timezone');
}
function fields(value:object,names:readonly string[]) {
  if(Object.keys(value).some(key=>!names.includes(key))) throw new DomainError('Unexpected command fields');
}
function validateEffect(effect:EffectRequest) {
  if(!effect||typeof effect!=='object') throw new DomainError('Expected an effect');
  fields(effect,['effectId','idempotencyKey','kind','payload','semantics']);
  for(const key of ['effectId','idempotencyKey','kind'] as const) text(effect[key],key);
  if(!['idempotent','non_idempotent'].includes(effect.semantics)) throw new DomainError('Unknown effect semantics');
  canonicalJson(effect.payload);
}
function validate(command:Command) {
  if(!command||typeof command!=='object'||!command.context) throw new DomainError('Expected a command and context');
  fields(command.context,['taskId','runId','attemptId','sourceId','eventId','occurredAt']);
  for(const key of ['taskId','runId','attemptId','sourceId','eventId'] as const) text(command.context[key],key);
  timestamp(command.context.occurredAt);
  if(command.context.sourceId==='host:outbox') throw new DomainError('Reserved internal event source');
  const common=['type','context','expectedVersion'];
  switch(command.type) {
    case 'workflow':fields(command,[...common,'action']);break;
    case 'create_task':fields(command,['type','context','title','goal']);text(command.title,'title');text(command.goal,'goal');break;
    case 'transition_task':
      fields(command,[...common,'to','reason','effects']);
      if(!TASK_STATES.includes(command.to)) throw new DomainError('Unknown task state');
      if(command.reason!==undefined) text(command.reason,'reason');
      if(command.effects!==undefined&&!Array.isArray(command.effects)) throw new DomainError('Effects must be an array');
      command.effects?.forEach(validateEffect);break;
    case 'enqueue_effect':fields(command,[...common,'effect']);validateEffect(command.effect);break;
    case 'reconcile_effect':
      fields(command,[...common,'effectId','resolution','evidence','result']);text(command.effectId,'effectId');text(command.evidence,'evidence');
      if(!['succeeded','not_executed'].includes(command.resolution)) throw new DomainError('Unknown reconciliation');
      break;
    default:throw new DomainError('Unknown command');
  }
  if(command.type!=='create_task'&&(!Number.isSafeInteger(command.expectedVersion)||command.expectedVersion<1)) throw new DomainError('Expected a positive aggregate version');
}
function copy<T>(value:T):T { return JSON.parse(JSON.stringify(value)) as T; }

/** Only entry point for task facts; no clock, network, SDK or OS dependency. */
export class Engine {
  private readonly repo:TaskRepository;
  private readonly projects:ProjectRepository|undefined;
  constructor(repo:TaskRepository, projects?:ProjectRepository) {
    this.repo=repo;
    this.projects=projects;
  }
  getTask(taskId:string):Task|undefined { return this.repo.getTask(taskId); }
  getProject(projectId:string):Project|undefined { return this.projects?.getProject(projectId); }
  executeProject(input:ProjectCommand):ProjectCommandResult {
    const repo=this.projects;
    if(!repo) throw new DomainError('Project storage is unavailable');
    const commandJson=canonicalJson(input);
    const command=JSON.parse(commandJson) as ProjectCommand;
    return repo.atomic(()=>{
      const repeated=repo.getProjectEvent(command.projectId,command.eventId);
      if(repeated) {
        if(repeated.commandJson!==commandJson) throw new ConflictError('Project event id was reused with different content');
        return {duplicate:true,project:copy(repeated.snapshot),event:copy(repeated)};
      }
      const {project,type}=applyProjectCommand(repo.getProject(command.projectId),command);
      const event:ProjectEvent={
        projectId:command.projectId,eventId:command.eventId,at:command.at,type,commandJson,snapshot:project,
      };
      repo.saveProject(project,command.expectedRevision);
      repo.appendProjectEvent(event);
      return {duplicate:false,project:copy(project),event:copy(event)};
    });
  }
  private duplicate(context:CommandContext,request:string):CommandResult|undefined {
    const old=this.repo.getEvent(context.sourceId,context.eventId);
    if(!old) return;
    if(old.commandJson!==request) throw new ConflictError('Event id was reused with different content');
    return {duplicate:true,task:copy(old.snapshot),event:copy(old)};
  }
  private commit(task:Task,previous:number|null,context:CommandContext,request:string,type:string,details:JsonValue):CommandResult {
    this.repo.saveTask(task,previous);
    const event:StoredEvent={...context,sequence:this.repo.nextSequence(),type,commandJson:request,snapshot:task,details};
    this.repo.appendEvent(event);
    return {duplicate:false,task:copy(task),event:copy(event)};
  }
  execute(input:Command):CommandResult {
    validate(input);
    const request=canonicalJson(input);
    const command=JSON.parse(request) as Command;
    return this.repo.atomic(()=>{
      const repeated=this.duplicate(command.context,request);if(repeated)return repeated;
      const c=command.context;const current=this.repo.getTask(c.taskId);
      if(command.type==='create_task') {
        if(current) throw new ConflictError('Task already exists');
        const task:Task={taskId:c.taskId,title:command.title,goal:command.goal,status:'draft',createdAt:c.occurredAt,updatedAt:c.occurredAt,runId:c.runId,attemptId:c.attemptId,sourceId:c.sourceId,version:1};
        return this.commit(task,null,c,request,'task_created',{});
      }
      if(!current) throw new DomainError('Task does not exist');
      if(current.version!==command.expectedVersion||current.sourceId!==c.sourceId||current.runId!==c.runId||current.attemptId!==c.attemptId) throw new ConflictError('Task version or trusted origin/run/attempt does not match');
      if(command.type==='workflow') {
        const changed=workflowCommand(copy(current),command.action,c,this.repo);
        const next={...changed.task,version:current.version+1,updatedAt:c.occurredAt};
        if(changed.effect){const e=changed.effect;if(this.repo.getEffect(e.effectId)||this.repo.getEffectByKey(e.idempotencyKey))throw new ConflictError('Effect id/key already exists');this.repo.insertEffect({...e,taskId:c.taskId,runId:c.runId,attemptId:c.attemptId,status:'pending',attempts:0,createdAt:c.occurredAt,updatedAt:c.occurredAt});}
        return this.commit(next,current.version,c,request,'workflow_'+command.action.kind,JSON.parse(request) as JsonValue);
      }
      if(current.workflow&&current.status==='blocked'&&command.type==='transition_task'&&!['failed','cancelled'].includes(command.to)&&this.repo.dispatchBlockers(current.taskId).length)throw new DomainError('Unresolved governance prevents workflow resume');
      if(current.workflow&&(command.type==='enqueue_effect'||command.type==='transition_task'&&command.effects?.length))throw new DomainError('Workflow effects require a bound assignment');
      if(current.workflow&&command.type==='transition_task'&&command.to==='completed') {
        if(!current.workflow.plan.steps.every(s=>stepPassed(current.workflow!,s.stepId))||this.repo.completionBlockers(current.taskId).length)throw new DomainError('Workflow review or financial clearance incomplete');
      }
      const {blockedReason:_oldReason,...base}=current;
      let next:Task={...base,version:current.version+1,updatedAt:c.occurredAt};
      let type='task_transitioned';
      if(command.type==='reconcile_effect') {
        const effect=this.repo.getEffect(command.effectId);
        if(!effect||effect.taskId!==current.taskId||!['needs_reconciliation','failed'].includes(effect.status)) throw new DomainError('Effect is not awaiting reconciliation');
        const {error:_error,result:_result,...effectBase}=effect;
        const updated:OutboxEffect={...effectBase,status:command.resolution==='succeeded'?'succeeded':'cancelled',updatedAt:c.occurredAt,...(command.result!==undefined?{result:command.result}:{})};
        this.repo.saveEffect(updated,effect.status,effect.attempts);
        next={...next,...(current.blockedReason?{blockedReason:current.blockedReason}:{})};
        type='effect_reconciled';
      } else {
        if(command.type==='transition_task') {
          assertTransition(current.status,command.to);
          if(current.status==='blocked'&&!['failed','cancelled'].includes(command.to)&&this.repo.effectsForTask(current.taskId).some(e=>e.status==='needs_reconciliation')) throw new DomainError('Unresolved effects must be reconciled before resuming');
          if(command.to==='completed'&&this.repo.effectsForTask(current.taskId).some(e=>!['succeeded','cancelled'].includes(e.status))) throw new DomainError('Outstanding effects prevent completion');
          next={...next,status:command.to,...(command.to==='blocked'?{blockedReason:command.reason??'Blocked by Host'}:{})};
        } else {
          if(current.status!=='running') throw new DomainError('Only running tasks can enqueue effects');
          type='effect_queued';
        }
        const requests=command.type==='enqueue_effect'?[command.effect]:command.effects??[];
        if(requests.length&&next.status!=='running') throw new DomainError('Effects may only be queued for a running task');
        // Effects reference an existing task; all state/event/effect writes share this transaction.
        for(const effect of requests) {
          if(this.repo.getEffect(effect.effectId)||this.repo.getEffectByKey(effect.idempotencyKey)) throw new ConflictError('Effect id/key already exists');
          this.repo.insertEffect({...effect,taskId:c.taskId,runId:c.runId,attemptId:c.attemptId,status:'pending',attempts:0,createdAt:c.occurredAt,updatedAt:c.occurredAt});
        }
        if(['cancelled','failed'].includes(next.status)) for(const effect of this.repo.effectsForTask(c.taskId)) {
          if(effect.status==='pending') this.repo.saveEffect({...effect,status:'cancelled',updatedAt:c.occurredAt},'pending',effect.attempts);
        }
        return this.commit(next,current.version,c,request,type,JSON.parse(request) as JsonValue);
      }
      return this.commit(next,current.version,c,request,type,JSON.parse(request) as JsonValue);
    });
  }
  settleEffect(effectId:string,attempt:number,outcome:EffectOutcome,at:string):CommandResult {
    timestamp(at);
    if(!Number.isSafeInteger(attempt)||attempt<1) throw new DomainError('Invalid effect attempt');
    const request=canonicalJson({effectId,attempt,outcome});
    const normalized=JSON.parse(request).outcome as EffectOutcome;
    if(!normalized||!['succeeded','not_executed','unknown'].includes(normalized.status)) throw new DomainError('Invalid execution outcome');
    if(normalized.status!=='succeeded') text(normalized.reason,'reason');
    if(normalized.status==='not_executed'&&typeof normalized.retryable!=='boolean') throw new DomainError('Invalid retry flag');
    if(normalized.status==='succeeded'&&!Object.hasOwn(normalized,'result')) throw new DomainError('Missing execution result');
    return this.repo.atomic(()=>{
      const effect=this.repo.getEffect(effectId);
      if(!effect) throw new DomainError('Unknown effect');
      const task=this.repo.getTask(effect.taskId)!;
      const context:CommandContext={taskId:task.taskId,runId:task.runId,attemptId:task.attemptId,sourceId:'host:outbox',eventId:JSON.stringify(['settled',effectId,attempt]),occurredAt:at};
      const repeated=this.duplicate(context,request);if(repeated)return repeated;
      if(effect.status!=='executing'||effect.attempts!==attempt) throw new ConflictError('Stale effect completion');
      const {error:_error,result:_result,...base}=effect;
      let updated:OutboxEffect;
      let next:Task={...task,version:task.version+1,updatedAt:at};
      if(normalized.status==='succeeded') updated={...base,status:'succeeded',updatedAt:at,result:normalized.result};
      else if(normalized.status==='not_executed') {
        updated={...base,status:normalized.retryable?'pending':'failed',updatedAt:at,error:normalized.reason};
        if(!normalized.retryable&&!['cancelled','completed','failed'].includes(task.status)) next={...next,status:'blocked',blockedReason:normalized.reason};
      } else {
        const retryable=effect.semantics==='idempotent'&&['running','reviewing'].includes(task.status);
        updated={...base,status:retryable?'pending':'needs_reconciliation',updatedAt:at,error:normalized.reason};
        if(!retryable&&!['cancelled','completed','failed'].includes(task.status)) next={...next,status:'blocked',blockedReason:'needs_reconciliation: '+effectId};
      }
      this.repo.saveEffect(updated,'executing',attempt);
      return this.commit(next,task.version,context,request,'effect_settled',JSON.parse(request) as JsonValue);
    });
  }
}
