import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine, ConflictError, DomainError } from '@daming/core';
import type { CommandContext, EffectRequest, TaskState } from '@daming/core';
import { SqliteStore, Outbox } from '../src/index.ts';
const at='2026-11-06T00:00:00.000Z';
const context=(eventId:string):CommandContext=>({taskId:'task1',runId:'run1',attemptId:'attempt1',sourceId:'local',eventId,occurredAt:at});
const effect:EffectRequest={effectId:'e1',idempotencyKey:'key1',kind:'fixture',payload:{message:'synthetic'},semantics:'non_idempotent'};
function harness(t:{after(fn:()=>void):void}) {
  const directory=mkdtempSync(join(tmpdir(),'daming sqlite '));
  const file=join(directory,'state.sqlite');
  let store=new SqliteStore(file); let engine=new Engine(store);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const reopen=()=>{store.close();store=new SqliteStore(file);engine=new Engine(store);return {store,engine};};
  engine.execute({type:'create_task',context:context('create'),title:'Synthetic',goal:'fixture'});
  return {file,get store(){return store;},get engine(){return engine;},reopen};
}
function transition(engine:Engine,id:string,to:TaskState,effects?:EffectRequest[]) {
  const command={type:'transition_task' as const,context:context(id),to,expectedVersion:engine.getTask('task1')!.version};
  return engine.execute(effects?{...command,effects}:command);
}
function start(engine:Engine,request=effect) {
  transition(engine,'p','planned'); transition(engine,'q','queued'); transition(engine,'r','running',[request]);
}
test('disk reopen preserves task, monotonically ordered audit facts and pending effects',t=>{
  const h=harness(t);start(h.engine);
  const before=h.engine.getTask('task1');h.reopen();
  assert.deepEqual(h.engine.getTask('task1'),before);
  assert.deepEqual(h.store.listEvents('task1').map(e=>e.sequence),[1,2,3,4]);
  assert.equal(h.store.getEffect('e1')!.status,'pending');
});
test('one transaction rolls back task, audit event and effects on SQL uniqueness failure',t=>{
  const h=harness(t);transition(h.engine,'p','planned');transition(h.engine,'q','queued');
  assert.throws(()=>transition(h.engine,'r','running',[effect,{...effect,effectId:'e2'}]));
  h.reopen();assert.equal(h.engine.getTask('task1')!.status,'queued');
  assert.equal(h.store.listEvents('task1').length,3);assert.equal(h.store.effectsForTask('task1').length,0);
});
test('nested transactions use savepoints and cannot commit inner partial writes',t=>{
  const h=harness(t);
  h.store.atomic(()=>{
    assert.throws(()=>h.store.atomic(()=>{
      transition(h.engine,'inner','planned');throw new Error('rollback inner');
    }));
    assert.equal(h.engine.getTask('task1')!.status,'draft');
    transition(h.engine,'outer','planned');
  });
  h.reopen();assert.deepEqual(h.store.listEvents('task1').map(e=>e.eventId),['create','outer']);
});
test('unknown non-idempotent result blocks work and is never automatically replayed',async t=>{
  const h=harness(t);start(h.engine);
  let calls=0;
  let outbox=new Outbox(h.store,h.engine,()=>at);
  await outbox.dispatchOne(async()=>{calls++;throw new Error('transport lost after send');});
  assert.equal(h.store.getEffect('e1')!.status,'needs_reconciliation');
  assert.equal(h.engine.getTask('task1')!.status,'blocked');
  assert.throws(()=>transition(h.engine,'resume','queued'),DomainError);
  h.reopen();outbox=new Outbox(h.store,h.engine,()=>at);outbox.recoverInterrupted();
  assert.equal(await outbox.dispatchOne(async()=>{calls++;return {status:'succeeded',result:null};}),undefined);
  assert.equal(calls,1);
});
test('interrupted claimed non-idempotent work is reconciled without invoking an executor',t=>{
  const h=harness(t);start(h.engine);h.store.claimNext(at);h.reopen();
  new Outbox(h.store,h.engine,()=>at).recoverInterrupted();
  assert.equal(h.store.getEffect('e1')!.status,'needs_reconciliation');
  assert.equal(h.engine.getTask('task1')!.status,'blocked');
});
test('pending work executes once after commit and success survives restart',async t=>{
  const h=harness(t);start(h.engine);let calls=0;
  const outbox=new Outbox(h.store,h.engine,()=>at);
  await outbox.dispatchOne(async e=>{calls++;assert.equal(e.status,'executing');assert.equal(h.store.listEvents('task1').length,4);return {status:'succeeded',result:{receipt:'fixture'}};});
  assert.equal(await outbox.dispatchOne(async()=>{throw new Error('must not run');}),undefined);
  h.reopen();assert.equal(h.store.getEffect('e1')!.status,'succeeded');assert.equal(calls,1);
  assert.equal(h.store.listEvents('task1').at(-1)!.type,'effect_settled');
});
test('idempotent interrupted work retries with the same key and rejects stale completion',async t=>{
  const h=harness(t);start(h.engine,{...effect,semantics:'idempotent'});
  const first=h.store.claimNext(at)!;h.reopen();const outbox=new Outbox(h.store,h.engine,()=>at);
  outbox.recoverInterrupted();
  await outbox.dispatchOne(async current=>{assert.equal(current.idempotencyKey,first.idempotencyKey);assert.equal(current.attempts,2);return {status:'succeeded',result:null};});
  assert.throws(()=>h.engine.settleEffect('e1',1,{status:'succeeded',result:null},at),ConflictError);
  assert.equal(h.store.getEffect('e1')!.status,'succeeded');
});
test('a definitely not executed response can retry a non-idempotent effect',async t=>{
  const h=harness(t);start(h.engine);const outbox=new Outbox(h.store,h.engine,()=>at);
  await outbox.dispatchOne(async()=>({status:'not_executed',reason:'fixture rejected before execution',retryable:true}));
  assert.equal(h.store.getEffect('e1')!.status,'pending');
  await outbox.dispatchOne(async()=>({status:'succeeded',result:null}));
  assert.equal(h.store.getEffect('e1')!.attempts,2);
});
test('explicit reconciliation records evidence but requires a separate resume decision',async t=>{
  const h=harness(t);start(h.engine);await new Outbox(h.store,h.engine,()=>at).dispatchOne(async()=>({status:'unknown',reason:'unknown receipt'}));
  h.engine.execute({type:'reconcile_effect',context:context('reconcile'),expectedVersion:h.engine.getTask('task1')!.version,effectId:'e1',resolution:'succeeded',evidence:'fixture receipt confirmed',result:{receipt:'known'}});
  assert.equal(h.engine.getTask('task1')!.status,'blocked');
  assert.equal(h.store.getEffect('e1')!.status,'succeeded');
  transition(h.engine,'resume','queued');
  assert.equal(h.store.listEvents('task1').some(e=>e.type==='effect_reconciled'),true);
});
test('cancelled or blocked tasks do not dispatch their pending effects',async t=>{
  const h=harness(t);start(h.engine);transition(h.engine,'cancel','cancelled');
  let calls=0;await new Outbox(h.store,h.engine,()=>at).dispatchOne(async()=>{calls++;return {status:'succeeded',result:null};});
  assert.equal(calls,0);assert.equal(h.store.getEffect('e1')!.status,'cancelled');
});

