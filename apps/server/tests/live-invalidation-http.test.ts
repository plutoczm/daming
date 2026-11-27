import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startBoardHost } from '../src/http.ts';
import { totpCode } from '../src/totp.ts';
import type { MagpieHost } from '../src/magpie-host.ts';
import { projectMagpieUnifiedTargets } from '../src/magpie-unified-targets.ts';

const BOOT = 'live-invalidation-bootstrap-2026';
const PW = 'live-invalidation-owner-passphrase-2026';
const magpie = {
  async ensure() { return { configured: false, running: false, enabled: false, version: 'fixture', checkedAt: new Date().toISOString() }; },
  async status() { return { configured: false, running: false, enabled: false, version: 'fixture', checkedAt: new Date().toISOString() }; },
  async unifiedTargets() { return projectMagpieUnifiedTargets({ models: [{ id: 'deepseek/deepseek-flash', sub: false }], groups: [] }); },
  async read() { throw new Error('offline'); },
  async post() { throw new Error('offline'); },
  stop() {}
} as unknown as MagpieHost;

type Auth = { cookie: string; csrf: string };
type Host = Awaited<ReturnType<typeof startBoardHost>>;

async function call(host: Host, path: string, method = 'GET', body?: unknown, auth?: Auth) {
  const response = await fetch(host.url + path, {
    method,
    headers: {
      ...(auth ? { cookie: auth.cookie } : {}),
      ...(method !== 'GET' ? { origin: new URL(host.url).origin, 'content-type': 'application/json', ...(auth ? { 'x-daming-csrf': auth.csrf } : {}) } : {})
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    redirect: 'manual'
  });
  let data: Record<string, unknown> = {};
  try { data = await response.json() as Record<string, unknown>; } catch { /* empty */ }
  return { status: response.status, data, cookie: response.headers.getSetCookie()[0]?.split(';')[0] ?? '' };
}

async function signIn(host: Host): Promise<Auth> {
  const boot = await fetch(host.url + '?token=' + BOOT, { redirect: 'manual' });
  const initialCookie = boot.headers.getSetCookie()[0]!.split(';')[0]!;
  const original = await call(host, 'api/session', 'GET', undefined, { cookie: initialCookie, csrf: '' });
  const setup = await call(host, 'api/identity/setup', 'POST', { username: 'root-owner', password: PW, tenantName: 'Tenant Live' },
    { cookie: initialCookie, csrf: String(original.data.csrfToken) });
  assert.equal(setup.status, 200, JSON.stringify(setup.data));
  const auth: Auth = { cookie: setup.cookie, csrf: String(setup.data.csrfToken) };
  const started = await call(host, 'api/identity/mfa/begin', 'POST', { password: PW }, auth);
  assert.equal(started.status, 200, JSON.stringify(started.data));
  const code = totpCode(String(started.data.secret), Math.floor(Date.now() / 30000));
  const done = await call(host, 'api/identity/mfa/confirm', 'POST', { code }, auth);
  assert.equal(done.status, 200, JSON.stringify(done.data));
  return auth;
}

// One disposable Host covers both the invalidation contract and the read-only
// execution graph endpoint, so the suite does not pay for two identity bootstraps.
test('Host publishes after commit and serves a persisted execution graph', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'daming-live-events-http-'));
  const web = join(dir, 'web'); mkdirSync(web); writeFileSync(join(web, 'index.html'), '<title>Fixture</title>');
  const host = await startBoardHost({ dataDir: join(dir, 'data'), port: 0, webRoot: web, bootstrapToken: BOOT, magpie });
  t.after(async () => {
    try { await host.close(); } catch { /* closed */ }
    rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  });
  const auth = await signIn(host);

  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await fetch(host.url + 'api/events', {
    headers: { accept: 'text/event-stream', cookie: auth.cookie },
    signal: controller.signal
  });
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const readFrame = async (predicate: (frame: { id?: string; event?: string; data?: Record<string, unknown> }) => boolean, timeoutMs = 4000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = buffer.indexOf('\n\n');
      if (index >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const frame: { id?: string; event?: string; data?: Record<string, unknown> } = {};
        for (const line of block.split('\n')) {
          if (line.startsWith('id: ')) frame.id = line.slice(4);
          else if (line.startsWith('event: ')) frame.event = line.slice(7);
          else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6)) as Record<string, unknown>;
        }
        if (predicate(frame)) return frame;
        continue;
      }
      if (Date.now() > deadline) throw new Error('timed out waiting for SSE frame');
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SSE read timeout')), Math.max(1, deadline - Date.now())))
      ]);
      if (chunk.done) throw new Error('event stream closed');
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };

  const ready = await readFrame((frame) => frame.event === 'ready');
  assert.equal(typeof ready.data?.seq, 'number');

  const created = await call(host, 'api/platform/providers', 'POST', {
    id: 'live-provider', api: 'openai-completions', baseUrl: 'https://example.invalid', models: ['model-a']
  }, auth);
  assert.equal(created.status, 201, JSON.stringify(created.data));

  const frame = await readFrame((candidate) => candidate.event === 'invalidate');
  assert.equal(frame.data?.scope, 'providers');
  assert.equal(frame.data?.resource, 'provider');
  assert.equal(frame.data?.revision, 1);
  assert.equal(Number(frame.id), Number(frame.data?.seq));
  // The same commit also invalidates the platform status page (multi-scope publish).
  const platformFrame = await readFrame((candidate) => candidate.event === 'invalidate' && candidate.data?.scope === 'platform');
  assert.ok(Number(platformFrame.data?.seq) > Number(frame.data?.seq));
  // The frame must describe state that is already readable from storage.
  const catalog = await call(host, 'api/platform/catalog', 'GET', undefined, auth);
  assert.ok((catalog.data.providers as { id: string }[]).some((provider) => provider.id === 'live-provider'));

  // A per-resource hint uses the same envelope.
  const agent = await call(host, 'api/platform/agents', 'POST', { agentId: 'live-agent', name: '实时 Agent', runtime: 'dsh' }, auth);
  assert.equal(agent.status, 201, JSON.stringify(agent.data));
  const agentFrame = await readFrame((candidate) => candidate.event === 'invalidate' && candidate.data?.scope === 'agents');
  assert.equal(agentFrame.data?.revision, 1);
  assert.ok(Number(agentFrame.data?.seq) > Number(platformFrame.data?.seq), 'sequence keeps growing');

  // Read-only execution graph: persisted nodes, honest coverage, stable event IDs.
  const task = await call(host, 'api/tasks', 'POST', { title: '图验收', goal: '验证执行图', mode: 'fixture' }, auth);
  assert.ok(task.status === 202 || task.status === 201, JSON.stringify(task.data));
  const taskId = String(task.data.taskId);

  const graph = await call(host, `api/tasks/${taskId}/execution-graph`, 'GET', undefined, auth);
  assert.equal(graph.status, 200, JSON.stringify(graph.data));
  const nodes = graph.data.nodes as { nodeId: string; kind: string }[];
  assert.ok(nodes.some((node) => node.nodeId === 'goal'));
  assert.ok(nodes.some((node) => node.nodeId === 'orchestrator'));
  const coverage = graph.data.coverage as { modelRequests: string; usage: string };
  assert.equal(coverage.modelRequests, 'not_recorded');
  assert.equal(coverage.usage, 'not_recorded');
  const events = graph.data.events as { eventId: string; source: string }[];
  assert.ok(events.some((event) => event.source === 'task' && event.eventId.startsWith('task:' + taskId + ':')));
  assert.ok(events.every((event) => event.source !== 'task' || event.eventId.startsWith('task:' + taskId + ':')), 'task rows keep the Host event id');
  assert.ok(events.every((event) => event.source === 'task' || event.source === 'assignment' || event.source === 'review' || event.source === 'crew'));
  assert.equal(new Set(events.map((event) => event.eventId)).size, events.length);
  assert.equal(graph.data.crew, null, 'a plain task is not part of a crew plan');

  const missing = await call(host, 'api/tasks/does-not-exist/execution-graph', 'GET', undefined, auth);
  assert.equal(missing.status, 404);
});