import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createGovernance} from '../src/index.ts';
import type {ModelRequestOperation,ModelRequestTool} from '../src/index.ts';
import {normalizeOperation} from '../src/binding.ts';
import {harness,operation,NOW} from './helpers.ts';
function modelOperation():ModelRequestOperation{
 const {executorKind,...base}=operation('model');
 return {...base,operationKind:'model_request',toolId:'provider.request',target:'https://api.deepseek.com/chat/completions',route:{mode:'native',provider:'deepseek',model:'deepseek-flash',accountRef:'deepseek-default'},payload:{preparedId:'prepared',digest:'bound',requestId:'request'}};
}
test('model_request has explicit admission separate from fixture executors',async t=>{
 const h=harness(t);let calls=0;const op=modelOperation();
 const tool:ModelRequestTool={id:'provider.request',version:'1',operationKind:'model_request',execute:async(_op,limits)=>{calls++;assert.equal(limits.maximumCashMinor,500);return {status:'unknown',reason:'billing_pending',observation:{inferenceCompleted:true,text:'OK',cashConfirmed:false}};}};
 const gov=createGovernance({repository:h.store,engine:h.engine,clock:()=>NOW,tools:[],modelTools:[tool]});
 gov.admin.issueQuote(op,500,NOW+60000,'official_api');const token=gov.admin.approve(op,NOW+30000);
 const effect=h.claim(op);const outcome=await gov.gateway.execute(effect,token);
 assert.equal(calls,1);assert.equal(outcome.status,'unknown');
 assert.equal(gov.ledger.budget('task')!.heldMinor,500);assert.equal(h.engine.getTask('task')!.status,'blocked');
 assert.deepEqual(h.store.governanceGet('executions','model')!.observation,{cashConfirmed:false,inferenceCompleted:true,text:'OK'});
 await gov.gateway.execute(h.store.getEffect(effect.effectId)!,token);assert.equal(calls,1);
});
test('model calls require registered tool and matching unexpired capability',async t=>{
 for(const mode of ['unregistered','missing','changed','expired','wrong_billing']){
  const h=harness(t);let calls=0;const op=modelOperation();
  const gov=createGovernance({repository:h.store,engine:h.engine,clock:()=>mode==='expired'?NOW+30000:NOW,tools:[],modelTools:mode==='unregistered'?[]:[{id:'provider.request',version:'1',operationKind:'model_request',execute:async()=>{calls++;return {status:'unknown',reason:'not_expected'};}}]});
  h.governance.admin.issueQuote(op,500,NOW+60000,mode==='wrong_billing'?'fixture':'official_api');const token=h.governance.admin.approve(op,NOW+30000);
  const actual=mode==='changed'?{...op,payload:{preparedId:'other',digest:'changed',requestId:'request'}}:op;
  await assert.rejects(gov.gateway.execute(h.claim(actual),mode==='missing'?'':token));assert.equal(calls,0);assert.equal(gov.ledger.budget('task')!.heldMinor,0);
 }
});
test('legacy operations retain their representation and cannot masquerade as model requests',()=>{
 const old=operation();assert.deepEqual(normalizeOperation(old),old);assert.equal(Object.hasOwn(normalizeOperation(old),'operationKind'),false);
 assert.throws(()=>normalizeOperation({...modelOperation(),executorKind:'fixture'} as unknown as ModelRequestOperation));
 assert.throws(()=>normalizeOperation({...old,operationKind:'unknown'} as never));
});
