import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import type { RequestListener } from 'node:http';
import { once } from 'node:events';
import { MagpieAdapter } from '../src/index.ts';
async function server(t:{after(fn:()=>Promise<void>):void},handler:RequestListener) {
  const http=createServer(handler);http.listen(0,'127.0.0.1');await once(http,'listening');
  t.after(async()=>{http.closeAllConnections();await new Promise<void>(resolve=>http.close(()=>resolve()));});
  return 'http://127.0.0.1:'+((http.address() as {port:number}).port);
}
test('disabled gateway makes no requests',async()=>{
  const adapter=new MagpieAdapter({enabled:false,fetch:async()=>{throw new Error('must not call');}});
  assert.equal((await adapter.probe()).status,'disabled');
});
test('discovers identity/catalog but does not claim protocol compatibility',async t=>{
  const paths:string[]=[];
  const url=await server(t,((req,res)=>{paths.push(req.url!);res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url==='/api/hello'?{name:'magpie',version:'fixture'}:{data:[{id:'fixture/model',secret:'discarded'}]}));}));
  const result=await new MagpieAdapter({enabled:true,baseUrl:url}).probe();
  assert.equal(result.status,'available');assert.deepEqual(result.models,['fixture/model']);
  assert.deepEqual(result.verifiedProtocols,[]);assert.deepEqual(paths,['/api/hello','/v1/models']);
});
test('offline gateway is optional and never silently selects native',async()=>{
  const result=await new MagpieAdapter({enabled:true,fetch:async()=>{throw new Error('offline');}}).probe();
  assert.equal(result.status,'unavailable');assert.equal('fallback' in result,false);
});
test('rejects external URLs and URL credentials',()=>{
  for(const baseUrl of ['https://example.com','http://localhost:3425','http://a:b@127.0.0.1:3425','http://127.0.0.1:3425/private']) assert.throws(()=>new MagpieAdapter({enabled:true,baseUrl}));
});
test('wrong service, redirects and invalid models are not ready',async t=>{
  for(const mode of ['identity','redirect','catalog']) {
    const url=await server(t,((req,res)=>{
      if(mode==='redirect'){res.writeHead(302,{location:'http://example.com'});res.end();return;}
      res.end(JSON.stringify(req.url==='/api/hello'?{name:mode==='identity'?'other':'magpie',version:'fixture'}:{data:[{id:3}]}));
    }));
    assert.notEqual((await new MagpieAdapter({enabled:true,baseUrl:url}).probe()).status,'available');
  }
});
test('timeout includes response body consumption',async t=>{
  const url=await server(t,((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.write('{');}));
  assert.equal((await new MagpieAdapter({enabled:true,baseUrl:url,timeoutMs:30}).probe()).status,'unavailable');
});
