import {checkSmokePrice,SMOKE_PRICE_BASIS} from './deepseek-price.ts';
import {randomUUID} from 'node:crypto';
import {canonicalJson} from '@daming/core';
import type {JsonValue} from '@daming/core';
import type {ModelRequestTool,ModelRequestOperation} from '@daming/governance';
import type {PreparedModelRequest,ModelPermit,EmbeddedResult} from '@daming/model-gateway';
export interface ModelExecutionPort {execute(p:ModelPermit):Promise<EmbeddedResult>;}
/** One approved real request; estimated usage is never presented as confirmed cash. */
export function createEmbeddedModelTool(runtime:ModelExecutionPort,input:PreparedModelRequest):ModelRequestTool{
 checkSmokePrice();
 const prepared=JSON.parse(canonicalJson(input)) as PreparedModelRequest;
 return Object.freeze({id:'model.deepseek.request',version:'1',operationKind:'model_request',
  async execute(op:Readonly<ModelRequestOperation>,limits:{maximumCashMinor:number;expiresMs:number}){
   if(op.toolId!=='model.deepseek.request'||op.toolVersion!=='1'||op.target!==prepared.upstreamUrl||op.amountMinor!==0||limits.maximumCashMinor!==500||limits.expiresMs<=Date.now()||canonicalJson(op.payload)!==canonicalJson({prepared,priceBasisId:SMOKE_PRICE_BASIS.id})||canonicalJson(op.route)!==canonicalJson({mode:'native',provider:'deepseek',model:'deepseek-flash',accountRef:'deepseek-default'}))return {status:'not_executed',reason:'prepared_model_binding_mismatch'};
   try{
    checkSmokePrice();
    const result=await runtime.execute({preparedId:prepared.preparedId,digest:prepared.digest,requestId:prepared.requestId,operationId:op.id,expiresMs:Math.min(limits.expiresMs,Date.now()+20000),maximumCashMinor:500,permitId:randomUUID()});
    if(result.status==='not_executed')return {status:'not_executed',reason:'engine_confirmed_not_sent'};
    return {status:'unknown',reason:result.status==='completed'?'model_complete_cash_unconfirmed':'model_outcome_unknown',observation:JSON.parse(JSON.stringify({inferenceCompleted:result.status==='completed',cashConfirmed:false,text:result.text,usage:result.usage,providerRequestId:result.providerRequestId,outboundAttempts:result.outboundAttempts,requestId:result.requestId})) as JsonValue};
   }catch{return {status:'unknown',reason:'model_transport_unknown'};}
  }
 } satisfies ModelRequestTool);
}
