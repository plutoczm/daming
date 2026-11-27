import { Engine } from '@daming/core';
import { SqliteStore } from '../../../store-sqlite/src/index.ts';
import { createGovernance } from '../../src/index.ts';
import { appendFileSync } from 'node:fs';
const [file,marker]=process.argv.slice(2);const store=new SqliteStore(file);const engine=new Engine(store);
const governance=createGovernance({repository:store,engine,clock:()=>Date.parse('2026-11-06T00:00:00Z'),tools:[{id:'fixture.send',version:'1',fixtureOnly:true,execute:async()=>{
  appendFileSync(marker,'fixture-effect\n');process.send({executed:true});await new Promise(()=>{setInterval(()=>{},1000);});
}}]});
process.once('message',async message=>{await governance.gateway.execute(store.getEffect('effect-op'),message.token);});
process.send({waiting:true});
