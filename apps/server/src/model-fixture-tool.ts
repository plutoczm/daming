import { normalizeRequest,requestKey,bindingKey,evaluateRoute,requestFixture,reconcileUsage } from '@daming/model-gateway';
import type { FixtureProvider,FixtureRequest } from '@daming/model-gateway';
import type { FixtureTool } from '@daming/governance';
import type { JsonValue } from '@daming/core';
/** Trusted Host composition for owned synthetic HTTP services only. */
export function createModelFixtureTool(provider:FixtureProvider,input:FixtureRequest):FixtureTool {
 const request=normalizeRequest(input),key=requestKey(request);
 return Object.freeze({
  id:'fixture.model-request',version:'1',fixtureOnly:true,
  async execute(operation){
   try {
    if(operation.executorKind!=='fixture'||operation.toolId!=='fixture.model-request'||operation.toolVersion!=='1'||operation.target!=='owned-provider'||operation.amountMinor!==0)throw new Error('unsupported_fixture_operation');
    const payload=operation.payload;
    if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).length!==1||!('request' in payload)||requestKey(payload.request as unknown as FixtureRequest)!==key)throw new Error('fixture_request_changed');
    if(operation.route.mode!==request.route.mode||operation.route.provider!==request.route.provider||operation.route.accountRef!==request.route.accountRef||operation.route.model!==request.model)throw new Error('fixture_route_changed');
    const policy=evaluateRoute(request,{available:true,protocols:['responses','messages'],streaming:true,tools:true,approvedAccounts:[request.route.accountRef],dataScopes:['synthetic'],quoteMinor:0,binding:bindingKey(request)});
    if(!policy.allowed)throw new Error('fixture_scope_denied');
   }catch{return {status:'not_executed',reason:'invalid_synthetic_operation'};}
   try {
    const result=await requestFixture(provider,request);
    const invoice=provider.invoice(request);
    if(!invoice)return {status:'unknown',reason:'missing_fixture_invoice'};
    if(!invoice.executed)return {status:'not_executed',reason:'fixture_confirmed_early_rejection'};
    if(result.status!=='completed')return {status:'unknown',reason:'incomplete_fixture_result'};
    const reconciliation=reconcileUsage(request.protocol,result.usage,invoice.usage);
    if(reconciliation==='conflict')return {status:'unknown',reason:'fixture_usage_conflict'};
    return {status:'succeeded',actualCashMinor:invoice.actualCashMinor,result:JSON.parse(JSON.stringify({mode:'model_fixture',protocol:request.protocol,routeMode:request.route.mode,text:result.text,tools:result.tools,usage:result.usage,usageReconciliation:reconciliation,billingSource:'fixture',evidenceId:invoice.evidenceId})) as JsonValue};
   }catch{return {status:'unknown',reason:'fixture_transport_unknown'};}
  }
 } satisfies FixtureTool);
}
