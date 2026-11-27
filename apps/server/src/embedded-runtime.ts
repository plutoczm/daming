import {execFile} from 'node:child_process';
import {statSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {EmbeddedGatewayClient} from '@daming/model-gateway';
import type {EmbeddedBootstrap,EmbeddedRequest,ModelPermit,EmbeddedProtocolEvent} from '@daming/model-gateway';
export class EmbeddedRuntime {
 #binary:string;#dataDir:string;#client?:EmbeddedGatewayClient;#onEvent?:(e:EmbeddedProtocolEvent)=>void;
 constructor(options:{binary:string;dataDir:string;onEvent?:(e:EmbeddedProtocolEvent)=>void}){
  if(!options||Object.keys(options).some(k=>!['binary','dataDir','onEvent'].includes(k))||!isAbsolute(options.binary)||!isAbsolute(options.dataDir)||!statSync(options.binary).isFile())throw new Error('invalid_owned_runtime_paths');
  this.#binary=options.binary;this.#dataDir=options.dataDir;this.#onEvent=options.onEvent;
 }
 async ensure(){
  const env:NodeJS.ProcessEnv={};for(const key of ['SystemRoot','WINDIR','TEMP','TMP','LOCALAPPDATA','USERPROFILE'])if(process.env[key])env[key]=process.env[key];
  const descriptor=await new Promise<EmbeddedBootstrap>((resolve,reject)=>{
   execFile(this.#binary,['ensure-running','--data-dir',this.#dataDir],{env,windowsHide:true,shell:false,timeout:15000,maxBuffer:32768},(error,stdout)=>{
    if(error){reject(new Error('embedded_gateway_bootstrap_failed'));return;}try{resolve(JSON.parse(stdout));}catch{reject(new Error('invalid_private_bootstrap'));}
   });
  });
  this.#client=new EmbeddedGatewayClient(descriptor,{onEvent:this.#onEvent});const health=await this.#client.health();
  return {...health,created:descriptor.created};
 }
 #ready(){if(!this.#client)throw new Error('embedded_runtime_not_ready');return this.#client;}
 health(){return this.#ready().health();}
 prepare(r:EmbeddedRequest){return this.#ready().prepare(r);}
 execute(p:ModelPermit){return this.#ready().execute(p);}
 cancel(requestId:string){return this.#ready().cancel(requestId);}
}
