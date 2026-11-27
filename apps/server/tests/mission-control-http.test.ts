import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBoardHost } from '../src/http.ts';
import type { BoardHostHandle } from '../src/http.ts';
import type { MagpieHost } from '../src/magpie-host.ts';

const offlineMagpie = {
  async ensure() { return { enabled: true, running: true, configured: true, checkedAt: new Date().toISOString(), version: 'offline' }; },
  async status() { return { enabled: true, running: true, configured: true, checkedAt: new Date().toISOString(), version: 'offline' }; },
  async read(alias: string) {
    return alias === 'models'
      ? { alias, count: 2, labels: ['synthetic-model-a', 'synthetic-model-b'], items: [], checkedAt: new Date().toISOString() }
      : alias === 'providers'
        ? { alias, count: 1, labels: [], items: [{ name: 'offline-test', id: 'offline-test', kind: 'provider', status: 'ready', detail: '0 accounts' }], checkedAt: new Date().toISOString() }
        : { alias, count: 0, labels: [], items: [], checkedAt: new Date().toISOString() };
  },
  async routingCatalog() { return {
    instanceId: '1234567890abcdef1234567890abcdef', checkedAt: new Date().toISOString(),
    candidates: [{ candidateId: 'offline-test|synthetic-model-a', providerId: 'offline-test',
      modelId: 'synthetic-model-a', accountType: 'single-api-key', accountLabel: '唯一已启用 API Key', accountRef: 'abcdef1234' }]
  }; },
  async scopeCapability() { return true; },
  async probePinnedScope(binding: { instanceId: string; providerId: string; modelId: string; accountRef: string }) {
    assert.equal(binding.instanceId, '1234567890abcdef1234567890abcdef');
    assert.equal(binding.providerId, 'offline-test');
    assert.equal(binding.modelId, 'synthetic-model-a');
    assert.equal(binding.accountRef, 'abcdef1234');
    return { verified: true, keyRevoked: true, reason: 'mock_scope_checked_no_model_request' };
  },
  async post() { throw new Error('paid_or_write_action_forbidden'); },
  stop() {}
} as unknown as MagpieHost;

async function login(host: BoardHostHandle, token: string) {
  const response = await fetch(host.url + '?token=' + token, { redirect: 'manual' });
  assert.equal(response.status, 302);
  const cookie = response.headers.getSetCookie()[0].split(';')[0];
  const s = await fetch(host.url + 'api/session', { headers: { cookie } });
  const data = await s.json() as { csrfToken: string };
  return {
    cookie,
    headers: {
      cookie, 'content-type': 'application/json', origin: new URL(host.url).origin,
      'x-daming-csrf': data.csrfToken
    }
  };
}

