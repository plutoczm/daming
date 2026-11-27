export type Protocol='responses'|'messages';
export interface Usage {inputTokens?:number;outputTokens?:number;cacheReadTokens?:number;cacheWriteTokens?:number;}
export interface ToolCall {id:string;name:string;arguments:Record<string,unknown>;}
export interface ProtocolResult {status:'completed'|'unknown'|'unsupported';text:string;tools:ToolCall[];usage?:Usage;reason?:string;}
export interface FixtureRequest {
 requestId:string;sessionId:string;protocol:Protocol;model:'fixture-model';template:'text'|'tool';
 route:{mode:'native'|'magpie';provider:'fixture';accountRef:'fixture-a'|'fixture-b'};
 dataScope:'synthetic';maxInputTokens:128;maxOutputTokens:128;context?:{binding:string};
}
export function record(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid_object');return value as Record<string,unknown>;}
export function integer(value:unknown):number{if(!Number.isSafeInteger(value)||Number(value)<0)throw new Error('invalid_integer');return value as number;}
export function string(value:unknown):string{if(typeof value!=='string'||!value||value.length>4096)throw new Error('invalid_string');return value;}
function keys(value:Record<string,unknown>,allowed:string[]){if(Object.keys(value).some(k=>!allowed.includes(k)))throw new Error('unexpected_fields');}
export function normalizeRequest(value:unknown):FixtureRequest {
 const r=record(value);keys(r,['requestId','sessionId','protocol','model','template','route','dataScope','maxInputTokens','maxOutputTokens','context']);
 string(r.requestId);string(r.sessionId);
 if(!['responses','messages'].includes(r.protocol as string)||r.model!=='fixture-model'||!['text','tool'].includes(r.template as string)||r.dataScope!=='synthetic'||r.maxInputTokens!==128||r.maxOutputTokens!==128)throw new Error('unsupported_request');
 const route=record(r.route);keys(route,['mode','provider','accountRef']);
 if(!['native','magpie'].includes(route.mode as string)||route.provider!=='fixture'||!['fixture-a','fixture-b'].includes(route.accountRef as string))throw new Error('unsupported_route');
 if(r.context!==undefined){const c=record(r.context);keys(c,['binding']);string(c.binding);}
 return JSON.parse(JSON.stringify(r)) as FixtureRequest;
}
export function bindingKey(r:FixtureRequest):string{return JSON.stringify([r.sessionId,r.protocol,r.model,r.route.mode,r.route.provider,r.route.accountRef,r.dataScope]);}
export function requestKey(input:FixtureRequest):string{const r=normalizeRequest(input);return JSON.stringify([r.requestId,bindingKey(r),r.template,r.maxInputTokens,r.maxOutputTokens,r.context?.binding??null]);}
