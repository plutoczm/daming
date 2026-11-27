import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Engine} from '../packages/core/src/index.ts';
import {SqliteStore,Outbox} from '../packages/store-sqlite/src/index.ts';
import {createGovernance} from '../packages/governance/src/index.ts';
import {createLocalProviderFixture,discoverFixture} from '../packages/model-gateway/src/index.ts';
import {createModelFixtureTool} from '../apps/server/src/model-fixture-tool.ts';
const directory=mkdtempSync(join(tmpdir(),'daming gateway demo '));
const store=new SqliteStore(join(directory,'fixture.sqlite'));
const providers=[];
try {
 const engine=new Engine(store);const results=[];
 for(const [id,protocol,mode,scenario] of [['native-responses','responses','native','normal'],['magpie-messages','messages','magpie','normal'],['interrupted','responses','native','partial']]){
  const at=Date.now();const context=eventId=>({taskId:id,runId:'run',attemptId:'attempt',sourceId:'fixture',eventId:id+'-'+eventId,occurredAt:new Date().toISOString()});
  engine.execute({type:'create_task',context:context('create'),title:'Synthetic model route',goal:'Owned loopback only'});
  for(const to of ['planned','queued','running'])engine.execute({type:'transition_task',context:context(to),expectedVersion:engine.getTask(id).version,to});
  const provider=await createLocalProviderFixture({scenario,mode});providers.push(provider);
  const discovery=await discoverFixture(provider);
  const request={requestId:id,sessionId:'synthetic-session',protocol,model:'fixture-model',template:'tool',route:{mode,provider:'fixture',accountRef:'fixture-a'},dataScope:'synthetic',maxInputTokens:128,maxOutputTokens:128};
  const tool=createModelFixtureTool(provider,request);
  const governance=createGovernance({repository:store,engine,tools:[tool]});
  const operation={id,taskId:id,runId:'run',attemptId:'attempt',executorKind:'fixture',toolId:tool.id,toolVersion:tool.version,target:'owned-provider',payload:{request},amountMinor:0,quoteId:'quote-'+id,route:{...request.route,model:request.model}};
  governance.admin.setBudget(id,2000);governance.admin.issueQuote(operation,1200,at+60000,'fixture');const token=governance.admin.approve(operation,at+30000);
  engine.execute({type:'enqueue_effect',context:context('enqueue'),expectedVersion:engine.getTask(id).version,effect:{effectId:id,idempotencyKey:id,kind:'governance.tool',payload:{operation},semantics:'non_idempotent'}});
  await new Outbox(store,engine,()=>new Date().toISOString()).dispatchOne(governance.gateway.executor(()=>token));
  const budget=governance.ledger.budget(id);
  results.push({id,protocol,routeMode:mode,discovery:discovery.status,verifiedRealProtocols:discovery.verifiedProtocols,effect:store.getEffect(id).status,task:engine.getTask(id).status,spentMinor:budget.spentMinor,heldMinor:budget.heldMinor,posts:provider.observation().posts});
 }
 console.log(JSON.stringify({mode:'owned_local_provider_fixture',currency:'CNY',amounts:'synthetic',results,externalModelRequests:0},null,2));
}finally {await Promise.all(providers.map(p=>p.close()));store.close();rmSync(directory,{recursive:true,force:true});}