test('command center: Magpie catalog -> actual Autoloop ask -> user decision -> persisted DAG/event preview', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'daming-mission-http-'));
  const webRoot = join(temp, 'web');
  mkdirSync(webRoot);
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>test</title>');
  const dataDir = join(temp, 'data');
  let permitScopeProbe = false;
  let consentAsked = 0;
  let host = await startBoardHost({
    dataDir, port: 0, webRoot, magpie: offlineMagpie,
    confirmMagpieAction: async (request) => {
      assert.match(request.action, /Magpie/);
      consentAsked++;
      return permitScopeProbe;
    },
    bootstrapToken: 'mission-test-readwrite-100',
    readOnlyBootstrapToken: 'mission-test-readonly-200'
  });
  t.after(async () => {
    await host.close();
    rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  let writer = await login(host, host.bootstrapToken);
  const reader = await login(host, host.readOnlyBootstrapToken!);
  const resources = await fetch(host.url + 'api/command/resources', { headers: { cookie: reader.cookie } });
  assert.equal(resources.status, 200);
  const catalog = await resources.json() as {
    source: string; models: { count: number }; providers: { ready: number }; dispatchEnabled: boolean;
    credentialsExposed: boolean;
  };
  assert.equal(catalog.source, 'magpie');
  assert.equal(catalog.models.count, 2);
  assert.equal(catalog.providers.ready, 1);
  assert.equal(catalog.dispatchEnabled, false);
  assert.equal(catalog.credentialsExposed, false);
  assert.equal((await fetch(host.url + 'api/command/resources')).status, 401);

  const body = {
    title: '研究两种方案的优缺点', goal: '只用规则型离线角色演示，绝不调用真实服务',
    requestId: randomUUID(), mode: 'offline-demo'
  };
  const create = await fetch(host.url + 'api/command/missions', {
    method: 'POST', headers: writer.headers, body: JSON.stringify(body)
  });
  assert.equal(create.status, 201);
  const mission = await create.json() as {
    missionId: string; cardId: number | null; status: string; mode: string;
    nodes: { id: string; status: string; modelRoute: string }[];
    events: { sequence: number; type: string; summary: string }[];
    notification: { channel: string; state: string; sent: boolean };
  };
  assert.equal(mission.status, 'awaiting_decision');
  assert.ok(mission.cardId && mission.cardId > 0);
  assert.equal(mission.mode, 'offline-demo');
  assert.equal(mission.nodes.length, 5);
  assert.equal(mission.nodes.find((node) => node.id === 'decision')?.status, 'waiting');
  assert.ok(mission.nodes.every((node) => node.modelRoute === 'unbound'));
  assert.ok(mission.events.some((event) => event.type === 'plan.frozen'));
  assert.ok(mission.events.some((event) => event.type === 'decision.card.bound'));
  assert.equal(mission.notification.state, 'preview_only');
  assert.equal(mission.notification.sent, false);
  assert.ok(mission.events.every((event) => !event.summary.includes('绝不调用')));
  const message = await fetch(host.url + 'api/command/missions/' + mission.missionId + '/notification-preview',
    { headers: { cookie: reader.cookie } });
  assert.equal(message.status, 200);
  const notification = await message.json() as {
    text: string; channels: { id: string; sent: boolean }[];
    sent: boolean; requiresVerifiedUserIdentity: boolean; requiresSignedCallback: boolean;
  };
  assert.equal(notification.sent, false);
  assert.equal(notification.channels.length, 4);
  assert.equal(notification.channels.find((item) => item.id === 'feishu')?.sent, false);
  assert.equal(notification.requiresVerifiedUserIdentity, true);
  assert.equal(notification.requiresSignedCallback, true);
  assert.ok(!JSON.stringify(notification).includes('绝不调用'));
  assert.equal((await fetch(host.url + 'api/command/missions/' + mission.missionId + '/notification-preview')).status, 401);

  const autoloop = await fetch(host.url + 'api/autoloop/state', { headers: { cookie: reader.cookie } });
  const state = await autoloop.json() as { cards: { id: number; kind: string; title: string; options: string[] }[] };
  assert.ok(state.cards.some((card) => card.id === mission.cardId && card.kind === 'ask' && card.options.length === 2));

  const repeat = await fetch(host.url + 'api/command/missions', {
    method: 'POST', headers: writer.headers, body: JSON.stringify(body)
  });
  assert.equal(repeat.status, 201);
  assert.equal((await repeat.json() as { missionId: string }).missionId, mission.missionId);
  const conflict = await fetch(host.url + 'api/command/missions', {
    method: 'POST', headers: writer.headers,
    body: JSON.stringify({ ...body, title: 'Changed contents' })
  });
  assert.equal(conflict.status, 409);

  const routeList = await fetch(host.url + 'api/command/routes', { headers: { cookie: reader.cookie } });
  assert.equal(routeList.status, 200);
  const routeListBody = await routeList.json() as { candidates: unknown[]; dispatchEnabled: boolean };
  assert.equal(routeListBody.candidates.length, 1);
  assert.equal(routeListBody.dispatchEnabled, false);
  assert.doesNotMatch(JSON.stringify(routeListBody), /abcdef1234/);
  const authUrl = host.url + 'api/command/missions/' + mission.missionId + '/route-authorization';
  const authInput = { requestId: randomUUID(), candidateId: 'offline-test|synthetic-model-a',
    ttlMinutes: 15, maxRequests: 1, maxOutputTokens: 512, maxCashMinor: 100 };
  assert.equal((await fetch(authUrl, { method: 'POST', headers: reader.headers, body: JSON.stringify(authInput) })).status, 403);
  assert.equal((await fetch(authUrl, { method: 'POST',
    headers: { ...writer.headers, 'x-daming-csrf': 'not-valid' }, body: JSON.stringify(authInput) })).status, 403);
  assert.equal((await fetch(authUrl, { method: 'POST', headers: writer.headers,
    body: JSON.stringify({ ...authInput, maxRequests: 200 }) })).status, 400);
  const grantedResponse = await fetch(authUrl, { method: 'POST', headers: writer.headers, body: JSON.stringify(authInput) });
  assert.equal(grantedResponse.status, 201);
  assert.equal((await grantedResponse.json() as { dispatchEnabled: boolean }).dispatchEnabled, false);
  const preflightUrl = host.url + 'api/command/missions/' + mission.missionId + '/route-preflight';
  const preflight = await fetch(preflightUrl, { headers: { cookie: reader.cookie } });
  assert.equal(preflight.status, 200);
  assert.equal((await preflight.json() as { accountBindingValid: boolean; dispatchPermitted: boolean }).accountBindingValid, true);
  const probeUrl = host.url + 'api/command/missions/' + mission.missionId + '/route-scope-probe';
  assert.equal((await fetch(probeUrl, { method: 'POST', headers: reader.headers, body: '{}' })).status, 403);
  assert.equal((await fetch(probeUrl, { method: 'POST', headers: writer.headers,
    body: JSON.stringify({ send: true }) })).status, 400);
  assert.equal((await fetch(probeUrl, { method: 'POST', headers: writer.headers, body: '{}' })).status, 403,
    'native confirmation denial cannot issue temporary gateway keys');
  assert.equal(consentAsked, 1);
  permitScopeProbe = true;
  const probe = await fetch(probeUrl, { method: 'POST', headers: writer.headers, body: '{}' });
  assert.equal(probe.status, 200);
  const probeData = await probe.json() as { verified: boolean; keyRevoked: boolean; dispatchPermitted: boolean };
  assert.equal(probeData.verified, true);
  assert.equal(probeData.keyRevoked, true);
  assert.equal(probeData.dispatchPermitted, false);
  assert.equal(consentAsked, 2);
  assert.equal((await fetch(probeUrl, { method: 'POST', headers: writer.headers, body: '{}' })).status, 409,
    'credential issuance is never repeated after a completed scope probe');
  assert.equal(consentAsked, 2, 'already-started probe must not create a second native approval window');

  const attemptsUrl = host.url + 'api/command/missions/' + mission.missionId + '/route-attempts';
  const attemptInput = { requestId: randomUUID(), outputTokenCeiling: 256, budgetEnvelopeMinor: 90 };
  assert.equal((await fetch(attemptsUrl, { method: 'POST', headers: reader.headers,
    body: JSON.stringify(attemptInput) })).status, 403);
  assert.equal((await fetch(attemptsUrl, { method: 'POST', headers: writer.headers,
    body: JSON.stringify({ ...attemptInput, outputTokenCeiling: 999 }) })).status, 409);
  const createAttempt = await fetch(attemptsUrl, { method: 'POST', headers: writer.headers,
    body: JSON.stringify(attemptInput) });
  assert.equal(createAttempt.status, 201);
  const attempt = await createAttempt.json() as { attemptId: string; state: string; modelRequestSent: boolean; budgetEnvelopeMinor: number };
  assert.equal(attempt.state, 'prepared');
  assert.equal(attempt.modelRequestSent, false);
  assert.equal(attempt.budgetEnvelopeMinor, 90);
  const repeatAttempt = await fetch(attemptsUrl, { method: 'POST', headers: writer.headers,
    body: JSON.stringify(attemptInput) });
  assert.equal(repeatAttempt.status, 201);
  assert.equal((await repeatAttempt.json() as { attemptId: string }).attemptId, attempt.attemptId);
  assert.equal((await fetch(attemptsUrl, { method: 'POST', headers: writer.headers,
    body: JSON.stringify({ ...attemptInput, budgetEnvelopeMinor: 91 }) })).status, 409);
  assert.equal((await fetch(attemptsUrl, { method: 'POST', headers: writer.headers,
    body: JSON.stringify({ ...attemptInput, requestId: randomUUID() }) })).status, 409);
  const cancelUrl = attemptsUrl + '/' + attempt.attemptId;
  assert.equal((await fetch(cancelUrl, { method: 'DELETE', headers: reader.headers })).status, 403);
  assert.equal((await fetch(cancelUrl, { method: 'DELETE',
    headers: { ...writer.headers, 'x-daming-csrf': 'bad' } })).status, 403);
  const cancel = await fetch(cancelUrl, { method: 'DELETE', headers: writer.headers });
  assert.equal(cancel.status, 200);
  assert.equal((await cancel.json() as { state: string }).state, 'cancelled');
  assert.equal((await fetch(cancelUrl, { method: 'DELETE', headers: writer.headers })).status, 409);
  const reallocated = await fetch(attemptsUrl, { method: 'POST', headers: writer.headers,
    body: JSON.stringify({ requestId: randomUUID(), outputTokenCeiling: 512, budgetEnvelopeMinor: 100 }) });
  assert.equal(reallocated.status, 201);
  assert.equal((await reallocated.json() as { modelRequestSent: boolean }).modelRequestSent, false);
  const revoke = await fetch(authUrl, { method: 'DELETE', headers: writer.headers });
  assert.equal(revoke.status, 200);
  assert.equal((await revoke.json() as { state: string }).state, 'revoked');
  assert.equal((await fetch(authUrl, { method: 'DELETE', headers: writer.headers })).status, 409);
  assert.equal((await fetch(attemptsUrl, { method: 'POST', headers: writer.headers,
    body: JSON.stringify({ requestId: randomUUID(), outputTokenCeiling: 1, budgetEnvelopeMinor: 1 }) })).status, 409);
  assert.equal((await fetch(probeUrl, { method: 'POST', headers: writer.headers, body: '{}' })).status, 409);
  const deniedPreflight = await fetch(preflightUrl, { headers: { cookie: reader.cookie } });
  assert.equal((await deniedPreflight.json() as { dispatchPermitted: boolean }).dispatchPermitted, false);
  const decisionUrl = host.url + 'api/command/missions/' + mission.missionId + '/decision';
  const decision = { cardId: mission.cardId, choice: 0 };
  assert.equal((await fetch(decisionUrl, { method: 'POST', headers: reader.headers,
    body: JSON.stringify(decision) })).status, 403);
  assert.equal((await fetch(decisionUrl, { method: 'POST',
    headers: { ...writer.headers, 'x-daming-csrf': 'invalid' },
    body: JSON.stringify(decision) })).status, 403);
  assert.equal((await fetch(decisionUrl, { method: 'POST', headers: writer.headers,
    body: JSON.stringify({ ...decision, cardId: mission.cardId! + 1 }) })).status, 409);

  const approved = await fetch(decisionUrl, {
    method: 'POST', headers: writer.headers, body: JSON.stringify(decision)
  });
  assert.equal(approved.status, 200);
  const final = await approved.json() as {
    missionId: string; status: string; delivery: string;
    nodes: { id: string; status: string }[]; events: { sequence: number; type: string }[]
  };
  assert.equal(final.status, 'completed');
  assert.match(final.delivery, /没有使用任何真实供应商账号/);
  assert.equal(final.nodes.find((node) => node.id === 'delivery')?.status, 'completed');
  assert.ok(final.events.some((event) => event.type === 'decision.approved'));
  assert.ok(final.events.every((item, idx, all) => idx === 0 || item.sequence > all[idx - 1].sequence));
  assert.equal((await fetch(decisionUrl, { method: 'POST', headers: writer.headers,
    body: JSON.stringify(decision) })).status, 409, 'decision cannot be replayed');
  assert.equal((await fetch(host.url + 'api/command/missions/' + mission.missionId)).status, 401);
  const listed = await fetch(host.url + 'api/command/missions', { headers: { cookie: reader.cookie } });
  assert.ok((await listed.json() as { missions: { missionId: string }[] }).missions.some((item) => item.missionId === mission.missionId));

  await host.close();
  host = await startBoardHost({
    dataDir, port: 0, webRoot, magpie: offlineMagpie,
    bootstrapToken: 'mission-test-restart-300'
  });
  writer = await login(host, host.bootstrapToken);
  const restored = await fetch(host.url + 'api/command/missions/' + mission.missionId, { headers: { cookie: writer.cookie } });
  assert.equal((await restored.json() as { status: string }).status, 'completed');
});

