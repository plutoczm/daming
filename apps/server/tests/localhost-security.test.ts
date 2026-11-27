import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { connect } from 'node:net';
import { startBoardHost } from '../src/http.ts';
import type { MagpieHost } from '../src/magpie-host.ts';

// HTTP security tests must never start a real Go backend or hold Windows binaries open.
const offlineMagpie = {
  async ensure() { return { enabled: false, running: false, configured: false, version: 'offline', checkedAt: new Date().toISOString() }; },
  async status() { return { enabled: false, running: false, configured: false, version: 'offline', checkedAt: new Date().toISOString() }; },
  async read() { throw new Error('offline_test_only'); },
  async post() { throw new Error('offline_test_only'); },
  stop() {}
} as unknown as MagpieHost;

const TOKEN = 'test-readwrite-token-0123456789';
const READ_ONLY_TOKEN = 'test-readonly-token-0123456789';

async function setup(t: { after(fn: () => Promise<void>): void }, token = TOKEN, readOnly = READ_ONLY_TOKEN) {
  const dir = mkdtempSync(join(tmpdir(), 'daming web host '));
  const web = join(dir, 'web');
  mkdirSync(web);
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>Mock</title><main>Mock UI</main>');
  const host = await startBoardHost({ dataDir: join(dir, 'data'), port: 0, bootstrapToken: token, readOnlyBootstrapToken: readOnly, webRoot: web, sessionTtlMs: 60_000, magpie: offlineMagpie });
  t.after(async () => { await host.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); });
  return { dir, host };
}

