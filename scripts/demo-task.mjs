import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../packages/core/src/index.ts';
import { SqliteStore, Outbox } from '../packages/store-sqlite/src/index.ts';
import { toTaskView } from '../apps/server/src/fixture.ts';
const directory=mkdtempSync(join(tmpdir(),'daming task demo '));
const file=join(directory,'fixture.sqlite');
let store=new SqliteStore(file);
try {
  const engine=new Engine(store);
  const at='2026-11-06T00:00:00.000Z';
  const context=eventId=>({taskId:'demo-task',runId:'demo-run',attemptId:'demo-attempt',sourceId:'fixture',eventId,occurredAt:at});
  engine.execute({type:'create_task',context:context('create'),title:'Offline SQLite demonstration',goal:'Persist a synthetic task and fixture receipt'});
  for(const to of ['planned','queued','running']) {
    engine.execute({type:'transition_task',context:context(to),expectedVersion:engine.getTask('demo-task').version,to,...(to==='running'?{effects:[{effectId:'fixture-effect',idempotencyKey:'fixture-key',kind:'fixture',payload:null,semantics:'non_idempotent'}]}:{})});
  }
  await new Outbox(store,engine,()=>at).dispatchOne(async()=>({status:'succeeded',result:{fixture:true}}));
  for(const to of ['reviewing','completed']) engine.execute({type:'transition_task',context:context(to),expectedVersion:engine.getTask('demo-task').version,to});
  store.close();store=new SqliteStore(file);
  console.log(JSON.stringify({mode:'offline fixture',task:toTaskView(store.getTask('demo-task')),outbox:store.getEffect('fixture-effect').status,auditEvents:store.listEvents('demo-task').length,reopened:true},null,2));
} finally {store.close();rmSync(directory,{recursive:true,force:true});}
