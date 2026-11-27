import type { WorkerDescriptor,RoutingRequest } from './descriptors.ts';
export interface RoutingDecision {selected?:WorkerDescriptor;eligible:WorkerDescriptor[];excluded:{workerId:string;reasons:string[]}[];}
export function routeWorkers(workers:readonly WorkerDescriptor[],request:RoutingRequest):RoutingDecision {
  const eligible:WorkerDescriptor[]=[];const excluded:RoutingDecision['excluded']=[];
  if(!Number.isSafeInteger(request.maxCashMinor)||request.maxCashMinor<0)throw new Error('Invalid cash ceiling');
  for(const worker of workers) {
    const reasons:string[]=[];
    if(worker.executionMode==='unavailable'||
       (worker.executionMode==='fixture'&&request.allowFixture!==true)||
       (worker.executionMode==='real'&&request.allowReal!==true))reasons.push('execution_mode_not_allowed');
    if(worker.health!=='ready')reasons.push('unhealthy');
    if(worker.credentialsReady!==true)reasons.push('credentials_unavailable');
    if(worker.os!==request.os)reasons.push('os_mismatch');
    if(worker.provider!==request.provider)reasons.push('provider_mismatch');
    if(request.model!==undefined&&worker.model!==request.model)reasons.push('model_mismatch');
    if(worker.routeMode!==request.routeMode)reasons.push('route_mode_mismatch');
    if(worker.routeMode==='magpie'&&worker.gatewayVerified!==true)reasons.push('gateway_compatibility_unverified');
    if(!request.capabilities.every(x=>worker.capabilities.includes(x)))reasons.push('capabilities_missing');
    if(!request.permissions.every(x=>worker.permissions.includes(x)))reasons.push('permissions_missing');
    if(worker.network!==request.network)reasons.push('network_mismatch');
    if(!worker.dataScopes.includes(request.dataScope))reasons.push('data_scope_denied');
    if(worker.priceVerified!==true||worker.maxCashMinor===null||!Number.isSafeInteger(worker.maxCashMinor)||worker.maxCashMinor<0)reasons.push('unknown_price');
    else if(worker.maxCashMinor>request.maxCashMinor)reasons.push('cash_ceiling_exceeded');
    if(!Number.isFinite(worker.quotaRemaining)||worker.quotaRemaining<=0)reasons.push('quota_unavailable');
    if(!Number.isSafeInteger(worker.activeCount)||!Number.isSafeInteger(worker.concurrencyLimit)||worker.activeCount<0||worker.concurrencyLimit<1||worker.activeCount>=worker.concurrencyLimit)reasons.push('concurrency_unavailable');
    if(worker.executionMode==='fixture'&&worker.isolation!=='fixture_only')reasons.push('only_fixture_isolation_verified');
    if(worker.executionMode==='real'&&!['supervised','enforced'].includes(worker.isolation))reasons.push('real_isolation_unverified');
    if(reasons.length)excluded.push({workerId:worker.id,reasons});else eligible.push(structuredClone(worker));
  }
  const measured=(w:WorkerDescriptor)=>!!w.metrics&&Number.isSafeInteger(w.metrics.samples)&&w.metrics.samples>0&&Number.isSafeInteger(w.metrics.successes)&&w.metrics.successes>=0&&w.metrics.successes<=w.metrics.samples&&Number.isFinite(w.metrics.latencyMs)&&w.metrics.latencyMs>=0;
  const success=(w:WorkerDescriptor)=>measured(w)?w.metrics!.successes/w.metrics!.samples:-1;
  const latency=(w:WorkerDescriptor)=>measured(w)?w.metrics!.latencyMs:Infinity;
  eligible.sort((a,b)=>success(b)-success(a)||(a.maxCashMinor!-b.maxCashMinor!)||(latency(a)-latency(b))||(a.id<b.id?-1:a.id>b.id?1:0));
  return {selected:eligible[0],eligible,excluded};
}