test('executor mutation cannot retarget the durable claim or receipt',async t=>{
  const h=harness(t);start(h.engine);
  await new Outbox(h.store,h.engine,()=>at).dispatchOne(async received=>{
    (received as unknown as {effectId:string;attempts:number}).effectId='different-effect';
    (received as unknown as {attempts:number}).attempts=999;
    return {status:'succeeded',result:null};
  });
  assert.equal(h.store.getEffect('e1')!.status,'succeeded');
});
test('SQL constraint failure rolls back an enclosing Engine transaction',t=>{
  const h=harness(t);
  assert.throws(()=>h.store.atomic(()=>{
    transition(h.engine,'p','planned');
    h.store.appendEvent(h.store.listEvents()[0]);
  }));
  h.reopen();assert.equal(h.engine.getTask('task1')!.status,'draft');assert.equal(h.store.listEvents().length,1);
});

test('known permanent rejection can be explicitly closed without trapping the task',async t=>{
  const h=harness(t);start(h.engine);
  await new Outbox(h.store,h.engine,()=>at).dispatchOne(async()=>({status:'not_executed',reason:'fixture permanent refusal',retryable:false}));
  assert.equal(h.store.getEffect('e1')!.status,'failed');assert.equal(h.engine.getTask('task1')!.status,'blocked');
  h.engine.execute({type:'reconcile_effect',context:context('close-refusal'),expectedVersion:h.engine.getTask('task1')!.version,effectId:'e1',resolution:'not_executed',evidence:'fixture confirms nothing executed'});
  transition(h.engine,'resume','queued');assert.equal(h.store.getEffect('e1')!.status,'cancelled');
});
test('invalid executor receipts become unknown, never implicit success',async t=>{
  const h=harness(t);start(h.engine);
  await new Outbox(h.store,h.engine,()=>at).dispatchOne(async()=>undefined as never);
  assert.equal(h.store.getEffect('e1')!.status,'needs_reconciliation');assert.equal(h.engine.getTask('task1')!.status,'blocked');
});
test('late unknown completion never resurrects a cancelled task',async t=>{
  const h=harness(t);start(h.engine);
  await new Outbox(h.store,h.engine,()=>at).dispatchOne(async()=>{
    transition(h.engine,'cancel-in-flight','cancelled');return {status:'unknown',reason:'fixture lost result'};
  });
  assert.equal(h.engine.getTask('task1')!.status,'cancelled');assert.equal(h.store.getEffect('e1')!.status,'needs_reconciliation');
});

