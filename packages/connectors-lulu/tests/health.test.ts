import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LuluConnector } from '../src/index.ts';
import { startFakeLulu } from './helpers.ts';

const NOW = Date.parse('2026-11-10T00:00:00Z');

test('Lulu health reports online only for a real ok response', async (t) => {
  const fake = await startFakeLulu(t, (request, response) => {
    if (request.url === '/api/health') {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/plain');
      response.end('ok');
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  const connector = new LuluConnector({ baseUrl: fake.url, now: () => NOW });
  assert.deepEqual(await connector.health(), { status: 'online', checkedAt: new Date(NOW).toISOString() });
});

test('Lulu offline, timeout and bad health bodies never become fake online', async (t) => {
  const dead = await startFakeLulu(t, (_request, response) => { response.statusCode = 200; response.end('ok'); });
  await dead.close();
  const offline = new LuluConnector({ baseUrl: dead.url, timeoutMs: 50, now: () => NOW });
  const offlineResult = await offline.health();
  assert.equal(offlineResult.status, 'unavailable');

  const delayed = await startFakeLulu(t, (_request, response) => {
    setTimeout(() => { response.statusCode = 200; response.end('ok'); }, 200);
  });
  const timedOut = new LuluConnector({ baseUrl: delayed.url, timeoutMs: 20, now: () => NOW });
  assert.deepEqual(await timedOut.health(), { status: 'unavailable', checkedAt: new Date(NOW).toISOString(), reason: 'timeout' });

  const wrongBody = await startFakeLulu(t, (_request, response) => {
    response.statusCode = 200;
    response.end('service-up');
  });
  assert.equal((await new LuluConnector({ baseUrl: wrongBody.url, now: () => NOW }).health()).reason, 'unexpected_health_body');
});

test('Lulu capabilities require an explicit session and distinguish auth failure from outage', async (t) => {
  const fake = await startFakeLulu(t, (request, response) => {
    if (request.url !== '/api/ai/system/status') { response.statusCode = 404; response.end(); return; }
    if (request.headers.cookie !== 'LULU_SESSION=valid-session') {
      response.statusCode = 401;
      response.setHeader('Content-Type', 'application/json');
      response.end('{"error":"AUTH_REQUIRED"}');
      return;
    }
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({
      databaseHealthy: true, deepSeekAvailable: false, coachPrimary: 'deepseek-flash',
      agentPrimary: 'qwen-plus', fastModel: 'qwen-turbo', memoryModel: 'local-memory',
      pgvectorEnabled: true, bailianRagEnabled: false, baiduSearchEnabled: true,
      qqBotEnabled: true, qqBotReady: false
    }));
  });

  const withoutSession = new LuluConnector({ baseUrl: fake.url, now: () => NOW });
  assert.deepEqual(await withoutSession.capabilities(), {
    status: 'unauthorized', checkedAt: new Date(NOW).toISOString(), reason: 'session_cookie_missing'
  });
  assert.equal(fake.requests.length, 0);

  const rejected = new LuluConnector({ baseUrl: fake.url, sessionCookie: 'wrong-session', now: () => NOW });
  assert.equal((await rejected.capabilities()).status, 'unauthorized');

  const available = new LuluConnector({ baseUrl: fake.url, sessionCookie: 'valid-session', now: () => NOW });
  const capabilities = await available.capabilities();
  assert.equal(capabilities.status, 'available');
  assert.equal(capabilities.databaseHealthy, true);
  assert.equal(capabilities.deepSeekAvailable, false);
  assert.equal(capabilities.coachPrimary, 'deepseek-flash');
  assert.equal(capabilities.qqBotReady, false);
});

test('Lulu base URLs are restricted to a loopback API context', () => {
  for (const url of ['http://10.0.0.5:8123/api', 'http://127.0.0.1:8123', 'http://user:pass@127.0.0.1:8123/api', 'https://example.com/api']) {
    assert.throws(() => new LuluConnector({ baseUrl: url }), /Lulu base URL/);
  }
});
