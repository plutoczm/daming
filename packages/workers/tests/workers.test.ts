import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Registry, routeWorkers, FixtureWorker, unavailableAdapter } from '../src/index.ts';
import type { WorkerDescriptor, RoutingRequest } from '../src/index.ts';
const descriptor:WorkerDescriptor={id:'fixture',executorKind:'codex',executionMode:'fixture',runtime:'fixture-v1',provider:'fixture',model:'model',routeMode:'native',os:'win32',health:'ready',credentialsReady:true,capabilities:['read'],permissions:['workspace-read'],network:'offline',dataScopes:['synthetic'],maxCashMinor:0,priceVerified:true,quotaRemaining:10,concurrencyLimit:2,activeCount:0,isolation:'fixture_only'};
const request:RoutingRequest={os:'win32',provider:'fixture',routeMode:'native',capabilities:['read'],permissions:['workspace-read'],network:'offline',dataScope:'synthetic',maxCashMinor:0,allowFixture:true};
test('registry snapshots cannot be changed by callers',()=>{
  const registry=new Registry();registry.register(descriptor);
  const rows=registry.list();(rows[0].capabilities as string[]).push('secret');
  assert.deepEqual(registry.list()[0].capabilities,['read']);assert.throws(()=>registry.register(descriptor));
});
test('all hard filters return reasons; unknown pricing is never free',()=>{
  const patches:Partial<WorkerDescriptor>[]=[{health:'unavailable'},{credentialsReady:false},{os:'linux'},{capabilities:[]},{permissions:[]},{network:'internet'},{maxCashMinor:null},{priceVerified:false},{quotaRemaining:0},{activeCount:2},{dataScopes:[]},{routeMode:'magpie'},{executionMode:'unavailable'}];
  for(const patch of patches) {
    const decision=routeWorkers([{...descriptor,...patch}],request);
    assert.equal(decision.selected,undefined,JSON.stringify(patch));assert.ok(decision.excluded[0].reasons.length);
  }
  assert.equal(routeWorkers([descriptor],{...request,allowFixture:false}).selected,undefined);
});
test('gateway route requires explicit verified readiness; native is not fallback',()=>{
  assert.equal(routeWorkers([descriptor],{...request,routeMode:'magpie'}).selected,undefined);
  assert.equal(routeWorkers([{...descriptor,routeMode:'magpie'}],{...request,routeMode:'magpie'}).selected,undefined);
  assert.equal(routeWorkers([{...descriptor,routeMode:'magpie',gatewayVerified:true}],{...request,routeMode:'magpie'}).selected?.id,'fixture');
});
test('ranking uses measured samples with deterministic tie breaking',()=>{
  const bad={...descriptor,id:'b',metrics:{samples:10,successes:5,latencyMs:10}};
  const good={...descriptor,id:'a',metrics:{samples:10,successes:9,latencyMs:50}};
  assert.equal(routeWorkers([bad,good],request).selected?.id,'a');
});
for(const executorKind of ['dsh','codex','claude-code'] as const) {
  test(executorKind+' fixture lifecycle, errors, timeout, cancel and restore',async()=>{
    const worker=new FixtureWorker(executorKind);
    const context={sessionId:'s',taskId:'t',runId:'r',attemptId:'a',workspace:'fixture-A',input:{text:'synthetic'}};
    worker.createSession(context);const result=await worker.run('s',{timeoutMs:1000});
    assert.equal(result.status,'completed');assert.equal(result.mode,'fixture');assert.equal(result.taskId,'t');
    const restored=new FixtureWorker(executorKind);restored.restore(worker.snapshot('s'));assert.deepEqual(restored.snapshot('s').result,result);
    const slow=new FixtureWorker(executorKind,{delayMs:50});slow.createSession(context);
    const pending=slow.run('s',{timeoutMs:1000});slow.cancel('s');assert.equal((await pending).status,'cancelled');
    assert.equal((await slow.run('s',{timeoutMs:1})).status,'timed_out');
    const broken=new FixtureWorker(executorKind,{fail:true});broken.createSession(context);assert.equal((await broken.run('s')).status,'failed');
    assert.equal(unavailableAdapter(executorKind).health,'unavailable');
  });
}
test('concurrent fixture sessions do not share contexts or caller data',async()=>{
  const worker=new FixtureWorker('dsh',{delayMs:5});
  const first={sessionId:'a',taskId:'ta',runId:'ra',attemptId:'aa',workspace:'A',input:{text:'first'}};
  worker.createSession(first);first.input.text='changed';
  worker.createSession({...first,sessionId:'b',taskId:'tb',workspace:'B',input:{text:'second'}});
  const results=await Promise.all([worker.run('a'),worker.run('b')]);
  assert.equal(results[0].output,'first');assert.equal(results[1].output,'second');
  assert.equal(worker.snapshot('a').context.workspace,'A');assert.equal(worker.snapshot('b').context.workspace,'B');
});

test('routing honors an explicitly required model',()=>{
  assert.equal(routeWorkers([descriptor],{...request,model:'other-model'}).selected,undefined);
});
test('registry leases reserve concurrency and release exactly once',()=>{
  const registry=new Registry();registry.register({...descriptor,concurrencyLimit:1});
  const lease=registry.acquire(request)!;assert.ok(lease);assert.equal(registry.acquire(request),undefined);
  lease.release();lease.release();assert.ok(registry.acquire(request));
});
test('active or foreign snapshots cannot be restored and external abort is honored',async()=>{
  const worker=new FixtureWorker('codex',{delayMs:20});
  worker.createSession({sessionId:'s',taskId:'t',runId:'r',attemptId:'a',workspace:'synthetic',input:{text:'x'}});
  const pending=worker.run('s');assert.throws(()=>new FixtureWorker('codex').restore(worker.snapshot('s')));
  await assert.rejects(worker.run('s'));worker.cancel('s');await pending;
  assert.throws(()=>new FixtureWorker('dsh').restore(worker.snapshot('s')));
  const signal=new AbortController();signal.abort();assert.equal((await worker.run('s',{signal:signal.signal})).status,'cancelled');
});

test('nonfinite metrics are not measured evidence for ranking',()=>{
  const invalid={...descriptor,id:'invalid',metrics:{samples:Infinity,successes:Infinity,latencyMs:0}};
  const measured={...descriptor,id:'measured',metrics:{samples:10,successes:9,latencyMs:50}};
  assert.equal(routeWorkers([invalid,measured],request).selected?.id,'measured');
});
