import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalProviderFixture } from '@daming/model-gateway';
import type { FixtureRequest,FixtureScenario } from '@daming/model-gateway';
import { createGovernance } from '@daming/governance';
import { Outbox } from '@daming/store-sqlite';
import * as host from '../src/fixture.ts';
import { harness,operation,NOW } from '../../../packages/governance/tests/helpers.ts';
function request(id='request'):FixtureRequest{return {requestId:id,sessionId:'session',protocol:'responses',model:'fixture-model',template:'text',route:{mode:'native',provider:'fixture',accountRef:'fixture-a'},dataScope:'synthetic',maxInputTokens:128,maxOutputTokens:128};}
async function setup(t:{after(f:()=>void|Promise<void>):void},scenario:FixtureScenario='normal'){
 const h=harness(t);const provider=await createLocalProviderFixture({scenario});t.after(()=>provider.close());
 const fn=(host as unknown as {createModelFixtureTool:(p:typeof provider,r:FixtureRequest)=>Parameters<typeof createGovernance>[0]['tools'][number]}).createModelFixtureTool;assert.equal(typeof fn,'function');
 const req=request();const tool=fn(provider,req);const gov=createGovernance({repository:h.store,engine:h.engine,clock:()=>NOW,tools:[tool]});
 const op=operation('model',{toolId:tool.id,toolVersion:tool.version,target:'owned-provider',payload:{request:req as never},route:{...req.route,model:req.model}});
 h.quote(op);const token=gov.admin.approve(op,NOW+30000);
 return {h,provider,gov,op,token,req,fn};
}
test('governed HTTP completes once and settles trusted fixture cash separately from usage',async t=>{
 const {h,provider,gov,op,token}=await setup(t);const effect=h.claim(op);
 const result=await gov.gateway.execute(effect,token);assert.equal(result.status,'succeeded');
 assert.deepEqual(await gov.gateway.execute(effect,token),result);assert.equal(provider.observation().posts,1);
 assert.equal(gov.ledger.budget('task')!.spentMinor,500);assert.equal(gov.ledger.budget('task')!.heldMinor,0);
});
test('denied missing revoked expired changed requests never issue HTTP',async t=>{
 for(const mode of ['missing','revoked','expired','changed']){
  const {h,provider,gov,op,token}=await setup(t);
  if(mode==='revoked')gov.admin.revoke(token);
  let effect=h.claim(mode==='changed'?{...op,route:{...op.route,accountRef:'fixture-b'}}:op);
  if(mode==='expired'){const now=NOW+30000;const altered=createGovernance({repository:h.store,engine:h.engine,clock:()=>now,tools:[(host as unknown as {createModelFixtureTool:(p:typeof provider,r:FixtureRequest)=>Parameters<typeof createGovernance>[0]['tools'][number]}).createModelFixtureTool(provider,request())]});await assert.rejects(altered.gateway.execute(effect,token));}
  else await assert.rejects(gov.gateway.execute(effect,mode==='missing'?'':token));
  assert.equal(provider.observation().posts,0);assert.equal(gov.ledger.budget('task')!.heldMinor,0);
 }
});
test('two 1200 requests under 2000 reserve before HTTP and send only one',async t=>{
 const {h,provider,gov,op,token}=await setup(t,'stall');const otherReq=request('second');
 const tool=(host as unknown as {createModelFixtureTool:(p:typeof provider,r:FixtureRequest)=>Parameters<typeof createGovernance>[0]['tools'][number]}).createModelFixtureTool(provider,otherReq);
 const secondGov=createGovernance({repository:h.store,engine:h.engine,clock:()=>NOW,tools:[tool]});
 const second={...op,id:'second',quoteId:'quote-second',payload:{request:otherReq as never}};
 h.quote(second);const secondToken=secondGov.admin.approve(second,NOW+30000);
 const effects=[h.claim(op),h.claim(second)];
 const results=await Promise.allSettled([gov.gateway.execute(effects[0],token),secondGov.gateway.execute(effects[1],secondToken)]);
 assert.equal(results.filter(r=>r.status==='rejected').length,1);assert.equal(provider.observation().posts,1);
 assert.equal(gov.ledger.budget('task')!.heldMinor,1200);assert.equal(h.engine.getTask('task')!.status,'blocked');
});
test('known early rejection releases but accepted errors and uncertain bills retain hold',async t=>{
 for(const scenario of ['early-429','early-503','late-503','partial','missing-invoice','usage-conflict'] as const){
  const {h,provider,gov,op,token}=await setup(t,scenario);const effect=h.claim(op);const result=await gov.gateway.execute(effect,token);
  if(scenario.startsWith('early')){assert.equal(result.status,'not_executed');assert.equal(gov.ledger.budget('task')!.heldMinor,0);}
  else {assert.equal(result.status,'unknown');assert.equal(gov.ledger.budget('task')!.heldMinor,1200);assert.equal(h.engine.getTask('task')!.status,'blocked');
   gov.admin.reconcile(op.id,{resolution:'succeeded',actualCashMinor:500,result:null,evidence:'owned fixture invoice manually checked'});
   assert.equal(gov.ledger.budget('task')!.spentMinor,500);assert.equal(h.engine.getTask('task')!.status,'blocked');
   await gov.gateway.execute(h.store.getEffect(effect.effectId)!,token);
  }
  assert.equal(provider.observation().posts,1);
 }
});
test('reported zero usage is not free cash and overrun invoice is recorded',async t=>{
 for(const scenario of ['zero-usage','missing-usage','overrun'] as const){
  const {h,provider,gov,op,token}=await setup(t,scenario);await gov.gateway.execute(h.claim(op),token);
  assert.equal(gov.ledger.budget('task')!.spentMinor,scenario==='overrun'?2500:500);
  assert.equal(gov.ledger.budget('task')!.breached,scenario==='overrun');assert.equal(provider.observation().posts,1);
 }
});

test('unknown quote cannot authorize or dispatch a local model request',async t=>{
 const {h,provider,gov,op}=await setup(t);
 const unknown={...op,id:'unknown-price',quoteId:'unknown-price-quote'};
 gov.admin.issueQuote(unknown,null,NOW+60000,'fixture');
 assert.throws(()=>gov.admin.approve(unknown,NOW+30000));
 assert.equal(provider.observation().posts,0);assert.equal(gov.ledger.budget('task')!.heldMinor,0);
});
test('Outbox joins real local HTTP receipt and durable task ledger',async t=>{
 const {h,provider,gov,op,token}=await setup(t);h.enqueue(op);
 await new Outbox(h.store,h.engine,()=>new Date(NOW).toISOString()).dispatchOne(gov.gateway.executor(()=>token));
 assert.equal(h.store.getEffect('effect-'+op.id)!.status,'succeeded');
 assert.equal(provider.observation().posts,1);assert.equal(gov.ledger.budget('task')!.spentMinor,500);
});
