/**
 * Magpie staged acceptance: real candidate binary, synthetic loopback provider.
 * Never install over the live executable or reuse the user's Magpie profile.
 * This is an isolated test driver, NOT a production model dispatcher.
 *
 * Run: node scripts/magpie-staging-acceptance.mjs
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer as httpServer, request as httpRequest } from 'node:http';
import { createServer as tcpServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createMagpieHost } from '../apps/server/src/magpie-host.ts';
import { MissionControl } from '../apps/server/src/mission-control.ts';

const BASE = resolve(import.meta.dirname, '..');
const CANDIDATE = join(BASE, '.cache', 'daming-magpie-scope-candidate.exe');
const OUTPUT = join(BASE, 'docs', 'verification', 'magpie-stage-acceptance-2026-11-12.json');
const SAMPLE_A = 'synthetic-test-key-A';
const SAMPLE_B = 'synthetic-test-key-B';
const SAMPLE_C = 'synthetic-test-key-other';
const SAMPLE_MODEL = 'offline-model';
const SLEEP = 120;

function jsonFile(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
}
function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }
async function localPort() {
  const listener = tcpServer();
  await new Promise((done, reject) => listener.once('error', reject).listen(0, '127.0.0.1', done));
  const port = listener.address().port;
  await new Promise(done => listener.close(done));
  return port;
}
function startHttp(server) {
  return new Promise((done, reject) => server.once('error', reject).listen(0, '127.0.0.1', () => done(server.address().port)));
}
function responseJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
async function callGateway(port, method, path, value, secret) {
  process.stderr.write('STAGE_HTTP_START=' + method + ' ' + (path.startsWith('/v1/magpie/keys/') ? '/v1/magpie/keys/:id' : path) + '\n');
  // Native Node HTTP: unlike fetch, this has no browser-only Sec-Fetch-Mode.
  // Magpie MUST continue refusing browser-originated credential issuance.
  const body = value === undefined ? null : JSON.stringify(value);
  return await new Promise((resolveResponse, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method,
      headers: { ...(secret ? { Authorization: 'Bearer ' + secret } : {}), Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}) },
      timeout: value && path === '/v1/chat/completions' ? 6000 : 12000 }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on('data', (part) => {
        bytes += part.length;
        if (bytes > 2 * 1024 * 1024) { req.destroy(new Error('response_too_large')); return; }
        chunks.push(part);
      });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        resolveResponse({ status: res.statusCode, data });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('staging_gateway_timeout')));
    req.on('error', reject);
    req.end(body ?? undefined);
  });
}
async function scopedKey(port, route, options = {}) {
  const issued = await callGateway(port, 'POST', '/v1/magpie/keys', {
    name: 'daming-staging-only', ttl: '1m', models: [route.providerId + '/' + route.modelId],
    accounts: [route.providerId + '/' + route.accountRef],
    tokens: 128, cost: 0, singleUpstream: true, ...options
  });
  assert.equal(issued.status, 201, 'short-lived key creation failed');
  const key = issued.data;
  assert.equal(key?.singleUpstream, true);
  assert.deepEqual(key?.models, [route.providerId + '/' + route.modelId]);
  assert.deepEqual(key?.accounts, [route.providerId + '/' + route.accountRef]);
  assert.match(key?.key ?? '', /^sk-magpie-key-[A-Za-z0-9_-]+$/);
  return key;
}
async function revokedKey(port, key) {
  const revoke = await callGateway(port, 'DELETE', '/v1/magpie/keys/' + key.id);
  assert.equal(revoke.status, 200, 'revocation must succeed');
  const after = await callGateway(port, 'GET', '/v1/models', undefined, key.key);
  assert.equal(after.status, 401, 'revoked key must never fall back to anonymous loopback');
}
function markSent(journal, receiptPath, attempt, caseName) {
  const record = { caseName, attemptId: attempt.attemptId, state: 'unknown_after_send',
    requestMayHaveReachedUpstream: true, usageKnown: false, noAutomaticReplay: true };
  journal.push(record);
  jsonFile(receiptPath, journal);  // durable intent BEFORE any HTTP request
  return record;
}

async function main() {
  assert.ok(existsSync(CANDIDATE), 'missing staged binary: do not substitute the installed Magpie binary');
  const tempParent = join(BASE, '.cache');
  mkdirSync(tempParent, { recursive: true });
  const temp = mkdtempSync(join(tempParent, 'magpie-stage-'));
  const config = join(temp, 'config', 'magpie');
  mkdirSync(config, { recursive: true });
  let host;
  let missions;
  let stub;
  const report = { schemaVersion: 1, date: '2026-11-12', environment: 'fresh-magpie-process-with-synthetic-loopback-only',
    installedBinaryReplaced: false, realCredentialsLoaded: false, realVendorCalls: 0,
    dispatchEnabledInDaming: false, cases: {} };
  try {
    const calls = [];
    let behavior = 'success';
    stub = httpServer((req, res) => {
      const auth = req.headers.authorization ?? '';
      const path = req.url ?? '';
      if (req.method !== 'POST' || path !== '/v1/chat/completions') {
        responseJson(res, 404, { error: { message: 'synthetic endpoint' } });
        return;
      }
      calls.push({ key: auth.replace(/^Bearer /, ''), behavior });
      req.resume();
      if (behavior === 'drop') { req.on('end', () => res.destroy()); return; }
      if (behavior === 'rate-limit') {
        responseJson(res, 429, { error: { type: 'rate_limit', message: 'synthetic rate limit' } });
        return;
      }
      responseJson(res, 200, {
        id: 'synthetic-completion', object: 'chat.completion', created: 1, model: SAMPLE_MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content: 'STAGING_OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }
      });
    });
    const mockPort = await startHttp(stub);
    const address = 'http://127.0.0.1:' + mockPort + '/v1';
    jsonFile(join(config, 'providers.json'), { providers: [
      { id: 'stage', name: 'Staging fake provider', key: SAMPLE_A,
        keys: [{ name: 'spare-forbidden', key: SAMPLE_B }],
        chat: address, models: [SAMPLE_MODEL], fallback: ['other/' + SAMPLE_MODEL], routing: 'order' },
      { id: 'other', name: 'Other fake provider', key: SAMPLE_C,
        chat: address, models: [SAMPLE_MODEL] }
    ] });
    const gatewayPort = await localPort();
    let adminPort = await localPort();
    while (gatewayPort === adminPort) adminPort = await localPort();
    host = createMagpieHost({ dataDir: temp, binary: CANDIDATE,
      port: gatewayPort, adminPort, profile: 'environment' });
    const status = await host.ensure();
    assert.equal(status.configured, true, 'isolated Magpie did not become ready: ' + (status.reason ?? 'unknown'));
    assert.equal(await host.scopeCapability(), true, 'running candidate binary lacks task-scope safeguards');
    const catalog = await host.routingCatalog();
    assert.equal(catalog.instanceId, status.instanceId);
    assert.ok(catalog.candidates.every(c => ['stage', 'other'].includes(c.providerId)));
    const selected = catalog.candidates.find(c => c.providerId === 'stage' && c.modelId === SAMPLE_MODEL && c.accountLabel === 'API Key 1');
    assert.ok(selected, 'synthetic first key not discoverable');
    assert.ok(catalog.candidates.some(c => c.providerId === 'stage' && c.accountLabel === 'API Key 2'));
    report.cases.discovery = { passed: true, syntheticProviders: 2, syntheticKeyCandidates: catalog.candidates.length };
    // Only a fresh, local, offline MissionControl database is involved.
    missions = new MissionControl(join(temp, 'missions'));
    const mission = missions.create({ title: 'STAGING_SYNTHETIC_ONLY',
      goal: 'Never dispatch a real provider', requestId: randomUUID(), mode: 'offline-demo' });
    await missions.autoloopJob({ context: { events: [{ type: 'mission.requested', subject: mission.missionId }],
      answers: [] } });
    missions.attachCard(mission.missionId, 1);
    const authorization = missions.authorizeRoute(mission.missionId, {
      requestId: randomUUID(), candidateId: selected.candidateId, ttlMinutes: 15,
      maxRequests: 3, maxOutputTokens: 32, maxCashMinor: 150
    }, catalog);
    assert.equal(authorization.dispatchEnabled, false);
    assert.equal(missions.preflightRoute(mission.missionId, catalog).accountBindingValid, true);
    assert.equal(missions.preflightRoute(mission.missionId, catalog).dispatchPermitted, false);
    const privateBinding = missions.routeBinding(mission.missionId);
    assert.ok(privateBinding);
    // Fake owner claims exist ONLY in this disposable sqlite database. They
    // cannot stand in for actual API-account ownership in production.
    const owner = { tenantId: 'synthetic-tenant', principalId: 'synthetic-user' };
    missions.bindSyntheticMissionPrincipal(mission.missionId, owner);
    missions.claimSyntheticRouteAccount(owner, privateBinding);
    const priceBasis = { source: 'synthetic_fixture', id: 'stage-quote-1',
      providerId: privateBinding.providerId, modelId: privateBinding.modelId,
      verifiedAtMs: Date.now() - 1000, expiresAtMs: Date.now() + 10 * 60 * 1000,
      inputMinorPerMillion: 10000, outputMinorPerMillion: 100000,
      maximumInputTokens: 1024, nonTokenMaximumMinor: 0 };
    report.cases.authorization = { passed: true, persisted: true,
      syntheticOwnerClaimOnly: true, noRealDispatchPermission: true };
    const receiptPath = join(temp, 'synthetic-receipt-journal.json');
    const journal = [];
    const prepare = (budgetEnvelopeMinor) => missions.prepareRouteAttempt(mission.missionId, {
      requestId: randomUUID(), outputTokenCeiling: 32, budgetEnvelopeMinor
    }, catalog);
    const chatBody = { model: 'stage/' + SAMPLE_MODEL, messages: [{ role: 'user', content: 'synthetic message' }],
      max_tokens: 32, stream: false };
    // Success path: first account only, observed upstream usage and synthetic settlement.
    const successAttempt = prepare(50);
    const successRecord = markSent(journal, receiptPath, successAttempt, 'success');
    assert.equal(missions.beginSyntheticPossibleSend(mission.missionId, successAttempt.attemptId,
      owner, catalog, priceBasis).state, 'unknown_after_send');
    let key = await scopedKey(gatewayPort, privateBinding);
    try {
      const list = await callGateway(gatewayPort, 'GET', '/v1/models', undefined, key.key);
      assert.equal(list.status, 200);
      const ids = (list.data?.data ?? []).map(row => row.id);
      assert.ok(ids.includes('stage/' + SAMPLE_MODEL));
      assert.ok(ids.every(id => id === 'stage/' + SAMPLE_MODEL), 'other model visible to pinned key');
      const deny = await callGateway(gatewayPort, 'POST', '/v1/chat/completions',
        { ...chatBody, model: 'other/' + SAMPLE_MODEL }, key.key);
      assert.equal(deny.status, 403);
      assert.equal(calls.length, 0, 'ungranted model reached mock upstream');
      const response = await callGateway(gatewayPort, 'POST', '/v1/chat/completions', chatBody, key.key);
      assert.equal(response.status, 200, 'synthetic model request did not finish');
      assert.equal(response.data?.choices?.[0]?.message?.content, 'STAGING_OK');
      assert.deepEqual(response.data?.usage, { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].key, SAMPLE_A, 'request changed account');
      // Query the *real gateway's* request ledger; a response body alone
      // cannot establish which account actually answered the call.
      let gatewayUsage = null;
      for (let i = 0; i < 12; i++) {
        const ledger = await callGateway(gatewayPort, 'GET', '/v1/magpie/usage/requests?limit=100');
        assert.equal(ledger.status, 200);
        gatewayUsage = ledger.data?.rows?.find(row =>
          row.callerKeyId === key.id && row.provider === 'stage' &&
          row.providerKeyId === privateBinding.accountRef && row.model === SAMPLE_MODEL &&
          row.in === 7 && row.out === 3);
        if (gatewayUsage) break;
        await delay(200);
      }
      assert.ok(gatewayUsage, 'gateway ledger has no usage row for the pinned synthetic account');
      report.cases.magpieUsageLedger = { passed: true, providerKeyMatched: true,
        issuedKeyMatched: true, inputTokens: 7, outputTokens: 3 };
      successRecord.state = 'settled_synthetic';
      successRecord.usageKnown = true;
      successRecord.usage = { promptTokens: 7, outputTokens: 3, totalTokens: 10 };
      successRecord.cashMinor = 0; // synthetic provider; NOT a real-world billing estimate
      jsonFile(receiptPath, journal);
      const syntheticSettlement = missions.reconcileSyntheticReceipt(
        mission.missionId, successAttempt.attemptId, owner, {
          evidenceRef: 'fixture:' + randomUUID(),
          inputTokens: 7, outputTokens: 3, cashMinor: 0
        });
      assert.equal(syntheticSettlement.state, 'settled_synthetic');
      assert.equal(syntheticSettlement.vendorInvoiceVerified, false);
      report.cases.success = { passed: true, syntheticUpstreamCalls: 1,
        usage: successRecord.usage, syntheticCashMinor: 0 };
    } finally { await revokedKey(gatewayPort, key); }
    // Rate limit path: a 429 must NOT fall back to the other key or provider.
    behavior = 'rate-limit';
    const rejectedAttempt = prepare(50);
    const rejectedRecord = markSent(journal, receiptPath, rejectedAttempt, 'rate-limit');
    assert.equal(missions.beginSyntheticPossibleSend(mission.missionId, rejectedAttempt.attemptId,
      owner, catalog, priceBasis).state, 'unknown_after_send');
    key = await scopedKey(gatewayPort, privateBinding);
    try {
      const before = calls.length;
      let result = null;
      try { result = await callGateway(gatewayPort, 'POST', '/v1/chat/completions', chatBody, key.key); }
      catch { /* transport timeout: leave receipt status unknown */ }
      if (result) assert.notEqual(result.status, 200, 'fallback unexpectedly completed');
      assert.equal(calls.length, before + 1, 'multiple upstream attempts made after rate limiting');
      assert.equal(calls.at(-1).key, SAMPLE_A);
      rejectedRecord.state = result ? 'failed_known_synthetic' : 'unknown_after_send';
      rejectedRecord.usageKnown = false;
      jsonFile(receiptPath, journal);
      report.cases.rateLimit = { passed: true, upstreamAttempts: 1,
        gatewayResponseReceived: !!result, unresolvedWithoutReceipt: !result, usedUnauthorizedAccount: false };
    } finally { await revokedKey(gatewayPort, key); }
    // Broken connection path: write unknown to disk before sending, never retry.
    behavior = 'drop';
    const uncertainAttempt = prepare(50);
    const uncertain = markSent(journal, receiptPath, uncertainAttempt, 'disconnect');
    assert.equal(missions.beginSyntheticPossibleSend(mission.missionId, uncertainAttempt.attemptId,
      owner, catalog, priceBasis).state, 'unknown_after_send');
    key = await scopedKey(gatewayPort, privateBinding);
    try {
      const before = calls.length;
      try { await callGateway(gatewayPort, 'POST', '/v1/chat/completions', chatBody, key.key); }
      catch { /* the upstream closed without a receipt */ }
      assert.equal(calls.length, before + 1, 'uncertain request was automatically replayed');
      assert.equal(calls.at(-1).key, SAMPLE_A);
    } finally { await revokedKey(gatewayPort, key); }
    assert.equal(readJson(receiptPath).find(item => item.attemptId === uncertainAttempt.attemptId)?.state, 'unknown_after_send');
    assert.throws(() => prepare(1), /route_attempt_budget_exhausted/);
    missions.close();
    missions = null;
    await delay(SLEEP);
    missions = new MissionControl(join(temp, 'missions'));
    assert.equal(missions.routeAttempts(mission.missionId).filter(a => a.modelRequestSent === 'possible').length, 3);
    assert.equal(missions.routeReceipts(mission.missionId).filter(r => r.state === 'unknown_after_send').length, 2);
    assert.equal(missions.routeReceipts(mission.missionId).filter(r => r.state === 'settled_synthetic').length, 1);
    assert.equal(missions.authorization(mission.missionId).authorizationId, authorization.authorizationId);
    assert.equal(readJson(receiptPath).find(item => item.attemptId === uncertainAttempt.attemptId)?.state, 'unknown_after_send');
    assert.throws(() => missions.cancelRouteAttempt(mission.missionId, uncertainAttempt.attemptId),
      /route_attempt_not_prepared|route_attempt_may_have_been_sent/);
    assert.throws(() => missions.beginSyntheticPossibleSend(mission.missionId,
      uncertainAttempt.attemptId, owner, catalog, priceBasis), /route_attempt_may_have_been_sent/);
    report.cases.durableMissionCashLedger = { passed: true, receipts: 3,
      syntheticSettlements: 1, unknownFrozen: 2, noPrematureCashRelease: true };
    assert.equal(calls.length, 3, 'opening the journal and Mission DB must not replay an upstream request');
    report.cases.disconnectAndRecovery = { passed: true, persistedUnknown: true,
      noAutomaticReplay: true, frozenBudgetEnvelopeMinor: 50 };
    // Restart the disposable gateway binary as well as the Mission SQLite
    // connection: nothing may replay, and a revoked key must stay revoked.
    host.stop();
    await delay(1000);
    let restarted = false;
    for (let i = 0; i < 8; i++) {
      const after = await host.ensure();
      if (after.configured) { restarted = true; break; }
      await delay(350);
    }
    assert.equal(restarted, true, 'disposable gateway failed to restart');
    assert.equal(await host.scopeCapability(), true);
    const afterRestart = await callGateway(gatewayPort, 'GET', '/v1/models', undefined, key.key);
    assert.equal(afterRestart.status, 401, 'revoked issued key became usable after gateway restart');
    assert.equal(calls.length, 3, 'gateway restart replayed an uncertain synthetic request');
    assert.equal(missions.preflightRoute(mission.missionId, await host.routingCatalog()).accountBindingValid, true);
    report.cases.gatewayRestart = { passed: true, revokedKeyStillDenied: true,
      unknownReceiptStillUnsettled: true, noReplay: true };
    report.cases.noRealAccounts = { passed: true, mockHost: '127.0.0.1', providerCount: 2,
      allObservedKeysSynthetic: calls.every(call => [SAMPLE_A, SAMPLE_B, SAMPLE_C].includes(call.key)) };
    assert.equal(report.cases.noRealAccounts.allObservedKeysSynthetic, true);
    // A status snapshot may contain user prompts or headers; never attach it.
    report.overallPassed = true;
    mkdirSync(join(BASE, 'docs', 'verification'), { recursive: true });
    jsonFile(OUTPUT, report);
    process.stdout.write('STAGING_ACCEPTANCE=' + JSON.stringify(report) + '\n');
  } finally {
    try { missions?.close(); } catch {}
    try { host?.stop(); } catch {}
    if (stub) await new Promise(resolve => stub.close(resolve));
    await delay(700);
    for (let retry = 0; retry < 10; retry++) {
      try { rmSync(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); break; }
      catch (err) { if (retry === 9) process.stderr.write('STAGING_CLEANUP_WARNING=' + err.code + '\n'); else await delay(200); }
    }
  }
}
await main().catch(error => { process.stderr.write('STAGING_ACCEPTANCE_FAILED=' + (error?.message ?? 'unknown') + '\n'); process.exitCode = 1; });
