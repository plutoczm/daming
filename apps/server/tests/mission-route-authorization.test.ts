import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MissionControl, MissionError } from '../src/mission-control.ts';
import { projectMagpieRoutingCatalog, publicMagpieRoutingCatalog } from '../src/magpie-routing.ts';

const INSTANCE = '1234567890abcdef1234567890abcdef';
const rawProvider = (keys: unknown[] = [{ id: '1234567890', on: true }]) => ({
  providers: [{
    id: 'demo-provider', name: 'secret@example.com', ready: true,
    keyList: keys, models: ['demo-model'], apiKey: 'sk-not-for-public',
    account: null
  }]
});

test('Magpie route catalog is single-account only and never leaks private identities', () => {
  const catalog = projectMagpieRoutingCatalog(rawProvider(), INSTANCE);
  assert.equal(catalog.candidates.length, 1);
  assert.equal(catalog.candidates[0]?.accountRef, '1234567890');
  const safe = publicMagpieRoutingCatalog(catalog);
  assert.equal(safe.dispatchEnabled, false);
  assert.equal(safe.accountIdentityExposed, false);
  assert.doesNotMatch(JSON.stringify(safe), /1234567890|sk-not-for-public|example.com/i);
  const multiple = rawProvider([{ id: '1234567890', on: true }, { id: 'abcdef1234', on: true }]);
  assert.equal(projectMagpieRoutingCatalog(multiple, INSTANCE).candidates.length, 0, 'unkeyed opaque catalog denies multi-account discovery');
  const multi = projectMagpieRoutingCatalog(multiple, INSTANCE, 'private-test-instance-auth-secret');
  assert.equal(multi.candidates.length, 2);
  assert.ok(multi.candidates.every((c) => c.accountType === 'api-key'));
  assert.notEqual(multi.candidates[0].candidateId, multi.candidates[1].candidateId);
  assert.ok(multi.candidates.every((c) => !c.candidateId.includes(c.accountRef)));
  assert.deepEqual(
    projectMagpieRoutingCatalog(multiple, INSTANCE, 'private-test-instance-auth-secret').candidates.map((c) => c.candidateId),
    multi.candidates.map((c) => c.candidateId)
  );
  assert.doesNotMatch(JSON.stringify(publicMagpieRoutingCatalog(multi)), /1234567890|abcdef1234|private-test-instance-auth-secret/);
  assert.equal(projectMagpieRoutingCatalog(rawProvider([{ id: '1234567890', on: false }]), INSTANCE).candidates.length, 0);
  assert.equal(projectMagpieRoutingCatalog({ providers: [{ ...rawProvider().providers[0], account: { user: 'private' } }] }, INSTANCE).candidates.length, 0);
});

