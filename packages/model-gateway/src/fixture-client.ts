import {request as httpRequest} from 'node:http';
import type {IncomingMessage,ClientRequest} from 'node:http';
import {ProtocolDecoder} from './protocol-decoder.ts';
import {normalizeRequest,bindingKey} from './gateway-port.ts';
import type {FixtureRequest,ProtocolResult} from './gateway-port.ts';
import {ownedState} from './fixture-provider.ts';
import type {FixtureProvider} from './fixture-provider.ts';
import {wireRequest} from './fixture-wire.ts';
export async function requestFixture(provider:FixtureProvider,input:FixtureRequest,options:{signal?:AbortSignal;totalMs?:number;idleMs?:number}={}):Promise<ProtocolResult>{
 const state=ownedState(provider),r=normalizeRequest(input);
 if(r.context&&r.context.binding!==bindingKey(r))throw new Error('context_binding');
 if(r.route.mode!==state.mode)throw new Error('fixture_route_mismatch');
 if(Object.keys(options).some(k=>!['signal','totalMs','idleMs'].includes(k)))throw new Error('unsupported_http_options');
 const total=options.totalMs??2000,idle=options.idleMs??500;for(const n of [total,idle])if(!Number.isSafeInteger(n)||n<1||n>60000)throw new Error('invalid_deadline');
 const unknown=(reason:string):ProtocolResult=>({status:'unknown',text:'',tools:[],reason});
 if(options.signal?.aborted)return unknown('cancelled_before_send');
 if(state.attempted.has(r.requestId))throw new Error('request_already_attempted');
 const body=Buffer.from(JSON.stringify(wireRequest(r)));if(body.length>65536)throw new Error('request_limit');
 state.attempted.add(r.requestId);
 return await new Promise<ProtocolResult>(resolve=>{
  const decoder=new ProtocolDecoder(r.protocol);let req:ClientRequest;let response:IncomingMessage|undefined;let answer:ProtocolResult|undefined;let done=false;
  let idleTimer:ReturnType<typeof setTimeout>|undefined;
  const totalTimer=setTimeout(()=>finish(unknown('total_timeout')),total);
  const abort=()=>finish(unknown('cancelled'));
  const clear=()=>{clearTimeout(totalTimer);if(idleTimer)clearTimeout(idleTimer);options.signal?.removeEventListener('abort',abort);};
  const finish=(result:ProtocolResult)=>{if(done)return;done=true;answer=result;clear();response?.destroy();req.destroy();};
  const resetIdle=()=>{if(idleTimer)clearTimeout(idleTimer);idleTimer=setTimeout(()=>finish(unknown('idle_timeout')),idle);};
  req=httpRequest({host:'127.0.0.1',port:state.port,path:r.protocol==='responses'?'/v1/responses':'/v1/messages',method:'POST',agent:false,headers:{'content-type':'application/json','content-length':body.length,'connection':'close'}},res=>{
   response=res;
   if(res.statusCode!==200||!res.headers['content-type']?.startsWith('text/event-stream')){finish(unknown('http_rejected'));return;}
   res.on('data',(bytes:Buffer)=>{resetIdle();decoder.push(bytes);if(decoder.failed)finish(decoder.finish());});
   res.on('end',()=>finish(decoder.finish()));
   res.on('aborted',()=>finish(unknown('response_aborted')));res.on('error',()=>finish(unknown('response_error')));
  });
  req.on('error',()=>finish(unknown('connection_failed')));
  req.on('close',()=>{if(!done){done=true;clear();answer=unknown('connection_closed');}resolve(answer!);});
  options.signal?.addEventListener('abort',abort,{once:true});resetIdle();req.end(body);
 });
}
