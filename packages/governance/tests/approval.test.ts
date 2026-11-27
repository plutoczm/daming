import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Outbox } from '../../store-sqlite/src/index.ts';
import { createGovernance,GovernanceError } from '../src/index.ts';
import { harness,operation,NOW } from './helpers.ts';
test('missing/forged approvals never invoke a fixture or reserve cash',async t=>{
  for(const token of ['', 'forged-token']) {
    const h=harness(t);const op=operation();h.quote(op);const effect=h.claim(op);
    await assert.rejects(h.governance.gateway.execute(effect,token),GovernanceError);
    assert.equal(h.calls,0);assert.equal(h.governance.ledger.budget('task')!.heldMinor,0);
  }
});
test('valid capability executes once and settles budget, effect and audit together',async t=>{
  const h=harness(t);const op=operation();h.quote(op);const token=h.approve(op);const effect=h.claim(op);
  const first=await h.governance.gateway.execute(effect,token);
  assert.deepEqual(await h.governance.gateway.execute(effect,token),first);assert.equal(h.calls,1);
  assert.equal(h.store.getEffect(effect.effectId)!.status,'succeeded');
  assert.equal(h.governance.ledger.budget('task')!.spentMinor,500);assert.equal(h.governance.ledger.budget('task')!.heldMinor,0);
  assert.ok(h.store.listGovernanceAudit('task').some(e=>e.type==='tool_settled'));
  assert.equal(JSON.stringify(h.store.listGovernanceAudit('task')).includes(token),false);
});
test('expiry and revocation reject previously valid approvals',async t=>{
  for(const mode of ['expiry','revocation']) {
    const h=harness(t);const op=operation();h.quote(op);const token=h.approve(op);const effect=h.claim(op);
    if(mode==='expiry')h.setNow(NOW+30000);else h.governance.admin.revoke(token);
    await assert.rejects(h.governance.gateway.execute(effect,token),GovernanceError);assert.equal(h.calls,0);
  }
});
test('changed target, payload, amount or route requires a new binding',async t=>{
  for(const patch of [{target:'other'},{payload:{text:'changed'}},{amountMinor:1},{route:{mode:'magpie' as const,provider:'other',model:'fixture',accountRef:'other'}}]) {
    const h=harness(t);const approved=operation();h.quote(approved);const token=h.approve(approved);
    const changed={...approved,...patch};const effect=h.claim(changed);
    await assert.rejects(h.governance.gateway.execute(effect,token),GovernanceError);assert.equal(h.calls,0);
  }
});
test('an untrusted operation cannot turn on real shell/filesystem/network executors',async t=>{
  for(const executorKind of ['dsh','codex','claude-code'] as const) {
    const h=harness(t);const op=operation(executorKind,{executorKind});h.quote(op);const token=h.approve(op);
    await assert.rejects(h.governance.gateway.execute(h.claim(op),token),GovernanceError);
    assert.equal(h.calls,0);assert.equal(h.governance.ledger.budget('task')!.heldMinor,0);
  }
});
test('unknown outcomes retain commitments, block the task, and reconcile without replay',async t=>{
  const h=harness(t,async()=>{throw new Error('private unreliable receipt');});
  const op=operation();h.quote(op);const token=h.approve(op);const effect=h.claim(op);
  await h.governance.gateway.execute(effect,token);
  assert.equal(h.calls,1);assert.equal(h.store.getEffect(effect.effectId)!.status,'needs_reconciliation');
  assert.equal(h.engine.getTask('task')!.status,'blocked');assert.equal(h.governance.ledger.budget('task')!.heldMinor,1200);
  h.governance.admin.reconcile(op.id,{resolution:'succeeded',actualCashMinor:700,result:{receipt:'confirmed'},evidence:'fixture receipt checked'});
  assert.equal(h.calls,1);assert.equal(h.governance.ledger.budget('task')!.spentMinor,700);
  assert.equal(h.engine.getTask('task')!.status,'blocked');assert.equal(h.store.getEffect(effect.effectId)!.status,'succeeded');
});
test('Outbox integrates through Gateway and approval denial has zero tool side effects',async t=>{
  const h=harness(t);const op=operation();h.quote(op);h.enqueue(op);
  await new Outbox(h.store,h.engine,()=>new Date(NOW).toISOString()).dispatchOne(h.governance.gateway.executor(()=>undefined));
  assert.equal(h.calls,0);assert.equal(h.store.getEffect('effect-'+op.id)!.status,'failed');
  assert.equal(h.governance.ledger.budget('task')!.heldMinor,0);
});
test('outer transactions cannot run external callbacks before durable commit',async t=>{
  const h=harness(t);const op=operation();h.quote(op);const token=h.approve(op);const effect=h.claim(op);
  let dispatch:Promise<unknown>=Promise.resolve();
  h.store.atomic(()=>{dispatch=h.governance.gateway.execute(effect,token);});
  await assert.rejects(dispatch,GovernanceError);assert.equal(h.calls,0);
  assert.equal(h.governance.ledger.budget('task')!.heldMinor,0);
});
test('unexpected actual cost is recorded as a breach rather than silently discarded',async t=>{
  const h=harness(t,async()=>({status:'succeeded',actualCashMinor:2500,result:null}));
  const op=operation();h.quote(op);const token=h.approve(op);
  await h.governance.gateway.execute(h.claim(op),token);
  const budget=h.governance.ledger.budget('task')!;assert.equal(budget.spentMinor,2500);assert.equal(budget.breached,true);
  assert.equal(h.engine.getTask('task')!.status,'blocked');
});
test('known non-execution refunds hold and consumed capability cannot authorize another operation',async t=>{
  const h=harness(t,async()=>({status:'not_executed',reason:'fixture refused before execution'}));
  const op=operation();h.quote(op);const token=h.approve(op);await h.governance.gateway.execute(h.claim(op),token);
  assert.equal(h.governance.ledger.budget('task')!.spentMinor,0);assert.equal(h.governance.ledger.budget('task')!.heldMinor,0);
  const other=operation('other');h.quote(other);
  const task=h.engine.getTask('task')!;
  h.engine.execute({type:'reconcile_effect',context:{taskId:'task',runId:'run',attemptId:'attempt',eventId:'close',sourceId:'fixture',occurredAt:new Date(NOW).toISOString()},expectedVersion:task.version,effectId:'effect-op',resolution:'not_executed',evidence:'fixture confirms'});
  h.engine.execute({type:'transition_task',context:{taskId:'task',runId:'run',attemptId:'attempt',eventId:'resume',sourceId:'fixture',occurredAt:new Date(NOW).toISOString()},expectedVersion:h.engine.getTask('task')!.version,to:'queued'});
  h.engine.execute({type:'transition_task',context:{taskId:'task',runId:'run',attemptId:'attempt',eventId:'run-again',sourceId:'fixture',occurredAt:new Date(NOW).toISOString()},expectedVersion:h.engine.getTask('task')!.version,to:'running'});
  await assert.rejects(h.governance.gateway.execute(h.claim(other),token),GovernanceError);assert.equal(h.calls,1);
});

