import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SqliteStore} from '../../store-sqlite/src/index.ts';
import {GovernanceError,CostLedger} from '../src/index.ts';
import {harness,operation,NOW} from './helpers.ts';

const reduction={remainingCashMinor:1,evidence:'User checked supplier view: this completed operation costs less than CNY0.01; keep one minor unit unknown.',executorStopped:true as const};
async function unknown(t:Parameters<typeof harness>[0]){
 const h=harness(t,async()=>({status:'unknown',reason:'cash_unconfirmed',observation:{text:'OK',cashConfirmed:false,outboundAttempts:1}}));
 const op=operation();h.quote(op);const token=h.approve(op);await h.governance.gateway.execute(h.claim(op),token);
 return Object.assign(h,{op});
}
test('unknown hold reduction releases only the excess and preserves the original binding and unknown task facts',async t=>{
 const h=await unknown(t);
 const quote=h.store.governanceGet('quotes',h.op.quoteId),execution=h.store.governanceGet('executions',h.op.id),effect=h.store.getEffect('effect-op'),task=h.engine.getTask('task');
 const result=h.governance.admin.reduceUnknownHold(h.op.id,reduction);
 assert.equal(result.maximumCashMinor,1200);assert.equal(result.heldCashMinor,1);assert.equal(result.status,'unknown');assert.equal(result.actualCashMinor,undefined);
 assert.equal(h.governance.ledger.budget('task')!.heldMinor,1);assert.equal(h.governance.ledger.budget('task')!.spentMinor,0);
 assert.deepEqual(h.store.governanceGet('quotes',h.op.quoteId),quote);
 assert.deepEqual(h.store.governanceGet('executions',h.op.id),execution);
 assert.deepEqual(h.store.getEffect('effect-op'),effect);assert.deepEqual(h.engine.getTask('task'),task);assert.equal(h.calls,1);
 const audit=h.store.listGovernanceAudit('task').filter(a=>a.type==='unknown_hold_reduced');
 assert.equal(audit.length,1);assert.equal(audit[0]!.amountMinor,1199);assert.match(JSON.stringify(audit[0]!.detail),/cashConfirmed/);
 assert.equal('reduceUnknownHold' in h.governance.gateway,false);
});
test('same reduction is idempotent across SQLite reopen and cannot expand or erase an unknown hold',async t=>{
 const h=await unknown(t);h.governance.admin.reduceUnknownHold(h.op.id,reduction);
 const reopened=new SqliteStore(h.file);try {const ledger=new CostLedger(reopened,()=>NOW);
 const before=reopened.listGovernanceAudit('task').length;
 ledger.reduceUnknownHold(h.op.id,reduction);
 assert.equal(ledger.budget('task')!.heldMinor,1);assert.equal(reopened.listGovernanceAudit('task').length,before);
 for(const remainingCashMinor of [0,2,1201,-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]){
  assert.throws(()=>ledger.reduceUnknownHold(h.op.id,{...reduction,remainingCashMinor}),GovernanceError);
 }
 assert.equal(ledger.budget('task')!.heldMinor,1);assert.equal(reopened.listGovernanceAudit('task').length,before);
 }finally{reopened.close();}
});
test('unknown hold reduction refuses absent evidence and an executor not confirmed stopped',async t=>{
 const h=await unknown(t);
 for(const input of [{...reduction,evidence:''},{...reduction,evidence:'  '},{...reduction,executorStopped:false},{remainingCashMinor:1,evidence:'observed'}]){
  assert.throws(()=>h.governance.admin.reduceUnknownHold(h.op.id,input as never),GovernanceError);
 }
 assert.equal(h.governance.ledger.budget('task')!.heldMinor,1200);
});
test('reserved work and incomplete unknown bookkeeping cannot release cash through reduction',t=>{
 const h=harness(t),op=operation();h.quote(op);h.governance.ledger.reserve(op);
 assert.throws(()=>h.governance.admin.reduceUnknownHold(op.id,reduction),GovernanceError);
 h.governance.ledger.markUnknown(op.id);
 assert.throws(()=>h.governance.admin.reduceUnknownHold(op.id,reduction),GovernanceError);
 assert.equal(h.governance.ledger.budget('task')!.heldMinor,1200);
});
test('later settlement and confirmed nonexecution release only the reduced hold without consuming other reservations',async t=>{
 for(const terminal of ['settle','release'] as const)await t.test(terminal,async t=>{
  const h=await unknown(t);const other=operation('other');h.quote(other,500);h.governance.ledger.reserve(other);
  h.governance.admin.reduceUnknownHold(h.op.id,reduction);
  assert.equal(h.governance.ledger.budget('task')!.heldMinor,501);
  const result=terminal==='settle'?h.governance.ledger.settle(h.op.id,1):h.governance.ledger.release(h.op.id);
  assert.equal(result.heldCashMinor,0);assert.equal(h.governance.ledger.budget('task')!.heldMinor,500);
  assert.equal(h.governance.ledger.budget('task')!.spentMinor,terminal==='settle'?1:0);
  assert.throws(()=>h.governance.admin.reduceUnknownHold(h.op.id,reduction),GovernanceError);
  h.governance.ledger.release(other.id);assert.equal(h.governance.ledger.budget('task')!.heldMinor,0);
 });
});
test('a confirmed cost above the refined exposure is a breach even below the original quote',async t=>{
 const h=await unknown(t);h.governance.admin.reduceUnknownHold(h.op.id,reduction);
 const result=h.governance.ledger.settle(h.op.id,2);
 assert.equal(result.status,'breached');assert.equal(result.maximumCashMinor,1200);
 assert.equal(h.governance.ledger.budget('task')!.spentMinor,2);assert.equal(h.governance.ledger.budget('task')!.heldMinor,0);assert.equal(h.governance.ledger.budget('task')!.breached,true);
});
test('audit write failure rolls back both the reduced reservation and aggregate cash',async t=>{
 const h=await unknown(t);const before=h.store.governanceGet('reservations',h.op.id),budget=h.governance.ledger.budget('task');
 const failure=t.mock.method(h.store,'appendGovernanceAudit',()=>{throw new Error('synthetic audit I/O failure');});
 assert.throws(()=>h.governance.admin.reduceUnknownHold(h.op.id,reduction),/synthetic audit/);failure.mock.restore();
 assert.deepEqual(h.store.governanceGet('reservations',h.op.id),before);assert.deepEqual(h.governance.ledger.budget('task'),budget);
});
