import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { Engine } from '@daming/core';
import { SqliteStore, Outbox } from '../src/index.ts';
const at='2026-11-06T00:00:00.000Z';
function directory(t:{after(fn:()=>void):void}) {
  const dir=mkdtempSync(join(tmpdir(),'daming process '));
  t.after(()=>rmSync(dir,{recursive:true,force:true,maxRetries:15,retryDelay:100}));return dir;
}
function worker(file:string,job:string,index:number,barrier?:SharedArrayBuffer) {
  const thread=new Worker(new URL('./fixtures/concurrent-host.mjs',import.meta.url),{workerData:{file,job,index,barrier}});
  let readyResolve!:()=>void;let readyReject!:(error:Error)=>void;
  const ready=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  ready.catch(()=>{});
  const result=new Promise<unknown>((resolve,reject)=>{
    let received=false;
    let value: unknown;
    thread.on('message',message=>{
      if(message.ready) { readyResolve(); return; }
      received=true;
      value=message.result;
    });
    thread.on('error',error=>{readyReject(error);reject(error);});
    thread.on('exit',code=>{
      if(code===0&&received) { resolve(value); return; }
      const error=new Error(code===0 ? 'Worker exited without a result' : 'Worker exit '+code);
      readyReject(error);
      reject(error);
    });
  });
  return {thread,ready,result};
}
async function killFixture(file:string,mode:string,marker:string) {
  const child=fork(fileURLToPath(new URL('./fixtures/crash-host.mjs',import.meta.url)),[file,mode,marker],{execArgv:[],stdio:['ignore','ignore','pipe','ipc']});
  let errors='';child.stderr!.on('data',data=>{errors+=data;});
  try {
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Crash fixture timed out: '+errors)),10000);
      child.once('message',()=>{clearTimeout(timer);resolve();});
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('exit',()=>{clearTimeout(timer);reject(new Error('Crash fixture exited early: '+errors));});
    });
  } finally {
    if(child.exitCode===null&&child.signalCode===null) { const exit=once(child,'exit');child.kill('SIGKILL');await exit; }
  }
}
test('concurrent process-local SQLite connections deduplicate one source event',{timeout:20000},async t=>{
  const dir=directory(t);const file=join(dir,'state.sqlite');new SqliteStore(file).close();
  const workers=Array.from({length:4},(_,i)=>worker(file,'create',i));
  const results=await Promise.all(workers.map(w=>w.result));
  assert.equal(results.filter(value=>value===false).length,1);
  const store=new SqliteStore(file);
  try {assert.equal(store.listEvents().length,1);}finally{store.close();}
});
test('concurrent stale-version transitions have exactly one winner',{timeout:20000},async t=>{
  const dir=directory(t);const file=join(dir,'state.sqlite');const store=new SqliteStore(file);const engine=new Engine(store);
  const context={taskId:'concurrent-task',runId:'run',attemptId:'attempt',sourceId:'fixture',eventId:'created',occurredAt:at};
  engine.execute({type:'create_task',context,title:'Concurrent',goal:'fixture'});
  const barrier=new SharedArrayBuffer(4);
  const workers=Array.from({length:3},(_,i)=>worker(file,'transition',i,barrier));
  try {
    await Promise.all(workers.map(w=>w.ready));Atomics.store(new Int32Array(barrier),0,1);Atomics.notify(new Int32Array(barrier),0);
    const results=await Promise.all(workers.map(w=>w.result));
    assert.equal(results.filter(value=>value==='applied').length,1);assert.equal(store.listEvents().length,2);
  } finally {store.close();await Promise.all(workers.map(w=>w.thread.terminate()));}
});
test('concurrent claims cannot assign the same effect twice',{timeout:20000},async t=>{
  const dir=directory(t);const file=join(dir,'state.sqlite');const store=new SqliteStore(file);const engine=new Engine(store);
  const context={taskId:'concurrent-task',runId:'run',attemptId:'attempt',sourceId:'fixture',eventId:'c',occurredAt:at};
  engine.execute({type:'create_task',context,title:'Concurrent',goal:'fixture'});
  for(const to of ['planned','queued','running'] as const) engine.execute({type:'transition_task',context:{...context,eventId:to},expectedVersion:engine.getTask(context.taskId)!.version,to,...(to==='running'?{effects:Array.from({length:3},(_,i)=>({effectId:'effect'+i,idempotencyKey:'key'+i,kind:'fixture',payload:null,semantics:'non_idempotent' as const}))}:{})});
  const workers=Array.from({length:4},(_,i)=>worker(file,'claim',i));
  try {
    const results=await Promise.all(workers.map(w=>w.result));
    const claimed=results.filter(value=>value!==null);assert.equal(claimed.length,3);assert.equal(new Set(claimed).size,3);
  } finally {store.close();await Promise.all(workers.map(w=>w.thread.terminate()));}
});
test('SIGKILL before commit rolls back task, audit and pending effects',{timeout:20000},async t=>{
  const dir=directory(t);const file=join(dir,'state.sqlite');
  await killFixture(file,'uncommitted',join(dir,'marker'));
  const store=new SqliteStore(file);
  try {assert.equal(store.getTask('crash-task')!.status,'draft');assert.equal(store.listEvents().length,1);assert.equal(store.effectsForTask('crash-task').length,0);}finally{store.close();}
});
test('SIGKILL after commit preserves pending work for one later dispatch',{timeout:20000},async t=>{
  const dir=directory(t);const file=join(dir,'state.sqlite');
  await killFixture(file,'pending',join(dir,'marker'));
  const store=new SqliteStore(file);const engine=new Engine(store);let calls=0;
  try {
    const outbox=new Outbox(store,engine,()=>at);outbox.recoverInterrupted();
    await outbox.dispatchOne(async()=>{calls++;return {status:'succeeded',result:null};});
    assert.equal(calls,1);assert.equal(store.getEffect('crash-effect')!.status,'succeeded');
  } finally{store.close();}
});
test('SIGKILL after an external fixture effect cannot cause an automatic resend',{timeout:20000},async t=>{
  const dir=directory(t);const file=join(dir,'state.sqlite');const marker=join(dir,'effect.txt');
  await killFixture(file,'executed',marker);
  const store=new SqliteStore(file);const engine=new Engine(store);
  try {
    const outbox=new Outbox(store,engine,()=>at);outbox.recoverInterrupted();
    await outbox.dispatchOne(async()=>{appendFileSync(marker,'duplicate\n');return {status:'succeeded',result:null};});
    assert.equal(readFileSync(marker,'utf8'),'synthetic effect\n');
    assert.equal(store.getEffect('crash-effect')!.status,'needs_reconciliation');assert.equal(engine.getTask('crash-task')!.status,'blocked');
  } finally{store.close();}
});
