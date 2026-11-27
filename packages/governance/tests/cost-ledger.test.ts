import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GovernanceError } from '../src/index.ts';
import { harness,operation,NOW } from './helpers.ts';
test('cash holds cannot exceed a task ceiling and unknown prices are not free',t=>{
  const h=harness(t);const a=operation('a');const b=operation('b');h.quote(a);h.quote(b);
  h.governance.ledger.reserve(a);assert.throws(()=>h.governance.ledger.reserve(b),GovernanceError);
  assert.equal(h.governance.ledger.budget('task')!.heldMinor,1200);
  const unknown=operation('unknown');h.quote(unknown,null);
  assert.throws(()=>h.governance.ledger.reserve(unknown),GovernanceError);
  assert.equal(h.governance.ledger.budget('task')!.heldMinor,1200);
});
test('reservation replay is idempotent, actual cash settles once and releases unused hold',t=>{
  const h=harness(t);const op=operation();h.quote(op);
  h.governance.ledger.reserve(op);h.governance.ledger.reserve(op);
  h.governance.ledger.settle(op.id,500);h.governance.ledger.settle(op.id,500);
  const budget=h.governance.ledger.budget('task')!;assert.equal(budget.spentMinor,500);assert.equal(budget.heldMinor,0);
  assert.throws(()=>h.governance.ledger.settle(op.id,600),GovernanceError);
});
test('known not-executed work releases once; unknown work retains its cash hold',t=>{
  const h=harness(t);const op=operation();h.quote(op);h.governance.ledger.reserve(op);
  h.governance.ledger.markUnknown(op.id);
  assert.equal(h.governance.ledger.budget('task')!.heldMinor,1200);
  h.governance.ledger.release(op.id);h.governance.ledger.release(op.id);
  assert.equal(h.governance.ledger.budget('task')!.heldMinor,0);assert.equal(h.governance.ledger.budget('task')!.spentMinor,0);
});
test('native/magpie and billing basis remain distinct; gateway observations are not quotes',t=>{
  const h=harness(t);const op=operation('gateway',{route:{mode:'magpie',provider:'fixture',model:'fixture',accountRef:'gateway-account'}});
  h.governance.admin.issueQuote(op,500,NOW+60000,'official_api');
  const reservation=h.governance.ledger.reserve(op);assert.equal(reservation.route.mode,'magpie');assert.equal(reservation.billingSource,'official_api');
  assert.throws(()=>h.governance.ledger.reserve(operation('no-host-quote')),GovernanceError);
});
test('unsafe/fractional amounts and stale quote bounds are rejected',t=>{
  const h=harness(t);
  for(const amount of [-1,1.5,Infinity,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>h.governance.admin.setBudget('task',amount),GovernanceError);
  const op=operation();h.quote(op);h.setNow(NOW+60001);assert.throws(()=>h.governance.ledger.reserve(op),GovernanceError);
});

test('comprehensive shadow cost cannot consume or replace the cash commitment',t=>{
  const h=harness(t);const op=operation('subscription');
  h.governance.admin.issueQuote(op,0,NOW+60000,'subscription',9000);
  const reservation=h.governance.ledger.reserve(op);assert.equal(reservation.comprehensiveEstimateMinor,9000);
  assert.equal(h.governance.ledger.budget('task')!.heldMinor,0);
  const unknown=operation('unknown-shadow');h.governance.admin.issueQuote(unknown,null,NOW+60000,'official_api',9000);
  assert.throws(()=>h.governance.ledger.reserve(unknown),GovernanceError);
});

test('a retry after release re-budgets against the current ceiling instead of reusing the stale hold',t=>{
  const h=harness(t);
  const first=operation('retry-1');h.quote(first,1200);h.governance.ledger.reserve(first);
  assert.equal(h.governance.ledger.budget('task')!.heldMinor,1200);
  h.governance.ledger.release(first.id);
  assert.equal(h.governance.ledger.budget('task')!.heldMinor,0);
  // Re-reserving the released operation idempotently returns the terminal reservation without re-arming cash.
  assert.equal(h.governance.ledger.reserve(first).status,'released');
  assert.equal(h.governance.ledger.budget('task')!.heldMinor,0);
  // The retry is a new operation; it is budgeted anew at its own upper bound against the current ceiling.
  const retry=operation('retry-2');h.quote(retry,1500);h.governance.ledger.reserve(retry);
  assert.equal(h.governance.ledger.budget('task')!.heldMinor,1500);
  const tooMuch=operation('retry-3');h.quote(tooMuch,600);
  assert.throws(()=>h.governance.ledger.reserve(tooMuch),GovernanceError);
  assert.equal(h.governance.ledger.budget('task')!.heldMinor,1500);
  assert.equal(h.governance.ledger.budget('task')!.spentMinor,0);
});
