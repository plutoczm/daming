import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Engine, ConflictError, DomainError } from '../src/index.ts';
import type { CommandContext, EffectRequest, TaskState } from '../src/index.ts';
import { MemoryRepository } from './helpers.ts';
const at='2026-11-06T00:00:00.000Z';
const context=(eventId:string):CommandContext=>({taskId:'task1',runId:'run1',attemptId:'attempt1',sourceId:'local',eventId,occurredAt:at});
function harness() {
  const repo=new MemoryRepository(); const engine=new Engine(repo);
  const create={type:'create_task' as const,context:context('create'),title:'Synthetic task',goal:'No personal data'};
  engine.execute(create); return {repo,engine,create};
}
function transition(engine:Engine,eventId:string,to:TaskState,effects?:EffectRequest[]) {
  const command={type:'transition_task' as const,context:context(eventId),expectedVersion:engine.getTask('task1')!.version,to};
  return engine.execute(effects?{...command,effects}:command);
}
const effect:EffectRequest={effectId:'e1',idempotencyKey:'key1',kind:'fixture',payload:{value:1},semantics:'non_idempotent'};
test('same event replays its original result without a second task or event',()=>{
  const {engine,repo,create}=harness();
  const result=engine.execute(create);
  assert.equal(result.duplicate,true); assert.equal(result.task.version,1);
  assert.equal(repo.tasks.size,1); assert.equal(repo.events.length,1);
});
test('conflicting reused event id cannot create a different task',()=>{
  const {engine,repo,create}=harness();
  assert.throws(()=>engine.execute({...create,context:{...create.context,taskId:'task2'}}),ConflictError);
  assert.equal(repo.tasks.has('task2'),false); assert.equal(repo.events.length,1);
});
test('canonical request comparison ignores object key order without hashes',()=>{
  const {engine,create}=harness();
  assert.equal(engine.execute({goal:create.goal,title:create.title,context:{...create.context},type:'create_task'}).duplicate,true);
});
test('state graph rejects shortcuts and terminal transitions',()=>{
  const {engine}=harness();
  assert.throws(()=>transition(engine,'bad','completed'),DomainError);
  transition(engine,'planned','planned'); transition(engine,'queued','queued');
  transition(engine,'running','running'); transition(engine,'reviewing','reviewing'); transition(engine,'done','completed');
  assert.throws(()=>transition(engine,'after-done','running'),DomainError);
});
test('stale versions and changed source/run/attempt identity do not write facts',()=>{
  const {engine,repo}=harness();
  for(const patch of [{sourceId:'other'},{runId:'other'},{attemptId:'other'}]) {
    assert.throws(()=>engine.execute({type:'transition_task',context:{...context('bad'),...patch},expectedVersion:1,to:'planned'}),ConflictError);
  }
  transition(engine,'p','planned');
  assert.throws(()=>engine.execute({type:'transition_task',context:context('stale'),expectedVersion:1,to:'queued'}),ConflictError);
  assert.equal(repo.events.length,2);
});
test('effects and task/event changes roll back together on duplicate effect keys',()=>{
  const {engine,repo}=harness(); transition(engine,'p','planned'); transition(engine,'q','queued');
  assert.throws(()=>transition(engine,'run','running',[effect,{...effect,effectId:'e2'}]));
  assert.equal(engine.getTask('task1')!.status,'queued'); assert.equal(repo.effects.size,0); assert.equal(repo.events.length,3);
});
test('invalid JSON and runtime-invalid states fail before any writes',()=>{
  const {engine,repo}=harness();
  assert.throws(()=>engine.execute({type:'transition_task',context:context('bad'),expectedVersion:1,to:'invalid'} as never),DomainError);
  assert.throws(()=>engine.execute({type:'create_task',context:context('bad-json'),title:'x',goal:NaN} as never),DomainError);
  assert.equal(repo.events.length,1);
});
test('queued effects prevent claiming a completed task; unresolved effects prevent resume',()=>{
  const {engine}=harness(); transition(engine,'p','planned'); transition(engine,'q','queued'); transition(engine,'r','running',[effect]);
  transition(engine,'v','reviewing');
  assert.throws(()=>transition(engine,'done','completed'),DomainError);
});

test('external sources cannot reuse the reserved Outbox event namespace',()=>{
  const repo=new MemoryRepository();const engine=new Engine(repo);
  assert.throws(()=>engine.execute({type:'create_task',context:{...context('c'),sourceId:'host:outbox'},title:'x',goal:'fixture'}),DomainError);
  assert.equal(repo.events.length,0);
});
test('event ids are scoped to their trusted source',()=>{
  const {engine,repo,create}=harness();
  engine.execute({...create,context:{...create.context,taskId:'task2',sourceId:'other'}});
  assert.equal(repo.tasks.size,2);assert.equal(repo.events.length,2);
});