test('started authorization is durable before the callback and operation snapshots are immutable',async t=>{
  let inspect=()=>{};
  const h=harness(t,async(op,limits)=>{inspect();assert.equal(Object.isFrozen(op),true);assert.equal(Object.isFrozen(op.route),true);assert.equal(Object.isFrozen(op.payload),true);assert.equal(Object.isFrozen(limits),true);return {status:'succeeded',actualCashMinor:500,result:null};});
  const op=operation();h.quote(op);const token=h.approve(op);const effect=h.claim(op);
  inspect=()=>{
    assert.equal(h.store.governanceGet('executions','op')!.status,'started');
    assert.equal(h.store.governanceList('approvals','task')[0].status,'consumed');
    assert.equal(h.governance.ledger.budget('task')!.heldMinor,1200);
    assert.equal(h.governance.admin.revoke(token),false);
  };
  await h.governance.gateway.execute(effect,token);assert.equal(h.calls,1);
  assert.equal('approve' in h.governance.gateway,false);assert.equal('setBudget' in h.governance.gateway,false);
});
test('cancelled tasks cannot spend a previously issued approval',async t=>{
  const h=harness(t);const op=operation();h.quote(op);const token=h.approve(op);const effect=h.claim(op);
  h.engine.execute({type:'transition_task',context:{taskId:'task',runId:'run',attemptId:'attempt',eventId:'cancel',sourceId:'fixture',occurredAt:new Date(NOW).toISOString()},expectedVersion:h.engine.getTask('task')!.version,to:'cancelled'});
  await assert.rejects(h.governance.gateway.execute(effect,token),GovernanceError);assert.equal(h.calls,0);assert.equal(h.governance.ledger.budget('task')!.heldMinor,0);
});
test('unregistered shell filesystem and network aliases cannot bypass fixture admission',async t=>{
  for(const executorKind of ['dsh','codex','claude-code'] as const)for(const toolId of ['native.shell','native.filesystem','native.network']) {
    const h=harness(t);const op=operation(executorKind+'-'+toolId,{executorKind,toolId});h.quote(op);const token=h.approve(op);
    await assert.rejects(h.governance.gateway.execute(h.claim(op),token),GovernanceError);assert.equal(h.calls,0);
  }
});

test('expiry during durable preflight prevents the tool callback and releases the hold',async t=>{
  const h=harness(t);const op=operation();h.quote(op);const token=h.approve(op);const effect=h.claim(op);
  const append=h.store.appendGovernanceAudit.bind(h.store);
  h.store.appendGovernanceAudit=event=>{
    append(event);
    if(event.type==='tool_started')h.setNow(NOW+30000);
  };
  const result=await h.governance.gateway.execute(effect,token);
  assert.equal(h.calls,0);assert.equal(result.status,'not_executed');
  assert.equal(h.governance.ledger.budget('task')!.spentMinor,0);
  assert.equal(h.governance.ledger.budget('task')!.heldMinor,0);
  assert.equal(h.store.governanceGet('reservations',op.id)!.status,'released');
  assert.equal(h.store.governanceList('approvals','task')[0].status,'consumed');
  assert.equal(h.store.getEffect(effect.effectId)!.status,'failed');
  assert.deepEqual(await h.governance.gateway.execute(effect,token),result);
  assert.equal(h.calls,0);
});
