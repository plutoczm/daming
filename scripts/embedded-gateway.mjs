import {acquireHostLock} from '../apps/server/src/host-lock.ts';
import {checkSmokePrice,SMOKE_PRICE_BASIS} from '../apps/server/src/deepseek-price.ts';
import {fileURLToPath} from 'node:url';
import {dirname,join,resolve} from 'node:path';
import {existsSync,mkdirSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {createHash,randomUUID} from 'node:crypto';
import {EmbeddedRuntime} from '../apps/server/src/embedded-runtime.ts';
import {createEmbeddedModelTool} from '../apps/server/src/embedded-model-tool.ts';
import {Engine} from '../packages/core/src/index.ts';
import {SqliteStore,Outbox} from '../packages/store-sqlite/src/index.ts';
import {createGovernance} from '../packages/governance/src/index.ts';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const mode=process.argv[2]??'start';
if(!['start','status','configure','smoke'].includes(mode)||process.argv.length>3)throw new Error('Use start/status/configure/smoke only');
let base=resolve(process.env.DAMING_DATA_DIR??join(process.env.LOCALAPPDATA??process.env.USERPROFILE,'Daming'));
const dataDir=join(base,'gateway');
const binary=join(root,'runtime/model-gateway/windows-x64/daming-gateway-v3.exe');
if(!existsSync(binary))throw new Error('Run pnpm build:gateway first');
if(mode==='configure'){
 const p=spawn(binary,['configure-deepseek','--data-dir',dataDir,'--dialog'],{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
 let status='';p.stdout.on('data',b=>{if(status.length<4096)status+=b.toString();});p.stderr.resume();
 await new Promise((r,j)=>{p.once('error',j);p.once('close',code=>code===0?r():j(new Error('Local credential entry cancelled or failed')));});
 console.log(JSON.stringify({configured:JSON.parse(status).configured,secretPrinted:false}));
}else{

 let lock;
 if(mode!=='status'){
  lock=await acquireHostLock(base);base=lock.base;
 }
 const runtime=new EmbeddedRuntime({binary,dataDir:join(base,'gateway'),onEvent:({data})=>{if(mode==='smoke'&&data.type==='response.output_text.delta'&&typeof data.delta==='string')process.stderr.write(data.delta);}});
 let store;
 try{
  const health=await runtime.ensure();
  if(mode==='status'){console.log(JSON.stringify({...health,keepAlive:true},null,2));}
  else if(mode==='start'){
   mkdirSync(join(base,'host'),{recursive:true});store=new SqliteStore(join(base,'host/tasks.sqlite'));
   console.log(JSON.stringify({host:'ready',gateway:health,keepGatewayOnExit:true,uiImplemented:false},null,2));
   await new Promise(r=>{process.once('SIGINT',r);process.once('SIGTERM',r);});
  }else{
   if(!health.configured)throw new Error('DeepSeek key missing. Run pnpm gateway:configure and enter it locally; no inference was sent.');
   mkdirSync(join(base,'host'),{recursive:true});store=new SqliteStore(join(base,'host/tasks.sqlite'));
   const engine=new Engine(store),taskId='deepseek-live-2026-11-07';
   if(engine.getTask(taskId))throw new Error('This authorized live acceptance task already exists. No automatic retry or new budget is allowed.');
   const at=()=>new Date().toISOString();const context=eventId=>({taskId,runId:'live-run',attemptId:'live-attempt',sourceId:'local-user',eventId,occurredAt:at()});
   engine.execute({type:'create_task',context:context('create'),title:'Authorized DeepSeek real smoke',goal:'One real non-private text request; total cash ceiling CNY5'});
   for(const to of ['planned','queued','running'])engine.execute({type:'transition_task',context:context(to),expectedVersion:engine.getTask(taskId).version,to});
   const pricing=checkSmokePrice();
   const prepared=await runtime.prepare({requestId:randomUUID(),protocol:'responses',model:'deepseek-flash',input:'Reply with only OK.',maxOutputTokens:128});
   const tool=createEmbeddedModelTool(runtime,prepared);
   const gov=createGovernance({repository:store,engine,tools:[],modelTools:[tool]});
   const operation={operationKind:'model_request',id:'deepseek-first-live',taskId,runId:'live-run',attemptId:'live-attempt',toolId:tool.id,toolVersion:tool.version,target:prepared.upstreamUrl,payload:{prepared,priceBasisId:SMOKE_PRICE_BASIS.id},amountMinor:0,quoteId:'deepseek-first-quote',route:{mode:'native',provider:'deepseek',model:'deepseek-flash',accountRef:'deepseek-default'}};
   gov.admin.setBudget(taskId,500);const now=Date.now();gov.admin.issueQuote(operation,500,now+60000,'official_api');const token=gov.admin.approve(operation,now+30000);
   engine.execute({type:'enqueue_effect',context:context('enqueue'),expectedVersion:engine.getTask(taskId).version,effect:{effectId:operation.id,idempotencyKey:operation.id,kind:'governance.tool',payload:{operation},semantics:'non_idempotent'}});
   await new Outbox(store,engine,at).dispatchOne(gov.gateway.executor(()=>token));
   const entry=store.governanceGet('executions',operation.id);
   console.log(JSON.stringify({mode:'real_embedded_deepseek',pricing,effect:store.getEffect(operation.id).status,task:engine.getTask(taskId).status,observation:entry?.observation,budget:gov.ledger.budget(taskId),automaticRetry:false},null,2));
  }
 }finally{if(store)store.close();if(lock)await lock.close();}
}
