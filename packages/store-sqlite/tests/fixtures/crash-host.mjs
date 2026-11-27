import { Engine } from '@daming/core';
import { SqliteStore } from '../../src/index.ts';
import { appendFileSync } from 'node:fs';
const [file,mode,marker]=process.argv.slice(2);
const store=new SqliteStore(file);const engine=new Engine(store);
const at='2026-11-06T00:00:00.000Z';
const context=id=>({taskId:'crash-task',runId:'run',attemptId:'attempt',sourceId:'fixture',eventId:id,occurredAt:at});
engine.execute({type:'create_task',context:context('created'),title:'Crash fixture',goal:'Synthetic data'});
const transition=(id,to,effects)=>engine.execute({type:'transition_task',context:context(id),expectedVersion:engine.getTask('crash-task').version,to,...(effects?{effects}:{})});
const request={effectId:'crash-effect',idempotencyKey:'crash-key',kind:'fixture',payload:null,semantics:'non_idempotent'};
function ready(){process.send({ready:true});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}
function start(){transition('p','planned');transition('q','queued');transition('r','running',[request]);}
if(mode==='uncommitted') store.atomic(()=>{start();ready();});
else {
  start();
  if(mode==='executed') {store.claimNext(at);appendFileSync(marker,'synthetic effect\n');}
  ready();
}