test('command center rejection is terminal and never launches external models', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'daming-mission-reject-'));
  mkdirSync(join(root, 'web'));
  writeFileSync(join(root, 'web', 'index.html'), '<!doctype html>');
  const host = await startBoardHost({ dataDir: join(root, 'data'), port: 0,
    webRoot: join(root, 'web'), magpie: offlineMagpie, bootstrapToken: 'mission-reject-300' });
  t.after(async () => {
    await host.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const writer = await login(host, host.bootstrapToken);
  assert.equal((await fetch(host.url + 'api/command/missions', {
    method: 'POST', headers: writer.headers,
    body: JSON.stringify({ title: 'bad', goal: 'bad', requestId: randomUUID(), mode: 'live' })
  })).status, 400);
  const create = await fetch(host.url + 'api/command/missions', {
    method: 'POST', headers: writer.headers,
    body: JSON.stringify({ title: '拒绝此演示', goal: '不执行任何外部动作', requestId: randomUUID(), mode: 'offline-demo' })
  });
  const item = await create.json() as { missionId: string; cardId: number };
  const denied = await fetch(host.url + 'api/command/missions/' + item.missionId + '/decision', {
    method: 'POST', headers: writer.headers,
    body: JSON.stringify({ cardId: item.cardId, choice: 1 })
  });
  assert.equal(denied.status, 200);
  const record = await denied.json() as { status: string; delivery: string | null; notification: { sent: boolean } };
  assert.equal(record.status, 'cancelled');
  assert.equal(record.delivery, null);
  assert.equal(record.notification.sent, false);
});
