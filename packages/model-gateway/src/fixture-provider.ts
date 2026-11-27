import {createServer} from 'node:http';
import type {Server,ServerResponse} from 'node:http';
import type {Socket} from 'node:net';
import {randomUUID} from 'node:crypto';
import {normalizeRequest,record,requestKey} from './gateway-port.ts';
import type {FixtureRequest,Usage} from './gateway-port.ts';
import {wireEvents,wireRequest,fixtureUsage} from './fixture-wire.ts';
const scenarios=['normal','zero-usage','missing-usage','usage-conflict','missing-invoice','overrun','early-429','early-503','late-503','partial','stall','heartbeat','malformed','redirect','wrong-identity','oversized','unknown-event'] as const;
export type FixtureScenario=typeof scenarios[number];
export interface FixtureInvoice {requestKey:string;evidenceId:string;executed:boolean;actualCashMinor:number;usage?:Usage;}
export interface FixtureProvider {close():Promise<void>;observation():{posts:number;discoveries:number;active:number};invoice(r:FixtureRequest):FixtureInvoice|undefined;}
interface State {server:Server;port:number;closed:boolean;mode:'native'|'magpie';posts:number;discoveries:number;sockets:Set<Socket>;invoices:Map<string,FixtureInvoice>;attempted:Set<string>;}
const registry=new WeakMap<object,State>();
export function ownedState(provider:FixtureProvider):State{const state=registry.get(provider);if(!state||state.closed)throw new Error('unowned_or_closed_fixture');return state;}
export async function createLocalProviderFixture(options:{scenario:FixtureScenario;mode?:'native'|'magpie'}):Promise<FixtureProvider>{
 if(!options||Object.keys(options).some(k=>!['scenario','mode'].includes(k))||!scenarios.includes(options.scenario)||!['native','magpie'].includes(options.mode??'native'))throw new Error('unsupported_fixture_options');
 const scenario=options.scenario;const sockets=new Set<Socket>();const invoices=new Map<string,FixtureInvoice>();
 const state:State={server:createServer(),port:0,closed:false,mode:options.mode??'native',posts:0,discoveries:0,sockets,invoices,attempted:new Set()};
 const send=(res:ServerResponse,status:number,body:unknown)=>{res.writeHead(status,{'content-type':'application/json','connection':'close'});res.end(JSON.stringify(body));};
 state.server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 state.server.on('request',(req,res)=>{
  if(req.method==='GET'&&state.mode==='magpie'&&['/api/hello','/v1/models'].includes(req.url??'')){state.discoveries++;send(res,200,req.url==='/api/hello'?{name:scenario==='wrong-identity'?'other':'magpie',version:'fixture-only'}:{data:[{id:'fixture-model'}]});return;}
  if(req.method!=='POST'||!['/v1/responses','/v1/messages'].includes(req.url??'')){send(res,404,{});return;}
  state.posts++;let size=0;const chunks:Buffer[]=[];
  req.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>65536){req.destroy();return;}chunks.push(chunk);});
  req.on('error',()=>{});req.on('end',()=>{
   let r:FixtureRequest;
   try{
    const body=record(JSON.parse(Buffer.concat(chunks).toString('utf8')));const metadata=record(body.metadata);
    r=normalizeRequest(JSON.parse(String(metadata.fixture_request??metadata.user_id)));
    if(req.url!==(r.protocol==='responses'?'/v1/responses':'/v1/messages')||r.route.mode!==state.mode||JSON.stringify(body)!==JSON.stringify(wireRequest(r)))throw new Error('invalid_fixture_body');
   }catch{send(res,400,{});return;}
   const key=requestKey(r);if(invoices.has(r.requestId)){send(res,409,{});return;}
   const early=scenario==='early-429'||scenario==='early-503';
   if(scenario!=='missing-invoice')invoices.set(r.requestId,{requestKey:key,evidenceId:'fixture-bill-'+randomUUID(),executed:!early,actualCashMinor:early?0:scenario==='overrun'?2500:500,usage:fixtureUsage(scenario)});
   if(early||scenario==='late-503'){send(res,scenario==='early-429'?429:503,{});return;}
   if(scenario==='redirect'){res.writeHead(307,{location:'http://127.0.0.1:3425/v1/responses','connection':'close'});res.end();return;}
   res.writeHead(200,{'content-type':'text/event-stream','connection':'close'});
   if(scenario==='malformed'){res.end('data: {broken}\n\n');return;}
   if(scenario==='oversized'){res.end('data: '+'x'.repeat(65537)+'\n\n');return;}
   if(scenario==='unknown-event'){res.end('data: {"type":"unknown_lifecycle"}\n\n');return;}
   const events=wireEvents(r,scenario);
   const encode=(v:unknown)=>'data: '+JSON.stringify(v)+'\r\n\r\n';
   if(['partial','stall','heartbeat'].includes(scenario)){
    res.write(encode(events[0]));if(scenario==='partial'){res.end(encode(events[1]));return;}
    if(scenario==='heartbeat'){const timer=setInterval(()=>res.write(': ping\n\n'),10);res.once('close',()=>clearInterval(timer));}return;
   }
   res.end(events.map(encode).join(''));
  });
 });
 await new Promise<void>((resolve,reject)=>{state.server.once('error',reject);state.server.listen(0,'127.0.0.1',()=>{state.server.removeListener('error',reject);resolve();});});
 state.port=(state.server.address() as {port:number}).port;
 let closing:Promise<void>|undefined;
 const handle:FixtureProvider=Object.freeze({
  close:()=>{if(!closing){state.closed=true;closing=(async()=>{const closed=[...sockets].map(socket=>new Promise<void>(resolve=>socket.once('close',()=>resolve())));const stopped=new Promise<void>(resolve=>state.server.close(()=>resolve()));for(const socket of sockets)socket.destroy();await Promise.all([...closed,stopped]);})();}return closing;},
  observation:()=>({posts:state.posts,discoveries:state.discoveries,active:sockets.size}),
  invoice:(r:FixtureRequest)=>{const found=invoices.get(r.requestId);if(!found||found.requestKey!==requestKey(r))return undefined;return structuredClone(found);}
 });registry.set(handle,state);return handle;
}
