import { Engine } from '@daming/core';
import { SqliteStore } from '../../store-sqlite/src/index.ts';
import { createGovernance } from '../src/index.ts';
import type { Operation,ToolOperation,FixtureTool } from '../src/index.ts';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export const NOW=Date.parse('2026-11-06T00:00:00Z');
export function operation(id='op',patch:Partial<ToolOperation>={}):ToolOperation {
  return {id,taskId:'task',runId:'run',attemptId:'attempt',executorKind:'fixture',toolId:'fixture.send',toolVersion:'1',target:'fixture-recipient',payload:{text:'synthetic'},amountMinor:0,quoteId:'quote-'+id,route:{mode:'native',provider:'fixture',model:'fixture',accountRef:'fixture-account'},...patch};
}
export function harness(t:{after(fn:()=>void):void},custom?:FixtureTool['execute']) {
  const directory=mkdtempSync(join(tmpdir(),'daming governance '));const file=join(directory,'state.sqlite');
  const store=new SqliteStore(file);const engine=new Engine(store);let now=NOW;let calls=0;
  engine.execute({type:'create_task',context:{taskId:'task',runId:'run',attemptId:'attempt',eventId:'create',sourceId:'fixture',occurredAt:new Date(now).toISOString()},title:'Governance fixture',goal:'Synthetic inputs only'});
  for(const to of ['planned','queued','running'] as const)engine.execute({type:'transition_task',context:{taskId:'task',runId:'run',attemptId:'attempt',eventId:to,sourceId:'fixture',occurredAt:new Date(now).toISOString()},expectedVersion:engine.getTask('task')!.version,to});
  const options={repository:store,engine,clock:()=>now,tools:[{id:'fixture.send',version:'1',fixtureOnly:true as const,execute:async(...args:Parameters<FixtureTool['execute']>)=>{calls++;return custom?custom(...args):{status:'succeeded' as const,actualCashMinor:500,result:{receipt:'fixture'}};}}]};
  const governance=createGovernance(options);governance.admin.setBudget('task',2000);
  const quote=(op:Operation,max:number|null=1200)=>governance.admin.issueQuote(op,max,NOW+60000,'fixture');
  const approve=(op:Operation)=>governance.admin.approve(op,NOW+30000);
  const enqueue=(op:Operation)=>{
    engine.execute({type:'enqueue_effect',context:{taskId:'task',runId:'run',attemptId:'attempt',eventId:'enqueue-'+op.id,sourceId:'fixture',occurredAt:new Date(now).toISOString()},expectedVersion:engine.getTask('task')!.version,effect:{effectId:'effect-'+op.id,idempotencyKey:op.id,kind:'governance.tool',payload:{operation:op as never},semantics:'non_idempotent'}});
  };
  const claim=(op:Operation)=>{enqueue(op);return store.claimNext(new Date(now).toISOString())!;};
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  return {store,file,engine,governance,quote,approve,enqueue,claim,get calls(){return calls;},setNow:(value:number)=>{now=value;}};
}
