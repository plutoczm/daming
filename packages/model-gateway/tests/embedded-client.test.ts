import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import type {RequestListener} from 'node:http';
import {once} from 'node:events';
import * as api from '../src/index.ts';
const token='test-only-'+ 'a'.repeat(48);
type Descriptor={name:string;version:string;instanceId:string;url:string;token:string;created:boolean};
const Client=()=>{const cls=(api as unknown as {EmbeddedGatewayClient:new(d:Descriptor,o?:{timeoutMs?:number})=>{health():Promise<{configured:boolean}>;prepare(r:unknown):Promise<unknown>;execute(r:unknown):Promise<unknown>;cancel(id:string):Promise<void>}}).EmbeddedGatewayClient;assert.equal(typeof cls,'function');return cls;};
async function server(t:{after(fn:()=>Promise<void>):void},handler:RequestListener){
 const http=createServer(handler);http.listen(0,'127.0.0.1');await once(http,'listening');
 t.after(async()=>{http.closeAllConnections();await new Promise<void>(r=>http.close(()=>r()));});
 return {name:'daming-gateway',version:'1',instanceId:'owned-instance',url:'http://127.0.0.1:'+((http.address() as {port:number}).port),token,created:false};
}
test('embedded client uses authenticated fixed methods and hides bootstrap token',async t=>{
 const seen:string[]=[];const d=await server(t,((req,res)=>{
  assert.equal(req.headers.authorization,'Bearer '+token);seen.push(req.method+' '+req.url);
  res.setHeader('content-type','application/json');
  res.end(JSON.stringify(req.url==='/internal/health'?{name:'daming-gateway',version:'1',instanceId:'owned-instance',upstreamRevision:'1615e5a149acbaed6e9395ddb9775f96d95e4728',configured:true,buildId:'embedded-v3'}:{}));
 }));
 const C=Client();const client=new C(d);assert.equal((await client.health()).configured,true);
 assert.deepEqual(seen,['GET /internal/health']);assert.equal(JSON.stringify(client).includes(token),false);
});
test('embedded client rejects wrong service identity redirects and bounded-response violations',async t=>{
 for(const mode of ['identity','redirect','large','hang']){
  const d=await server(t,((_req,res)=>{
   if(mode==='redirect'){res.writeHead(307,{location:'http://example.com'});res.end();return;}
   res.setHeader('content-type','application/json');
   if(mode==='large'){res.end('x'.repeat(1048577));return;}if(mode==='hang'){res.write('{');return;}
   res.end(JSON.stringify({name:'magpie',version:'1',instanceId:'owned-instance',configured:true}));
  }));
  const C=Client();await assert.rejects(new C(d,{timeoutMs:40}).health());
 }
});
test('embedded client rejects nonloopback credentialed and malformed bootstraps without network',()=>{
 const C=Client();const d={name:'daming-gateway',version:'1',instanceId:'i',url:'http://127.0.0.1:12345',token,created:true};
 for(const url of ['https://example.com','http://localhost:3425','http://a:b@127.0.0.1:1','http://127.0.0.1:1/private'])assert.throws(()=>new C({...d,url}));
 assert.throws(()=>new C({...d,token:'short'}));
});

test('embedded client delivers protocol events incrementally and correlates final result',async t=>{
 let finished=false;const seen:string[]=[];
 const d=await server(t,((req,res)=>{
  assert.equal(req.headers.accept,'application/x-ndjson');res.setHeader('content-type','application/x-ndjson');
  for(const data of [{type:'response.created',response:{id:'resp-r'}},{type:'response.output_text.delta',delta:'OK'},{type:'response.completed',response:{id:'resp-r'}}])res.write(JSON.stringify({event:'protocol',requestId:'r',data})+'\n');
  setTimeout(()=>res.end(JSON.stringify({event:'result',requestId:'r',data:{status:'completed',requestId:'r',text:'OK'}})+'\n'),30);
 }));
 const C=Client();const client=new C(d,{onEvent:(e:{requestId:string;data:{type:string}})=>{assert.equal(finished,false);seen.push(e.data.type);}} as never);
 const result=await client.execute({preparedId:'p',digest:'a'.repeat(64),requestId:'r',operationId:'op',expiresMs:Date.now()+1000,maximumCashMinor:500,permitId:'permit'}) as {status:string};finished=true;
 assert.equal(result.status,'completed');assert.deepEqual(seen,['response.created','response.output_text.delta','response.completed']);
});