async function bootstrap(url: string, token: string) {
  const response = await fetch(`${url}?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  const cookies = response.headers.getSetCookie();
  assert.ok(cookies.length > 0);
  const cookie = cookies[0].split(';')[0];
  const sessionResponse = await fetch(`${url}api/session`, { headers: { cookie } });
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json() as { csrfToken: string; role: string };
  return { cookie, csrf: session.csrfToken, role: session.role };
}

function rawRequest(port: number, options: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: options.path, method: options.method ?? 'GET', headers: options.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test('HTTP Host binds loopback and requires authentication', async (t) => {
  const { host } = await setup(t);
  assert.equal(host.address, '127.0.0.1');
  const response = await fetch(`${host.url}api/tasks`);
  assert.equal(response.status, 401);
  const page = await fetch(host.url);
  assert.equal(page.status, 401);
});

test('bootstrap session supports read and read-only sessions cannot write', async (t) => {
  const { host } = await setup(t);
  const read = await bootstrap(host.url, READ_ONLY_TOKEN);
  assert.equal(read.role, 'readonly');
  const list = await fetch(`${host.url}api/tasks`, { headers: { cookie: read.cookie } });
  assert.equal(list.status, 200);
  const page = await fetch(host.url, { headers: { cookie: read.cookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Mock UI/);
  const write = await fetch(`${host.url}api/tasks`, {
    method: 'POST',
    headers: { cookie: read.cookie, origin: new URL(host.url).origin, 'x-daming-csrf': read.csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Should not exist', goal: 'read-only' })
  });
  assert.equal(write.status, 403);
  const full = await bootstrap(host.url, TOKEN);
  assert.equal(full.role, 'readwrite');
});

test('rejects cross-origin, missing CSRF, wrong Host and traversal paths', async (t) => {
  const { host } = await setup(t);
  const session = await bootstrap(host.url, TOKEN);
  const origin = new URL(host.url).origin;
  const body = JSON.stringify({ title: 'Security task', goal: 'Must not be created' });
  const baseHeaders = { cookie: session.cookie, 'content-type': 'application/json', origin, 'x-daming-csrf': session.csrf };
  const evilOrigin = await fetch(`${host.url}api/tasks`, { method: 'POST', headers: { ...baseHeaders, origin: 'https://evil.example' }, body });
  assert.equal(evilOrigin.status, 403);
  const noCsrf = await fetch(`${host.url}api/tasks`, { method: 'POST', headers: { ...baseHeaders, 'x-daming-csrf': '' }, body });
  assert.equal(noCsrf.status, 403);
  const wrongHost = await rawRequest(host.port, { method: 'GET', path: '/api/tasks', headers: { Host: 'evil.example', Cookie: session.cookie } });
  assert.equal(wrongHost.status, 403);
  const traversal = await fetch(`${host.url}%2e%2e/%2e%2e/windows/win.ini`, { headers: { cookie: session.cookie } });
  assert.notEqual(traversal.status, 200);
  const unknown = await fetch(`${host.url}api/not-a-route`, { headers: { cookie: session.cookie } });
  assert.equal(unknown.status, 404);
});

test('rejects unauthenticated SSE and WebSocket upgrades', async (t) => {
  const { host } = await setup(t);
  const events = await fetch(`${host.url}api/events`, { headers: { Accept: 'text/event-stream' } });
  assert.equal(events.status, 401);
  const response = await new Promise<string>((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: host.port });
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('error', reject);
    socket.on('close', () => resolve(data));
    socket.on('connect', () => socket.write(`GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${host.port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`));
  });
  assert.match(response, /401 Unauthorized/);
  assert.doesNotMatch(response, /101 Switching Protocols/);
});

test('creates a fixture task and restores its history after Host restart', async (t) => {
  const { dir, host } = await setup(t);
  const session = await bootstrap(host.url, TOKEN);
  const origin = new URL(host.url).origin;
  const create = await fetch(`${host.url}api/tasks`, {
    method: 'POST',
    headers: { cookie: session.cookie, origin, 'x-daming-csrf': session.csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Browser fixture task', goal: 'Complete the offline governed workflow' })
  });
  assert.equal(create.status, 202);
  const { taskId } = await create.json() as { taskId: string };
  let detail: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${host.url}api/tasks/${taskId}`, { headers: { cookie: session.cookie } });
    assert.equal(response.status, 200);
    detail = await response.json() as Record<string, unknown>;
    if (detail.status === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(detail?.status, 'completed');
  assert.equal((detail?.progress as { totalSteps: number }).totalSteps, 3);
  assert.ok((detail?.assignments as unknown[]).length >= 3);
  assert.ok((detail?.events as unknown[]).length > 0);
  assert.ok((detail?.audit as unknown[]).length > 0);
  const serialized = JSON.stringify(detail);
  for (const privateField of ['commandJson', 'capabilityId', 'preparedId', 'workspacePath']) assert.ok(!serialized.includes(privateField));
  assert.equal((detail?.budget as { heldMinor: number }).heldMinor, 0);

  await host.close();
  const restarted = await startBoardHost({ dataDir: join(dir, 'data'), port: 0, bootstrapToken: TOKEN, webRoot: join(dir, 'web'), sessionTtlMs: 60_000, magpie: offlineMagpie });
  t.after(async () => { await restarted.close(); });
  const restartedSession = await bootstrap(restarted.url, TOKEN);
  const list = await fetch(`${restarted.url}api/tasks`, { headers: { cookie: restartedSession.cookie } });
  assert.equal(list.status, 200);
  const body = await list.json() as { tasks: { taskId: string; status: string }[] };
  assert.equal(body.tasks.length, 1);
  assert.equal(body.tasks[0].taskId, taskId);
  assert.equal(body.tasks[0].status, 'completed');
  await restarted.close();
});

test('Magpie management API enforces authentication, readonly role, CSRF and allowed actions', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'daming magpie api '));
  const web = join(dir, 'web');
  mkdirSync(web);
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>Magpie test</title>');
  let writes = 0;
  const magpie = {
    async ensure() { return { enabled: true, running: true, configured: true, version: 'v1', checkedAt: new Date().toISOString() }; },
    async status() { return { enabled: true, running: true, configured: true, version: 'v1', checkedAt: new Date().toISOString() }; },
    async read(alias: string) {
      if (alias !== 'models') throw new Error('unsupported_magpie_path');
      return { alias, count: 2, labels: ['safe-model'], items: [], checkedAt: new Date().toISOString() };
    },
    async post(alias: string) {
      if (alias !== 'plugin-check') throw new Error('unsupported_magpie_path');
      writes++;
      return { action: alias, completed: true, checkedAt: new Date().toISOString() };
    },
    stop() {}
  };
  const host = await startBoardHost({
    dataDir: join(dir, 'data'), port: 0, webRoot: web,
    bootstrapToken: TOKEN, readOnlyBootstrapToken: READ_ONLY_TOKEN, magpie
  });
  t.after(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const unauth = await fetch(host.url + 'api/magpie/read/models');
  assert.equal(unauth.status, 401);
  const readOnly = await bootstrap(host.url, READ_ONLY_TOKEN);
  const read = await fetch(host.url + 'api/magpie/read/models', { headers: { cookie: readOnly.cookie } });
  assert.equal(read.status, 200);
  assert.equal((await read.json() as { count: number }).count, 2);
  const origin = new URL(host.url).origin;
  const allowedHeaders = {
    cookie: readOnly.cookie, origin, 'x-daming-csrf': readOnly.csrf, 'content-type': 'application/json'
  };
  const readonlyWrite = await fetch(host.url + 'api/magpie/operations/prepare/plugin-check', {
    method: 'POST', headers: allowedHeaders, body: '{}'
  });
  assert.equal(readonlyWrite.status, 403);
  assert.equal(writes, 0);
  const full = await bootstrap(host.url, TOKEN);
  const fullHeaders = { ...allowedHeaders, cookie: full.cookie, 'x-daming-csrf': full.csrf };
  const withoutCsrf = await fetch(host.url + 'api/magpie/operations/prepare/plugin-check', {
    method: 'POST', headers: { ...fullHeaders, 'x-daming-csrf': '' }, body: '{}'
  });
  assert.equal(withoutCsrf.status, 403);
  const crossSite = await fetch(host.url + 'api/magpie/operations/prepare/plugin-check', {
    method: 'POST', headers: { ...fullHeaders, origin: 'https://evil.example' }, body: '{}'
  });
  assert.equal(crossSite.status, 403);
  const unknownRead = await fetch(host.url + 'api/magpie/read/secrets', { headers: { cookie: full.cookie } });
  assert.equal(unknownRead.status, 404);
  const unknownAction = await fetch(host.url + 'api/magpie/operations/prepare/plugin-add', {
    method: 'POST', headers: fullHeaders, body: '{}'
  });
  assert.equal(unknownAction.status, 400);
  // The old direct write route is gone; even fully authenticated callers cannot bypass the ledger.
  const oldDirect = await fetch(host.url + 'api/magpie/action/plugin-check', {
    method: 'POST', headers: fullHeaders, body: '{}'
  });
  assert.equal(oldDirect.status, 404);
  assert.equal(writes, 0);
  const preparedResponse = await fetch(host.url + 'api/magpie/operations/prepare/plugin-check', {
    method: 'POST', headers: fullHeaders, body: '{}'
  });
  assert.equal(preparedResponse.status, 201);
  const prepared = await preparedResponse.json() as { operation: { id: string; status: string }; approvalToken: string };
  assert.equal(prepared.operation.status, 'prepared');
  const executeUrl = host.url + 'api/magpie/operations/' + prepared.operation.id + '/execute';
  const rejected = await fetch(executeUrl, {
    method: 'POST', headers: fullHeaders, body: JSON.stringify({ approvalToken: 'invalid' })
  });
  assert.equal(rejected.status, 403);
  const approved = await fetch(executeUrl, {
    method: 'POST', headers: fullHeaders, body: JSON.stringify({ approvalToken: prepared.approvalToken })
  });
  assert.equal(approved.status, 200);
  assert.equal((await approved.json() as { status: string }).status, 'succeeded');
  assert.equal(writes, 1);
  const duplicate = await fetch(executeUrl, {
    method: 'POST', headers: fullHeaders, body: JSON.stringify({ approvalToken: prepared.approvalToken })
  });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json() as { status: string }).status, 'succeeded');
  assert.equal(writes, 1);
  const journal = await fetch(host.url + 'api/magpie/operations', { headers: { cookie: readOnly.cookie } });
  assert.equal(journal.status, 200);
  const serialized = await journal.text();
  assert.doesNotMatch(serialized, /approvalToken|approval_token|session_id/);
});

