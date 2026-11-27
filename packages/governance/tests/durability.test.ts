import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdtempSync,rmSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Engine } from '@daming/core';
import { Outbox,SqliteStore } from '../../store-sqlite/src/index.ts';
import { GovernanceError,createGovernance } from '../src/index.ts';
import { harness,operation,NOW } from './helpers.ts';
test('two concurrent 1200 reservations under 2000 have one winner',{timeout:15000},async t=>{
  const h=harness(t);const ops=[operation('a'),operation('b')];ops.forEach(op=>h.quote(op));
  const results=await Promise.all(ops.map(op=>new Promise<{reserved:boolean}>((resolve,reject)=>{
    const worker=new Worker(new URL('./fixtures/reserve.mjs',import.meta.url),{workerData:{file:h.file,operation:op,now:NOW}});
    let result:{reserved:boolean}|undefined;worker.once('message',message=>{result=message;});worker.once('error',reject);worker.once('exit',code=>{if(code!==0||!result)reject(new Error('worker failed'));else resolve(result);});
  })));
  assert.equal(results.filter(r=>r.reserved).length,1);assert.equal(h.governance.ledger.budget('task')!.heldMinor,1200);assert.equal(h.governance.ledger.budget('task')!.spentMinor,0);
});
test('parallel gateway calls cannot consume one capability twice',async t=>{
  const h=harness(t,async()=>{await new Promise(resolve=>setTimeout(resolve,20));return {status:'succeeded',actualCashMinor:500,result:null};});
  const op=operation();h.quote(op);const token=h.approve(op);const effect=h.claim(op);
  const results=await Promise.allSettled([h.governance.gateway.execute(effect,token),h.governance.gateway.execute(effect,token)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(h.calls,1);assert.equal(h.governance.ledger.budget('task')!.spentMinor,500);
});
test('receipt commit failure after invocation is unknown rather than proof of non-execution',async t=>{
  const h=harness(t);const op=operation();h.quote(op);const token=h.approve(op);h.enqueue(op);
  const append=h.store.appendGovernanceAudit.bind(h.store);
  h.store.appendGovernanceAudit=event=>{if(event.type==='tool_settled')throw new GovernanceError('fixture_receipt_commit_failed');append(event);};
  await new Outbox(h.store,h.engine,()=>new Date(NOW).toISOString()).dispatchOne(h.governance.gateway.executor(()=>token));
  h.store.appendGovernanceAudit=append;
  assert.equal(h.calls,1);assert.equal(h.store.getEffect('effect-op')!.status,'needs_reconciliation');
  assert.equal(h.governance.ledger.budget('task')!.heldMinor,1200);assert.equal(h.governance.ledger.budget('task')!.spentMinor,0);
  h.governance.admin.recoverInterrupted();assert.equal(h.governance.ledger.budget('task')!.heldMinor,1200);
});
test('process interruption after a fixture effect preserves hold and never re-executes',{timeout:15000},async t=>{
  const h=harness(t);const op=operation();h.quote(op);const token=h.approve(op);h.claim(op);
  const marker=join(h.file,'..','effect.txt');
  const child=fork(fileURLToPath(new URL('./fixtures/crash-tool.mjs',import.meta.url)),[h.file,marker],{execArgv:[],stdio:['ignore','ignore','pipe','ipc']});
  try {
    await once(child,'message');child.send({token});await once(child,'message');
  } finally {if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}}
  h.governance.admin.recoverInterrupted();
  assert.equal(h.store.getEffect('effect-op')!.status,'needs_reconciliation');assert.equal(h.engine.getTask('task')!.status,'blocked');
  assert.equal(h.governance.ledger.budget('task')!.heldMinor,1200);
  await h.governance.gateway.execute(h.store.getEffect('effect-op')!,token);
  assert.equal(h.calls,0);assert.equal(readFileSync(marker,'utf8'),'fixture-effect\n');
  h.governance.admin.reconcile('op',{resolution:'succeeded',actualCashMinor:500,result:null,evidence:'fixture file receipt verified'});
  assert.equal(h.governance.ledger.budget('task')!.spentMinor,500);assert.equal(h.calls,0);
});
test('schema v1 migration preserves existing task facts and adds governance storage',t=>{
  const dir=mkdtempSync(join(tmpdir(),'daming v1 migration '));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'old.sqlite');
  const old={taskId:'old',runId:'run',attemptId:'attempt',sourceId:'fixture',version:1,status:'draft',title:'Existing v1 task',goal:'Synthetic',createdAt:new Date(NOW).toISOString(),updatedAt:new Date(NOW).toISOString()};
  const db=new DatabaseSync(file);
  db.exec("CREATE TABLE daming_tasks(id TEXT PRIMARY KEY,version INTEGER NOT NULL,data TEXT NOT NULL);CREATE TABLE daming_events(sequence INTEGER PRIMARY KEY,source_id TEXT,event_id TEXT,task_id TEXT,data TEXT);CREATE TABLE daming_effects(id TEXT PRIMARY KEY,task_id TEXT,idempotency_key TEXT UNIQUE,status TEXT,attempts INTEGER,data TEXT);PRAGMA user_version=1;");
  db.prepare('INSERT INTO daming_tasks VALUES(?,?,?)').run('old',1,JSON.stringify(old));
  db.prepare('INSERT INTO daming_events VALUES(?,?,?,?,?)').run(1,'fixture','old','old',JSON.stringify({sequence:1,snapshot:old}));db.close();
  const store=new SqliteStore(file);
  try {
    assert.deepEqual(store.getTask('old'),old);assert.equal(store.listEvents('old').length,1);
    const g=createGovernance({repository:store,engine:new Engine(store),clock:()=>NOW,tools:[]});g.admin.setBudget('old',2000);assert.equal(g.ledger.budget('old')!.limitMinor,2000);
  } finally {store.close();}
  const check=new DatabaseSync(file);assert.equal(check.prepare('PRAGMA user_version').get()!.user_version,4);check.close();
});
