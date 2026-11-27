import { parentPort, workerData } from 'node:worker_threads';
import { Engine, ConflictError } from '@daming/core';
import { SqliteStore } from '../../src/index.ts';
const {file,job,index,barrier}=workerData;
const store=new SqliteStore(file);const engine=new Engine(store);
const at='2026-11-06T00:00:00.000Z';
const context=id=>({taskId:'concurrent-task',runId:'run',attemptId:'attempt',sourceId:'fixture',eventId:id,occurredAt:at});
try {
  let result;
  if(job==='create') result=engine.execute({type:'create_task',context:context('same-event'),title:'Concurrent fixture',goal:'No user data'}).duplicate;
  else if(job==='claim') result=store.claimNext(at)?.effectId??null;
  else {
    const version=engine.getTask('concurrent-task').version;
    parentPort.postMessage({ready:true});
    Atomics.wait(new Int32Array(barrier),0,0);
    try { engine.execute({type:'transition_task',context:context('change-'+index),expectedVersion:version,to:'planned'});result='applied'; }
    catch(error) { if(!(error instanceof ConflictError))throw error;result='conflict'; }
  }
  parentPort.postMessage({result});
} finally {store.close();}
