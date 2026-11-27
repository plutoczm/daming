import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as api from '../src/index.ts';
import type { FixtureRequest } from '../src/gateway-port.ts';
type Provider={close():Promise<void>;observation():{posts:number;discoveries:number;active:number};invoice(r:FixtureRequest):unknown};
type API={createLocalProviderFixture(o:{scenario:string;mode?:string}):Promise<Provider>;requestFixture(p:Provider,r:FixtureRequest,o?:{signal?:AbortSignal;totalMs?:number;idleMs?:number}):Promise<{status:string;usage?:unknown;reason?:string}>};
const gateway=api as unknown as API;
function request(protocol:'responses'|'messages'='responses'):FixtureRequest{return {requestId:'req',sessionId:'session',protocol,model:'fixture-model',template:'text',route:{mode:'native',provider:'fixture',accountRef:'fixture-a'},dataScope:'synthetic',maxInputTokens:128,maxOutputTokens:128};}
async function setup(t:{after(f:()=>Promise<void>):void},scenario='normal'){assert.equal(typeof gateway.createLocalProviderFixture,'function');const p=await gateway.createLocalProviderFixture({scenario});t.after(()=>p.close());return p;}
test('owned provider serves both finite protocols and stores a separate invoice',async t=>{
 for(const protocol of ['responses','messages'] as const){const p=await setup(t);assert.equal((await gateway.requestFixture(p,request(protocol))).status,'completed');assert.equal(p.observation().posts,1);assert.ok(p.invoice(request(protocol)));await p.close();assert.equal(p.observation().active,0);}
});
test('forged closed endpoints and altered synthetic templates cannot issue inference',async t=>{
 const p=await setup(t);
 await assert.rejects(gateway.requestFixture({...p} as Provider,request()));
 await assert.rejects(gateway.requestFixture(p,{...request(),template:'private-input'} as unknown as FixtureRequest));
 assert.equal(p.observation().posts,0);await p.close();await assert.rejects(gateway.requestFixture(p,request()));assert.equal(p.observation().posts,0);
});
test('HTTP errors redirect malformed and partial output never retry',async t=>{
 for(const scenario of ['early-429','early-503','late-503','redirect','malformed','partial','wrong-identity','oversized','unknown-event']){
  const p=await setup(t,scenario);const r=await gateway.requestFixture(p,request());assert.notEqual(r.status,'completed',scenario);assert.equal(p.observation().posts,1,scenario);await p.close();assert.equal(p.observation().active,0);
 }
});
test('idle total timeout and abort end stalled requests and retain one attempt',async t=>{
 for(const mode of ['idle','total','abort']){
  const p=await setup(t,mode==='total'?'heartbeat':'stall');const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  if(mode==='abort')timer=setTimeout(()=>controller.abort(),30);
  const r=await gateway.requestFixture(p,request(),{signal:controller.signal,totalMs:mode==='total'?70:500,idleMs:mode==='idle'?30:300});if(timer)clearTimeout(timer);
  assert.equal(r.status,'unknown');assert.equal(p.observation().posts,1);await p.close();assert.equal(p.observation().active,0);
 }
});
test('pre-aborted calls send no HTTP',async t=>{
 const p=await setup(t);const c=new AbortController();c.abort();
 const r=await gateway.requestFixture(p,request(),{signal:c.signal});assert.equal(r.status,'unknown');assert.equal(p.observation().posts,0);
});
test('usage reports may be missing zero or conflict without changing trusted bill',async t=>{
 for(const scenario of ['missing-usage','zero-usage','usage-conflict','missing-invoice','overrun']){
  const p=await setup(t,scenario);const r=await gateway.requestFixture(p,request());assert.equal(r.status,'completed');
  if(scenario==='missing-usage')assert.equal(r.usage,undefined);
  if(scenario==='zero-usage')assert.deepEqual(r.usage,{inputTokens:0,outputTokens:0});
  if(scenario==='missing-invoice')assert.equal(p.invoice(request()),undefined);
 }
});

test('fixture discovery stays separate and never declares real protocol readiness',async t=>{
 const p=await gateway.createLocalProviderFixture({scenario:'normal',mode:'magpie'});t.after(()=>p.close());
 const discover=(api as unknown as {discoverFixture:(p:Provider)=>Promise<{status:string;verifiedProtocols:string[]}>}).discoverFixture;assert.equal(typeof discover,'function');
 const observation=await discover(p);assert.equal(observation.status,'available');assert.deepEqual(observation.verifiedProtocols,[]);
 assert.equal(p.observation().discoveries,2);assert.equal(p.observation().posts,0);
 const r={...request('messages'),route:{mode:'magpie' as const,provider:'fixture' as const,accountRef:'fixture-a' as const}};
 assert.equal((await gateway.requestFixture(p,r)).status,'completed');assert.equal(p.observation().posts,1);
});
test('foreign context and repeated attempted request ids never dispatch again',async t=>{
 const p=await setup(t,'partial');
 await assert.rejects(gateway.requestFixture(p,{...request(),context:{binding:'foreign-account'}}));assert.equal(p.observation().posts,0);
 await gateway.requestFixture(p,request());await assert.rejects(gateway.requestFixture(p,request()));assert.equal(p.observation().posts,1);
});