test('high-risk Magpie HTTP actions require native Windows confirmation and never send on denial', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'daming magpie windows approval '));
  const web = join(dir, 'web');
  mkdirSync(web);
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>Native approval test</title>');
  let writes = 0;
  let prompts = 0;
  let permit = false;
  const magpie = {
    async ensure() { return { enabled: true, running: true, configured: true, version: 'v1', checkedAt: new Date().toISOString() }; },
    async status() { return { enabled: true, running: true, configured: true, version: 'v1', checkedAt: new Date().toISOString() }; },
    async read() { return { alias: 'plugins', count: 0, labels: [], items: [], checkedAt: new Date().toISOString() }; },
    async post(alias: string) {
      if (alias !== 'plugin-add') throw Error('unexpected_action');
      writes++;
      return { action: alias, completed: true, result: 'succeeded' as const, checkedAt: new Date().toISOString() };
    },
    stop() {}
  };
  const host = await startBoardHost({
    dataDir: join(dir, 'data'), port: 0, webRoot: web, magpie,
    bootstrapToken: TOKEN,
    confirmMagpieAction: async ({ action, expectedSid }) => {
      assert.equal(action, 'plugin-add');
      assert.match(expectedSid, /S-[0-9-]+|non_windows/);
      prompts++;
      return permit;
    }
  });
  t.after(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const session = await bootstrap(host.url, TOKEN);
  const headers = {
    cookie: session.cookie, origin: new URL(host.url).origin,
    'x-daming-csrf': session.csrf, 'content-type': 'application/json'
  };
  const prepare = async () => {
    const response = await fetch(host.url + 'api/magpie/operations/prepare/plugin-add', {
      method: 'POST', headers, body: JSON.stringify({ spec: '@trusted/plugin' })
    });
    assert.equal(response.status, 201);
    const value = await response.json() as { operation: { id: string; risk: string }; approvalToken: string };
    assert.equal(value.operation.risk, 'high');
    return value;
  };
  const execute = async (p: { operation: { id: string }; approvalToken: string }) => {
    const response = await fetch(host.url + 'api/magpie/operations/' + p.operation.id + '/execute', {
      method: 'POST', headers, body: JSON.stringify({ approvalToken: p.approvalToken })
    });
    return { status: response.status, receipt: await response.json() as { status: string } };
  };
  const first = await prepare();
  const denied = await execute(first);
  assert.equal(denied.status, 200);
  assert.equal(denied.receipt.status, 'cancelled');
  assert.equal(writes, 0);
  assert.equal(prompts, 1);
  permit = true;
  const second = await prepare();
  const accepted = await execute(second);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.receipt.status, 'succeeded');
  assert.equal(writes, 1);
  assert.equal(prompts, 2);
  const duplicate = await execute(second);
  assert.equal(duplicate.receipt.status, 'succeeded');
  assert.equal(writes, 1);
  assert.equal(prompts, 2);
});


