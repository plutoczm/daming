import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MissionControl } from '../src/mission-control.ts';
import { projectMagpieRoutingCatalog } from '../src/magpie-routing.ts';
import { quoteSyntheticRouteCeiling } from '../src/mission-route-price.ts';

const INSTANCE = 'abcdef1234567890abcdef1234567890';
const CLAIM = { tenantId: 'tenant-a', principalId: 'user-a' } as const;
const WRONG = { tenantId: 'tenant-b', principalId: 'user-b' } as const;
const CATALOG = projectMagpieRoutingCatalog({
  providers: [{
    id: 'fixture-provider', name: 'Sensitive Owner Example',
    ready: true, account: null, models: ['offline-model'],
    keyList: [{ id: '1234567890', on: true }]
  }]
}, INSTANCE);
const CANDIDATE = CATALOG.candidates[0]!;
const BINDING = {
  instanceId: INSTANCE, providerId: CANDIDATE.providerId,
  modelId: CANDIDATE.modelId, accountRef: CANDIDATE.accountRef
};
const PRICE = {
  source: 'synthetic_fixture' as const, id: 'fixture-price-1',
  providerId: BINDING.providerId, modelId: BINDING.modelId,
  verifiedAtMs: Date.now() - 60000, expiresAtMs: Date.now() + 600000,
  inputMinorPerMillion: 10000, outputMinorPerMillion: 100000,
  maximumInputTokens: 1024, nonTokenMaximumMinor: 0 as const
};

async function readyMission(store: MissionControl, maxRequests = 2, maxCashMinor = 150) {
  const mission = store.create({ title: 'Synthetic owned mission', goal: 'No paid dispatch',
    requestId: randomUUID(), mode: 'offline-demo' });
  await store.autoloopJob({
    context: { events: [{ type: 'mission.requested', subject: mission.missionId }], answers: [] }
  } as never);
  store.attachCard(mission.missionId, 1);
  store.authorizeRoute(mission.missionId, {
    requestId: randomUUID(), candidateId: CANDIDATE.candidateId,
    ttlMinutes: 15, maxRequests, maxOutputTokens: 128, maxCashMinor
  }, CATALOG);
  return mission.missionId;
}
function reserve(store: MissionControl, id: string, amount: number, tokens = 64) {
  return store.prepareRouteAttempt(id, {
    requestId: randomUUID(), outputTokenCeiling: tokens, budgetEnvelopeMinor: amount
  }, CATALOG);
}
function privateProjection(store: MissionControl, id: string) {
  return JSON.stringify(store.detail(id));
}

test('synthetic price ceiling rejects stale, wrong model and extra billable routes', () => {
  const quote = quoteSyntheticRouteCeiling(PRICE, {
    providerId: BINDING.providerId, modelId: BINDING.modelId, outputTokens: 32
  });
  assert.equal(quote.ceilingMinor, 15);
  assert.equal(quote.hardVendorCashCap, false);
  assert.equal(quote.dispatchPermitted, false);
  assert.throws(() => quoteSyntheticRouteCeiling({ ...PRICE, expiresAtMs: Date.now() - 1 }, {
    providerId: BINDING.providerId, modelId: BINDING.modelId, outputTokens: 32
  }), /route_price_basis_untrusted_or_expired/);
  assert.throws(() => quoteSyntheticRouteCeiling(PRICE, {
    providerId: BINDING.providerId, modelId: 'different-model', outputTokens: 32
  }), /route_price_basis_untrusted_or_expired/);
  assert.throws(() => quoteSyntheticRouteCeiling({
    ...PRICE, nonTokenMaximumMinor: 2 as never
  }, { providerId: BINDING.providerId, modelId: BINDING.modelId, outputTokens: 32 }), /route_price_basis_untrusted_or_expired/);
  assert.throws(() => quoteSyntheticRouteCeiling({
    ...PRICE, inputMinorPerMillion: 1e16
  }, { providerId: BINDING.providerId, modelId: BINDING.modelId, outputTokens: 32 }), /route_price_basis_untrusted_or_expired/);
});

