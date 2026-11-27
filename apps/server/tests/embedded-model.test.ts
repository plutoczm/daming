import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as host from '../src/index.ts';
import { SMOKE_PRICE_BASIS } from '../src/deepseek-price.ts';
test('embedded Host tool binds preparation and preserves real output without inventing cash',async(t)=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-12T12:00:00Z')});
 const make=(host as unknown as {createEmbeddedModelTool:Function}).createEmbeddedModelTool;assert.equal(typeof make,'function');
 const prepared={preparedId:'p',digest:'a'.repeat(64),requestId:'r',model:'deepseek-flash',protocol:'responses',keyRef:'deepseek-default',maxOutputTokens:128,upstreamUrl:'https://api.deepseek.com/chat/completions',bodyBytes:'{}'};
 let calls=0;const tool=make({execute:async(p:Record<string,unknown>)=>{calls++;assert.equal(p.maximumCashMinor,500);return {status:'completed',requestId:'r',text:'OK',usage:{input:8,output:1}};}},prepared);
 const op={id:'op',operationKind:'model_request',toolId:tool.id,toolVersion:tool.version,target:prepared.upstreamUrl,amountMinor:0,payload:{prepared,priceBasisId:SMOKE_PRICE_BASIS.id},route:{mode:'native',provider:'deepseek',model:'deepseek-flash',accountRef:'deepseek-default'}};
 const bad=await tool.execute({...op,payload:{prepared:{...prepared,preparedId:'changed'}}},{maximumCashMinor:500,expiresMs:Date.now()+30000});assert.equal(bad.status,'not_executed');assert.equal(calls,0);
 const ok=await tool.execute(op,{maximumCashMinor:500,expiresMs:Date.now()+30000});assert.equal(ok.status,'unknown');assert.equal(ok.observation.text,'OK');assert.equal(ok.observation.cashConfirmed,false);assert.equal(calls,1);
});
