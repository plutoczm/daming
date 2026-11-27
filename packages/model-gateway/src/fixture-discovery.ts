import {request} from 'node:http';
import type {FixtureProvider} from './fixture-provider.ts';
import {ownedState} from './fixture-provider.ts';
import type {GatewayObservation} from './magpie-adapter.ts';
import {record} from './gateway-port.ts';
export async function discoverFixture(provider:FixtureProvider):Promise<GatewayObservation>{
 const state=ownedState(provider);const empty={models:[],verifiedProtocols:[]};
 if(state.mode!=='magpie')return {status:'disabled',...empty};
 const json=(path:string)=>new Promise<unknown>((resolve,reject)=>{
  let answer:unknown;let error=false;let size=0;const chunks:Buffer[]=[];
  const req=request({host:'127.0.0.1',port:state.port,path,method:'GET',agent:false,headers:{connection:'close'}},res=>{
   if(res.statusCode!==200){error=true;res.destroy();req.destroy();return;}
   res.on('data',(b:Buffer)=>{size+=b.length;if(size>65536){error=true;res.destroy();req.destroy();}else chunks.push(b);});
   res.on('end',()=>{try{answer=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{error=true;}req.destroy();});
   res.on('error',()=>{error=true;req.destroy();});res.on('aborted',()=>{error=true;req.destroy();});
  });
  const timer=setTimeout(()=>{error=true;req.destroy();},2000);
  req.on('error',()=>{error=true;});req.on('close',()=>{clearTimeout(timer);if(error||answer===undefined)reject(new Error('fixture_discovery_failed'));else resolve(answer);});req.end();
 });
 try{
  const hello=record(await json('/api/hello'));if(hello.name!=='magpie'||hello.version!=='fixture-only')return {status:'incompatible',...empty};
  const catalog=record(await json('/v1/models'));if(!Array.isArray(catalog.data)||catalog.data.length!==1||record(catalog.data[0]).id!=='fixture-model')return {status:'incompatible',...empty};
  return {status:'available',version:'fixture-only',models:['fixture-model'],verifiedProtocols:[]};
 }catch{return {status:'unavailable',...empty};}
}
