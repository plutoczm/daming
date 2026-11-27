import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../packages/core/src/index.ts';
import { SqliteStore } from '../packages/store-sqlite/src/index.ts';
import { FixtureWorker } from '../packages/workers/src/index.ts';
import { TaskCoordinator } from '../apps/server/src/task-coordinator.ts';
const dir=mkdtempSync(join(tmpdir(),'daming workflow demo '));
const store=new SqliteStore(join(dir,'fixture.sqlite'));
try{
 const descriptor=(id,executorKind)=>({id,executorKind,executionMode:'fixture',runtime:'fixture-v1',provider:'fixture',model:'fixture',routeMode:'native',os:'win32',health:'ready',credentialsReady:true,capabilities:['text'],permissions:[],network:'offline',dataScopes:['synthetic'],maxCashMinor:10,priceVerified:true,quotaRemaining:100,concurrencyLimit:3,activeCount:0,isolation:'fixture_only'});
 const descriptors=[descriptor('fixture-dsh','dsh'),descriptor('fixture-codex','codex')];
 const engine=new Engine(store);
 const coordinator=new TaskCoordinator({store,engine,authorization:'synthetic-approved',workers:descriptors.map((descriptor,i)=>({descriptor,worker:new FixtureWorker(descriptor.executorKind,{delayMs:3}),behavior:i===0?'first_invalid':'echo'}))});
 const plan={planId:'demo-plan',version:1,category:'offline-demo',policyVersion:'supervisor-v1',candidates:descriptors.map(d=>({id:d.id,executorKind:d.executorKind,version:d.runtime,provider:d.provider,model:d.model,routeMode:d.routeMode,concurrencyLimit:d.concurrencyLimit})),steps:['one','two','three','join'].map((stepId,i)=>({stepId,description:stepId,workerId:descriptors[i%2].id,dependsOn:i===3?['one','two','three']:[],input:'{"ok":true}',contract:{version:1,checks:[{id:'ok',version:1,artifactId:'result',kind:'json_equals',expected:{ok:true}}]}}))};
 const tasks=[];for(let i=1;i<=3;i++){const taskId='offline-demo-'+i;coordinator.createTask({taskId,title:'Offline governed workflow',goal:'Independent acceptance and bounded adaptation',plan,limitMinor:100});await coordinator.run(taskId);const task=engine.getTask(taskId);const budget=store.governanceGet('budgets',taskId);tasks.push({taskId,status:task.status,assignments:task.workflow.assignments.length,reworks:task.workflow.assignments.filter(a=>a.stepAttempt>1).length,reviews:task.workflow.reviews.map(r=>r.verdict),initialConcurrency:task.workflow.decisions[0].next.concurrency,finalConcurrency:task.workflow.policy.concurrency,reworkLimit:task.workflow.plan.steps[0].maxReworks,policyChanges:task.workflow.decisions.filter(d=>d.previous.concurrency!==d.next.concurrency).map(d=>({from:d.previous.concurrency,to:d.next.concurrency,reason:d.reason,samples:d.samples.length})),syntheticSpentMinor:budget.spentMinor,heldMinor:budget.heldMinor});}
 console.log(JSON.stringify({mode:'workflow_fixture',tasks,maximumObservedParallel:Math.max(...coordinator.observations.map(o=>o.active)),allEntriesGoverned:coordinator.observations.every(o=>o.heldMinor>=10&&o.approvalConsumed),externalModelRequests:coordinator.externalModelRequests},null,2));
}finally{store.close();rmSync(dir,{recursive:true,force:true});}
