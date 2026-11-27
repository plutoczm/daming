import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../packages/core/src/index.ts';
import { SqliteStore, Outbox } from '../packages/store-sqlite/src/index.ts';
import { createGovernance } from '../packages/governance/src/index.ts';

const directory=mkdtempSync(join(tmpdir(),'daming governance demo '));
const store=new SqliteStore(join(directory,'fixture.sqlite'));
try {
  const engine=new Engine(store);
  const at=Date.now();
  const context=eventId=>({taskId:'budget-demo',runId:'run',attemptId:'attempt',sourceId:'fixture',eventId,occurredAt:new Date(at).toISOString()});
  engine.execute({type:'create_task',context:context('create'),title:'Offline governed fixture',goal:'Demonstrate authorization and cash settlement'});
  for(const to of ['planned','queued','running'])engine.execute({type:'transition_task',context:context(to),expectedVersion:engine.getTask('budget-demo').version,to});
  let calls=0;
  const governance=createGovernance({
    repository:store,engine,
    tools:[{id:'fixture.receipt',version:'1',fixtureOnly:true,execute:async()=>{calls++;return {status:'succeeded',actualCashMinor:400,result:{fixture:true}};}}]
  });
  const operation={
    id:'demo-operation',taskId:'budget-demo',runId:'run',attemptId:'attempt',
    executorKind:'fixture',toolId:'fixture.receipt',toolVersion:'1',
    target:'synthetic-target',payload:{text:'synthetic'},amountMinor:0,quoteId:'demo-quote',
    route:{mode:'native',provider:'fixture',model:'fixture',accountRef:'fixture-account'}
  };
  governance.admin.setBudget(operation.taskId,1000);
  governance.admin.issueQuote(operation,600,at+60000,'fixture',900);
  const capability=governance.admin.approve(operation,at+30000);
  engine.execute({type:'enqueue_effect',context:context('enqueue'),expectedVersion:engine.getTask(operation.taskId).version,effect:{effectId:'demo-effect',idempotencyKey:operation.id,kind:'governance.tool',payload:{operation},semantics:'non_idempotent'}});
  await new Outbox(store,engine,()=>new Date().toISOString()).dispatchOne(governance.gateway.executor(()=>capability));
  const budget=governance.ledger.budget(operation.taskId);
  const reservation=store.governanceGet('reservations',operation.id);
  console.log(JSON.stringify({
    mode:'governance_fixture',currency:budget.currency,limitMinor:budget.limitMinor,
    spentMinor:budget.spentMinor,heldMinor:budget.heldMinor,
    comprehensiveEstimateMinor:reservation.comprehensiveEstimateMinor,
    routeMode:reservation.route.mode,billingSource:reservation.billingSource,
    callbacks:calls,effect:store.getEffect('demo-effect').status,
    approval:store.governanceList('approvals',operation.taskId)[0].status,
    task:engine.getTask(operation.taskId).status,modelRequests:0
  },null,2));
} finally {store.close();rmSync(directory,{recursive:true,force:true});}