test('dispatch inside a surrounding transaction cannot invoke any executor before rollback',async t=>{
  for(const asynchronous of [false,true]) {
    const h=harness(t);start(h.engine);const outbox=new Outbox(h.store,h.engine,()=>at);let calls=0;
    let dispatch:Promise<unknown>=Promise.resolve();
    const executor=(()=>{calls++;const outcome={status:'succeeded' as const,result:null};return asynchronous?Promise.resolve(outcome):outcome;}) as never;
    assert.throws(()=>h.store.atomic(()=>{
      dispatch=outbox.dispatchOne(executor);throw new Error('outer rollback');
    }));
    await assert.rejects(dispatch);
    assert.equal(calls,0,'no external execution may precede the outer commit');
    assert.equal(h.store.getEffect('e1')!.status,'pending');
    await outbox.dispatchOne(executor);assert.equal(calls,1);assert.equal(h.store.getEffect('e1')!.status,'succeeded');
  }
});
test('late unknown or permanently rejected receipts preserve a failed terminal task',async t=>{
  for(const outcome of [{status:'unknown' as const,reason:'late unknown'},{status:'not_executed' as const,reason:'late rejection',retryable:false}]) {
    const h=harness(t);start(h.engine);
    await new Outbox(h.store,h.engine,()=>at).dispatchOne(async()=>{
      transition(h.engine,'fail-in-flight','failed');return outcome;
    });
    assert.equal(h.engine.getTask('task1')!.status,'failed');
    h.engine.execute({type:'reconcile_effect',context:context('settle-after-failure'),expectedVersion:h.engine.getTask('task1')!.version,effectId:'e1',resolution:'not_executed',evidence:'fixture operator closes effect'});
    assert.throws(()=>transition(h.engine,'resume-failure','queued'),DomainError);
    assert.equal(h.engine.getTask('task1')!.status,'failed');
  }
});
test('cold-start recovery cannot resurrect a failed task with interrupted effects',t=>{
  const h=harness(t);start(h.engine);h.store.claimNext(at);transition(h.engine,'fail-before-crash','failed');h.reopen();
  new Outbox(h.store,h.engine,()=>at).recoverInterrupted();
  assert.equal(h.engine.getTask('task1')!.status,'failed');assert.equal(h.store.getEffect('e1')!.status,'needs_reconciliation');
});
