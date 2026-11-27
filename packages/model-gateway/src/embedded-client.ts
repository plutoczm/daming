import {request as httpRequest} from 'node:http';
import type {IncomingMessage} from 'node:http';
import {record,integer,string} from './gateway-port.ts';
export interface EmbeddedProtocolEvent {requestId:string;data:Record<string,unknown>;}
export interface EmbeddedBootstrap {name:'daming-gateway';version:'1';instanceId:string;url:string;token:string;created:boolean;}
export interface EmbeddedHealth {name:'daming-gateway';version:'1';instanceId:string;upstreamRevision:string;configured:boolean;buildId:string;}
export interface EmbeddedRequest {requestId:string;protocol:'responses'|'messages';model:'deepseek-flash';input:string;maxOutputTokens:128;}
export interface PreparedModelRequest {preparedId:string;digest:string;requestId:string;model:'deepseek-flash';protocol:'responses'|'messages';keyRef:'deepseek-default';maxOutputTokens:128;upstreamUrl:'https://api.deepseek.com/chat/completions';bodyBytes:string;}
export interface ModelPermit {preparedId:string;digest:string;requestId:string;operationId:string;expiresMs:number;maximumCashMinor:500;permitId:string;}
export interface EmbeddedResult {status:'completed'|'unknown'|'not_executed';requestId:string;text:string;usage?:Record<string,unknown>;providerRequestId?:string;reason?:string;outboundAttempts?:number;}
export class EmbeddedGatewayError extends Error {readonly code:string;constructor(code:string){super(code);this.code=code;}}
export const MAGPIE_REVISION='1615e5a149acbaed6e9395ddb9775f96d95e4728';
function fail():never{throw new EmbeddedGatewayError('invalid_gateway_response');}
function keys(obj:Record<string,unknown>,allowed:readonly string[]):void{if(Object.keys(obj).some(k=>!allowed.includes(k)))fail();}
function id(v:unknown):string{return string(v);}
export function normalizeEmbeddedRequest(value:unknown):EmbeddedRequest {
 const r=record(value);keys(r,['requestId','protocol','model','input','maxOutputTokens']);
 id(r.requestId);if(!['responses','messages'].includes(r.protocol as string)||r.model!=='deepseek-flash'||r.maxOutputTokens!==128||typeof r.input!=='string'||!r.input.trim()||Buffer.byteLength(r.input)>1024)throw new EmbeddedGatewayError('unsupported_model_request');
 return structuredClone(r) as unknown as EmbeddedRequest;
}
/** Host-only private transport. Bootstrap secrets are never enumerable/public DTOs. */
export class EmbeddedGatewayClient {
 #bootstrap:EmbeddedBootstrap;#timeout:number;#onEvent?: (event:EmbeddedProtocolEvent)=>void;
 constructor(descriptor:EmbeddedBootstrap,options:{timeoutMs?:number;onEvent?:(event:EmbeddedProtocolEvent)=>void}={}){
  const d=record(descriptor);keys(d,['name','version','instanceId','url','token','created']);
  let url:URL;try{url=new URL(String(d.url));}catch{throw new EmbeddedGatewayError('invalid_bootstrap');}
  if(d.name!=='daming-gateway'||d.version!=='1'||typeof d.created!=='boolean'||url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash||typeof d.token!=='string'||!/^[A-Za-z0-9_-]{32,256}$/.test(d.token))throw new EmbeddedGatewayError('invalid_bootstrap');
  id(d.instanceId);this.#bootstrap=structuredClone(descriptor);this.#bootstrap.url=url.origin;
  const timeout=options.timeoutMs??30000;if(!Number.isSafeInteger(timeout)||timeout<1||timeout>60000)throw new EmbeddedGatewayError('invalid_timeout');this.#timeout=timeout;this.#onEvent=options.onEvent;
 }
 async #json(method:'GET'|'POST',path:string,body?:unknown):Promise<unknown>{
  const url=new URL(this.#bootstrap.url);const bytes=body===undefined?undefined:Buffer.from(JSON.stringify(body));
  if(bytes&&bytes.length>65536)throw new EmbeddedGatewayError('request_limit');
  return await new Promise((resolve,reject)=>{
   const chunks:Buffer[]=[];let size=0;let response:IncomingMessage|undefined;let value:unknown;let error:EmbeddedGatewayError|undefined;
   const req=httpRequest({host:'127.0.0.1',port:Number(url.port),path,method,agent:false,headers:{authorization:'Bearer '+this.#bootstrap.token,connection:'close',...(bytes?{'content-type':'application/json','content-length':bytes.length}:{})}},res=>{
    response=res;
    if(res.statusCode!==200||!res.headers['content-type']?.startsWith('application/json')){error=new EmbeddedGatewayError('gateway_http_error');res.destroy();req.destroy();return;}
    res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>1048576){error=new EmbeddedGatewayError('gateway_response_limit');res.destroy();req.destroy();}else chunks.push(chunk);});
    res.on('end',()=>{try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{error=new EmbeddedGatewayError('invalid_gateway_json');}req.destroy();});
    res.on('aborted',()=>{error??=new EmbeddedGatewayError('gateway_response_aborted');req.destroy();});res.on('error',()=>{error??=new EmbeddedGatewayError('gateway_response_error');req.destroy();});
   });
   const timer=setTimeout(()=>{error=new EmbeddedGatewayError('gateway_timeout');response?.destroy();req.destroy();},this.#timeout);
   req.on('error',()=>{error??=new EmbeddedGatewayError('gateway_connection_error');});
   req.on('close',()=>{clearTimeout(timer);if(error||value===undefined)reject(error??new EmbeddedGatewayError('gateway_closed'));else resolve(value);});
   req.end(bytes);
  });
 }
 async #stream(input:ModelPermit):Promise<unknown>{
  const bytes=Buffer.from(JSON.stringify(input)),url=new URL(this.#bootstrap.url);
  return await new Promise((resolve,reject)=>{
   let response:IncomingMessage|undefined,total=0,events=0,buffer='',answer:unknown,error:Error|undefined,started=false,terminal=false;
   const decoder=new TextDecoder('utf-8',{fatal:true});
   const stop=(code:string)=>{error??=new EmbeddedGatewayError(code);response?.destroy();req.destroy();};
   const line=(text:string)=>{
    if(!text)return;if(Buffer.byteLength(text)>65536||++events>256||answer!==undefined)throw new Error('stream_limit_or_after_result');
    const frame=record(JSON.parse(text));keys(frame,['event','requestId','data']);if(frame.requestId!==input.requestId)throw new Error('stream_identity');
    const data=record(frame.data);
    if(frame.event==='result'){if(data.status==='completed'&&(!started||!terminal))throw new Error('missing_protocol_terminal');answer=data;return;}
    if(frame.event!=='protocol')throw new Error('unknown_stream_frame');
    const type=String(data.type);
    const known=['response.created','response.output_item.added','response.content_part.added','response.output_text.delta','response.output_text.done','response.content_part.done','response.output_item.done','response.completed','response.incomplete','message_start','content_block_start','content_block_delta','content_block_stop','message_delta','message_stop','error'];
    if(!known.includes(type)||terminal)throw new Error('unsupported_protocol_event');
    if(type==='response.created'||type==='message_start'){if(started)throw new Error('duplicate_protocol_start');started=true;}
    else if(!started&&type!=='error')throw new Error('missing_protocol_start');
    if(['response.completed','response.incomplete','message_stop','error'].includes(type))terminal=true;
    this.#onEvent?.({requestId:input.requestId,data:structuredClone(data)});
   };
   const consume=(chunk:string)=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){line(buffer.slice(0,end).replace(/\r$/,''));buffer=buffer.slice(end+1);}if(Buffer.byteLength(buffer)>65536)throw new Error('stream_frame_limit');};
   const req=httpRequest({host:'127.0.0.1',port:Number(url.port),path:'/internal/execute',method:'POST',agent:false,headers:{authorization:'Bearer '+this.#bootstrap.token,'content-type':'application/json',accept:'application/x-ndjson','content-length':bytes.length,connection:'close'}},res=>{
    response=res;if(res.statusCode!==200||!res.headers['content-type']?.startsWith('application/x-ndjson')){stop('gateway_stream_http_error');return;}
    res.on('data',(b:Buffer)=>{total+=b.length;if(total>1048576){stop('gateway_stream_limit');return;}try{consume(decoder.decode(b,{stream:true}));}catch{stop('gateway_stream_invalid');}});
    res.on('end',()=>{try{consume(decoder.decode());if(buffer||answer===undefined)throw new Error('truncated');}catch{error??=new EmbeddedGatewayError('gateway_stream_truncated');}req.destroy();});
    res.on('error',()=>stop('gateway_stream_error'));res.on('aborted',()=>stop('gateway_stream_aborted'));
   });
   const timer=setTimeout(()=>stop('gateway_stream_timeout'),this.#timeout);
   req.on('error',()=>{error??=new EmbeddedGatewayError('gateway_connection_error');});
   req.on('close',()=>{clearTimeout(timer);if(error||answer===undefined)reject(error??new EmbeddedGatewayError('gateway_stream_closed'));else resolve(answer);});
   req.end(bytes);
  });
 }

 async health():Promise<EmbeddedHealth>{
  const h=record(await this.#json('GET','/internal/health'));keys(h,['name','version','instanceId','upstreamRevision','configured','buildId']);
  if(h.name!=='daming-gateway'||h.version!=='1'||h.instanceId!==this.#bootstrap.instanceId||h.upstreamRevision!==MAGPIE_REVISION||typeof h.configured!=='boolean'||h.buildId!=='embedded-v3')fail();
  return h as unknown as EmbeddedHealth;
 }
 async prepare(input:EmbeddedRequest):Promise<PreparedModelRequest>{
  const r=normalizeEmbeddedRequest(input);const p=record(await this.#json('POST','/internal/prepare',r));
  keys(p,['preparedId','digest','requestId','model','protocol','keyRef','maxOutputTokens','upstreamUrl','bodyBytes']);
  id(p.preparedId);if(typeof p.digest!=='string'||!/^[a-f0-9]{64}$/.test(p.digest)||p.requestId!==r.requestId||p.model!==r.model||p.protocol!==r.protocol||p.keyRef!=='deepseek-default'||p.maxOutputTokens!==128||p.upstreamUrl!=='https://api.deepseek.com/chat/completions'||typeof p.bodyBytes!=='string'||Buffer.byteLength(p.bodyBytes)>8192)fail();
  const wire=record(JSON.parse(p.bodyBytes));keys(wire,['model','messages','stream','max_tokens','thinking','stream_options']);
  if(wire.model!==r.model||wire.stream!==true||wire.max_tokens!==128||record(wire.thinking).type!=='disabled'||!Array.isArray(wire.messages)||wire.messages.length!==1||record(wire.messages[0]).role!=='user'||record(wire.messages[0]).content!==r.input)fail();
  return structuredClone(p) as unknown as PreparedModelRequest;
 }
 async execute(input:ModelPermit):Promise<EmbeddedResult>{
  const p=record(input);keys(p,['preparedId','digest','requestId','operationId','expiresMs','maximumCashMinor','permitId']);for(const k of ['preparedId','digest','requestId','operationId','permitId'])id(p[k]);
  integer(p.expiresMs);if(p.maximumCashMinor!==500||(p.expiresMs as number)<=Date.now()||Number(p.expiresMs)>Date.now()+60000)throw new EmbeddedGatewayError('invalid_permit');
  const r=record(await this.#stream(input));keys(r,['status','requestId','text','usage','providerRequestId','reason','outboundAttempts']);
  if(!['completed','unknown','not_executed'].includes(r.status as string)||r.requestId!==input.requestId||typeof r.text!=='string'||Buffer.byteLength(r.text)>262144)fail();
  if(r.outboundAttempts!==undefined&&r.outboundAttempts!==0&&r.outboundAttempts!==1)fail();
  if(r.usage!==undefined)record(r.usage);if(r.providerRequestId!==undefined)id(r.providerRequestId);if(r.reason!==undefined)id(r.reason);
  return structuredClone(r) as unknown as EmbeddedResult;
 }
 async cancel(requestId:string):Promise<void>{id(requestId);await this.#json('POST','/internal/cancel',{requestId});}
}