test('mission authorization with persisted awaiting-decision state enforces lease constraints', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daming-route-auth-'));
  let store = new MissionControl(dir);
  try {
    const m = store.create({ mode: 'offline-demo', title: 'test', goal: 'safe', requestId: randomUUID() });
    const result = await store.autoloopJob({
      context: { events: [{ type: 'mission.requested', subject: m.missionId }], answers: [] }
    } as never);
    assert.equal(result.outcome, 'done');
    store.attachCard(m.missionId, 1);
    const route = projectMagpieRoutingCatalog(rawProvider(), INSTANCE);
    const requestId = randomUUID();
    const input = { requestId, candidateId: 'demo-provider|demo-model', ttlMinutes: 15,
      maxRequests: 1, maxOutputTokens: 512, maxCashMinor: 100 };
    const granted = store.authorizeRoute(m.missionId, input, route);
    assert.equal(granted.state, 'authorized');
    assert.equal(granted.dispatchEnabled, false);
    assert.equal(store.preflightRoute(m.missionId, route).accountBindingValid, true);
    assert.equal(store.preflightRoute(m.missionId, route).dispatchPermitted, false);
    assert.equal(store.authorizeRoute(m.missionId, input, route).authorizationId, granted.authorizationId);
    assert.throws(() => store.authorizeRoute(m.missionId, { ...input, requestId: randomUUID(), maxCashMinor: 101 }, route), /route_authorization_already_exists/);
    assert.equal(store.preflightRoute(m.missionId, projectMagpieRoutingCatalog(rawProvider([{ id: 'abcdef1234', on: true }]), INSTANCE)).accountBindingValid, false);
    assert.equal(store.preflightRoute(m.missionId, { ...route, instanceId: 'ffffffffffffffffffffffffffffffff' }).accountBindingValid, false);
    assert.throws(() => store.prepareRouteAttempt(m.missionId, {
      requestId: randomUUID(), outputTokenCeiling: 32, budgetEnvelopeMinor: 10
    }, { ...route, instanceId: 'ffffffffffffffffffffffffffffffff' }), /route_account_changed_or_expired/);
    const prepare = { requestId: randomUUID(), outputTokenCeiling: 256, budgetEnvelopeMinor: 90 };
    const first = store.prepareRouteAttempt(m.missionId, prepare, route);
    assert.equal(first.state, 'prepared');
    assert.equal(first.modelRequestSent, false);
    assert.equal(store.prepareRouteAttempt(m.missionId, prepare, route).attemptId, first.attemptId);
    assert.throws(() => store.prepareRouteAttempt(m.missionId, {
      ...prepare, budgetEnvelopeMinor: 91
    }, route), /route_attempt_request_conflict/);
    assert.throws(() => store.prepareRouteAttempt(m.missionId, {
      requestId: randomUUID(), outputTokenCeiling: 512, budgetEnvelopeMinor: 100
    }, route), /route_attempt_budget_exhausted/);
    assert.equal(store.cancelRouteAttempt(m.missionId, first.attemptId).state, 'cancelled');
    assert.throws(() => store.cancelRouteAttempt(m.missionId, first.attemptId), /route_attempt_not_prepared/);
    const second = store.prepareRouteAttempt(m.missionId, {
      requestId: randomUUID(), outputTokenCeiling: 512, budgetEnvelopeMinor: 100
    }, route);
    assert.equal(second.state, 'prepared');
    assert.equal(store.detail(m.missionId).routeAttempts.length, 2);
    assert.ok(store.detail(m.missionId).events.some((e) => e.type === 'route.attempt.prepared'));
    store.close();
    store = new MissionControl(dir);
    assert.equal(store.authorization(m.missionId)?.authorizationId, granted.authorizationId);
    assert.equal(store.detail(m.missionId).routeAttempts.length, 2);
    assert.equal(store.routeAttempts(m.missionId).filter((a) => a.state === 'prepared').length, 1);
    assert.equal(store.revokeRoute(m.missionId).state, 'revoked');
    assert.throws(() => store.prepareRouteAttempt(m.missionId, {
      requestId: randomUUID(), outputTokenCeiling: 1, budgetEnvelopeMinor: 0
    }, route), /route_account_changed_or_expired/);
    assert.equal(store.preflightRoute(m.missionId, route).accountBindingValid, false);
    assert.throws(() => store.revokeRoute(m.missionId), /route_authorization_not_active/);
    assert.doesNotMatch(JSON.stringify(store.detail(m.missionId)), /1234567890|sk-not-for-public/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('two SQLite mission writers cannot overbook request and cash envelopes across connections', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daming-route-concurrent-'));
  const first = new MissionControl(dir);
  let second: MissionControl | undefined;
  try {
    const mission = first.create({
      mode: 'offline-demo', title: 'ledger', goal: 'no remote effects', requestId: randomUUID()
    });
    await first.autoloopJob({
      context: { events: [{ type: 'mission.requested', subject: mission.missionId }], answers: [] }
    } as never);
    first.attachCard(mission.missionId, 1);
    const route = projectMagpieRoutingCatalog(rawProvider(), INSTANCE);
    first.authorizeRoute(mission.missionId, {
      requestId: randomUUID(), candidateId: 'demo-provider|demo-model',
      ttlMinutes: 15, maxRequests: 2, maxOutputTokens: 512, maxCashMinor: 150
    }, route);
    second = new MissionControl(dir);
    const a = first.prepareRouteAttempt(mission.missionId, {
      requestId: randomUUID(), outputTokenCeiling: 200, budgetEnvelopeMinor: 100
    }, route);
    assert.throws(() => second!.prepareRouteAttempt(mission.missionId, {
      requestId: randomUUID(), outputTokenCeiling: 200, budgetEnvelopeMinor: 100
    }, route), /route_attempt_budget_exhausted/);
    const b = second.prepareRouteAttempt(mission.missionId, {
      requestId: randomUUID(), outputTokenCeiling: 200, budgetEnvelopeMinor: 50
    }, route);
    assert.throws(() => first.prepareRouteAttempt(mission.missionId, {
      requestId: randomUUID(), outputTokenCeiling: 200, budgetEnvelopeMinor: 0
    }, route), /route_attempt_budget_exhausted/);
    assert.equal(first.routeAttempts(mission.missionId).filter((v) => v.state === 'prepared').length, 2);
    assert.equal(first.routeAttempts(mission.missionId).reduce((sum, v) => sum + v.budgetEnvelopeMinor, 0), 150);
    assert.equal(a.modelRequestSent, false);
    assert.equal(b.modelRequestSent, false);
    second.close();
    second = new MissionControl(dir);
    assert.equal(second.routeAttempts(mission.missionId).length, 2);
    second.cancelRouteAttempt(mission.missionId, a.attemptId);
    const c = first.prepareRouteAttempt(mission.missionId, {
      requestId: randomUUID(), outputTokenCeiling: 1, budgetEnvelopeMinor: 99
    }, route);
    assert.equal(c.modelRequestSent, false);
    assert.equal(first.routeAttempts(mission.missionId).filter((v) => v.state === 'prepared')
      .reduce((sum, v) => sum + v.budgetEnvelopeMinor, 0), 149);
  } finally {
    second?.close();
    first.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