test('fixture send intent requires verified synthetic owner and never replays on restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daming-route-receipt-'));
  let store = new MissionControl(dir);
  try {
    const id = await readyMission(store);
    const first = reserve(store, id, 100);
    assert.throws(() => store.beginSyntheticPossibleSend(id, first.attemptId, CLAIM, CATALOG, PRICE), /mission_principal_not_verified/);
    store.bindSyntheticMissionPrincipal(id, CLAIM);
    assert.throws(() => store.bindSyntheticMissionPrincipal(id, WRONG), /mission_principal_mismatch/);
    assert.throws(() => store.beginSyntheticPossibleSend(id, first.attemptId, WRONG, CATALOG, PRICE), /mission_principal_not_verified/);
    assert.throws(() => store.beginSyntheticPossibleSend(id, first.attemptId, CLAIM, CATALOG, PRICE), /route_account_ownership_unverified/);
    store.claimSyntheticRouteAccount(CLAIM, BINDING);
    assert.throws(() => store.claimSyntheticRouteAccount(WRONG, BINDING), /account_claim_owner_mismatch/);
    assert.throws(() => store.beginSyntheticPossibleSend(id, first.attemptId, CLAIM,
      { ...CATALOG, instanceId: 'ffffffffffffffffffffffffffffffff' }, PRICE), /route_binding_changed_or_expired/);
    assert.throws(() => store.beginSyntheticPossibleSend(id, first.attemptId, CLAIM, CATALOG, {
      ...PRICE, maximumInputTokens: 1048576, inputMinorPerMillion: 1000000
    }), /route_price_exceeds_held_envelope/);
    const unknown = store.beginSyntheticPossibleSend(id, first.attemptId, CLAIM, CATALOG, PRICE);
    assert.equal(unknown.state, 'unknown_after_send');
    assert.equal(unknown.observedCashMinor, null);
    assert.equal(unknown.vendorInvoiceVerified, false);
    assert.equal(unknown.productionDispatchEnabled, false);
    assert.throws(() => store.cancelRouteAttempt(id, first.attemptId), /route_attempt_not_prepared|route_attempt_may_have_been_sent/);
    assert.throws(() => store.beginSyntheticPossibleSend(id, first.attemptId, CLAIM, CATALOG, PRICE), /route_attempt_may_have_been_sent/);
    assert.equal(store.routeAttempts(id)[0].modelRequestSent, 'possible');
    assert.equal(store.detail(id).routeReceipts.length, 1);
    assert.ok(store.detail(id).events.some(e => e.type === 'route.send.unknown'));
    assert.doesNotMatch(privateProjection(store, id), /1234567890|tenant-a|user-a|Sensitive Owner Example/);
    store.close();
    store = new MissionControl(dir);
    assert.equal(store.routeReceipts(id)[0].state, 'unknown_after_send');
    assert.throws(() => store.cancelRouteAttempt(id, first.attemptId), /route_attempt_not_prepared|route_attempt_may_have_been_sent/);
    assert.throws(() => store.beginSyntheticPossibleSend(id, first.attemptId, CLAIM, CATALOG, PRICE), /route_attempt_may_have_been_sent/);
    // The mock receipt is NOT vendor-billed evidence; original 100-minor
    // envelope remains committed even after simulated settlement.
    const evidence = { evidenceRef: 'fixture:' + randomUUID(),
      inputTokens: 7, outputTokens: 3, cashMinor: 7 };
    const settled = store.reconcileSyntheticReceipt(id, first.attemptId, CLAIM, evidence);
    assert.equal(settled.state, 'settled_synthetic');
    assert.equal(settled.observedCashMinor, 7);
    assert.equal(store.reconcileSyntheticReceipt(id, first.attemptId, CLAIM, evidence).state, 'settled_synthetic');
    assert.throws(() => store.reconcileSyntheticReceipt(id, first.attemptId, CLAIM, {
      ...evidence, cashMinor: 8
    }), /route_receipt_conflict/);
    assert.throws(() => store.reconcileSyntheticReceipt(id, first.attemptId, WRONG, evidence), /mission_principal_not_verified/);
    const second = reserve(store, id, 50);
    assert.equal(second.state, 'prepared');
    assert.throws(() => reserve(store, id, 1), /route_attempt_budget_exhausted/);
    store.revokeSyntheticRouteAccount(CLAIM, BINDING);
    assert.throws(() => store.beginSyntheticPossibleSend(id, second.attemptId, CLAIM, CATALOG, PRICE),
      /route_account_ownership_unverified/);
    assert.equal(store.routeReceipts(id)[0].vendorInvoiceVerified, false);
    assert.doesNotMatch(privateProjection(store, id), /1234567890|tenant-a|user-a|fixture:[a-f0-9-]{36}/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('simulated cash/token overrun freezes the authorization and cannot be cancelled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daming-route-breach-'));
  const store = new MissionControl(dir);
  try {
    const id = await readyMission(store, 2, 150);
    store.bindSyntheticMissionPrincipal(id, CLAIM);
    store.claimSyntheticRouteAccount(CLAIM, BINDING);
    const attempt = reserve(store, id, 80);
    store.beginSyntheticPossibleSend(id, attempt.attemptId, CLAIM, CATALOG, PRICE);
    const breach = store.reconcileSyntheticReceipt(id, attempt.attemptId, CLAIM, {
      evidenceRef: 'fixture:' + randomUUID(),
      inputTokens: 12, outputTokens: 90, cashMinor: 100
    });
    assert.equal(breach.state, 'breached_synthetic');
    assert.throws(() => reserve(store, id, 1), /route_cash_dispute_blocks_new_attempts/);
    assert.throws(() => store.cancelRouteAttempt(id, attempt.attemptId), /route_attempt_not_prepared|route_attempt_may_have_been_sent/);
    assert.equal(store.authorization(id)?.dispatchEnabled, false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('two Host SQLite connections cannot duplicate the unknown-before-send marker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daming-route-fence-'));
  let one = new MissionControl(dir);
  let two: MissionControl | null = null;
  try {
    const id = await readyMission(one);
    one.bindSyntheticMissionPrincipal(id, CLAIM);
    one.claimSyntheticRouteAccount(CLAIM, BINDING);
    const attempt = reserve(one, id, 100);
    two = new MissionControl(dir);
    assert.equal(one.beginSyntheticPossibleSend(id, attempt.attemptId, CLAIM, CATALOG, PRICE).state, 'unknown_after_send');
    assert.throws(() => two!.beginSyntheticPossibleSend(id, attempt.attemptId, CLAIM, CATALOG, PRICE),
      /route_attempt_may_have_been_sent/);
    assert.equal(two.routeReceipts(id).length, 1);
  } finally {
    two?.close();
    one.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