test('authenticated SSE publishes only task invalidation hints after task creation', async (t) => {
  const { host } = await setup(t);
  const session = await bootstrap(host.url, TOKEN);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await fetch(host.url + 'api/events', {
    headers: { cookie: session.cookie, accept: 'text/event-stream' },
    signal: controller.signal
  });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = stream.body!.getReader();
  const ready = await reader.read();
  assert.equal(ready.done, false);
  assert.match(Buffer.from(ready.value).toString('utf8'), /event: ready/);
  const secretGoal = 'private-goal-not-for-event-stream';
  const created = await fetch(host.url + 'api/tasks', {
    method: 'POST',
    headers: {
      cookie: session.cookie,
      origin: new URL(host.url).origin,
      'x-daming-csrf': session.csrf,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ title: 'SSE no secrets', goal: secretGoal, mode: 'fixture' })
  });
  assert.equal(created.status, 202);
  let received = '';
  for (let i = 0; i < 6 && !received.includes('event: invalidate'); i++) {
    const read = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('missing_sse_invalidation')), 1500))
    ]);
    if (read.done) break;
    received += Buffer.from(read.value).toString('utf8');
  }
  assert.match(received, /event: invalidate/);
  assert.match(received, /"scope":"tasks"/);
  assert.doesNotMatch(received, /private-goal-not-for-event-stream|SSE no secrets|csrfToken|apiKey/);
  controller.abort();
});
