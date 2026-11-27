import {bindingKey,normalizeRequest} from './gateway-port.ts';
import type { FixtureRequest,Protocol } from './gateway-port.ts';
export interface RoutePolicy {available:boolean;protocols:readonly Protocol[];streaming:boolean;tools:boolean;approvedAccounts:readonly string[];dataScopes:readonly string[];quoteMinor:number|null;binding?:string;contextBinding?:string;}
export function evaluateRoute(input:FixtureRequest,policy:RoutePolicy):{allowed:boolean;reasons:string[]} {
 const reasons:string[]=[];let r:FixtureRequest;
 try{r=normalizeRequest(input);}catch{return {allowed:false,reasons:['invalid_request']};}
 if(!policy.available)reasons.push('unavailable');
 if(!policy.protocols.includes(r.protocol))reasons.push('protocol');
 if(!policy.streaming)reasons.push('streaming');if(r.template==='tool'&&!policy.tools)reasons.push('tools');
 if(!policy.approvedAccounts.includes(r.route.accountRef))reasons.push('account');
 if(!policy.dataScopes.includes(r.dataScope))reasons.push('data_scope');
 if(policy.quoteMinor===null||!Number.isSafeInteger(policy.quoteMinor)||policy.quoteMinor<0)reasons.push('unknown_price');
 const key=bindingKey(r);
 if(policy.binding!==undefined&&policy.binding!==key)reasons.push('session_binding');
 if((policy.contextBinding!==undefined&&policy.contextBinding!==key)||(r.context!==undefined&&r.context.binding!==key))reasons.push('context_binding');
 return {allowed:reasons.length===0,reasons};
}
