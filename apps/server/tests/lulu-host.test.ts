import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBoardHost } from '../src/http.ts';
import type { LuluStatusView } from '@daming/contracts';
import type { LuluService } from '../src/lulu-service.ts';
import type { MagpieHost } from '../src/magpie-host.ts';
const offlineMagpie = {
  async ensure() { return { enabled: false, running: false, configured: false, version: 'offline', checkedAt: new Date().toISOString() }; },
  async status() { return { enabled: false, running: false, configured: false, version: 'offline', checkedAt: new Date().toISOString() }; },
  async read() { throw new Error('offline_test_only'); },
  async post() { throw new Error('offline_test_only'); },
  stop() {}
} as unknown as MagpieHost;

const TOKEN = 'lulu-host-test-token-0123456789';
const STATUS: LuluStatusView = {
  enabled: true, health: 'online', capabilities: 'available',
  checkedAt: '2026-11-10T05:00:00.000Z',
  coachPrimary: 'workbuddy/deepseek-v4.1-flash',
  agentPrimary: 'workbuddy/deepseek-v4.1-flash',
  fastModel: 'workbuddy/deepseek-v4.1-flash',
  memoryModel: 'qwen3:8b'
};

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'daming lulu host '));
  const web = join(dir, 'web');
  mkdirSync(web);
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>Mock</title>');
  const host = await startBoardHost({
    dataDir: join(dir, 'data'), port: 0, bootstrapToken: TOKEN, webRoot: web, sessionTtlMs: 60_000,
    lulu: { status: async () => STATUS }, magpie: offlineMagpie
  });
  t.after(async () => { await host.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 120 }); });
  return host;
}

async function bootstrap(url: string) {
  const response = await fetch(`${url}?token=${encodeURIComponent(TOKEN)}`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  const cookie = response.headers.getSetCookie().map((value) => value.split(';')[0]).find((value) => value.startsWith('daming_session='));
  assert.ok(cookie);
  return cookie;
}

async function setupService(t: { after(fn: () => Promise<void>): void }, service: LuluService) {
  const dir = mkdtempSync(join(tmpdir(), 'daming lulu submit host '));
  const web = join(dir, 'web');
  mkdirSync(web);
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>Mock</title>');
  const host = await startBoardHost({
    dataDir: join(dir, 'data'), port: 0, bootstrapToken: TOKEN, webRoot: web, sessionTtlMs: 60_000,
    luluService: service, magpie: offlineMagpie
  });
  t.after(async () => { await host.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 120 }); });
  return host;
}

const SUBMIT_SERVICE: LuluService = {
  enabled: true,
  status: async () => STATUS,
  submit: async (input) => ({ status: 'completed', runId: 'run-1', evidence: { bestReply: '有空呀', echo: input.message } }),
  run: (runId) => runId === 'run-1' ? { runId: 'run-1', status: 'completed', evidence: { bestReply: '有空呀' }, completedAt: '2026-11-11T06:00:00.000Z' } : undefined
};

test('Host exposes authenticated read-only Lulu status without credentials', async (t) => {
  const host = await setup(t);
  const unauthorized = await fetch(`${host.url}api/lulu/status`);
  assert.equal(unauthorized.status, 401);
  const cookie = await bootstrap(host.url);
  const response = await fetch(`${host.url}api/lulu/status`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const body = await response.json() as LuluStatusView;
  assert.deepEqual(body, STATUS);
  const serialized = JSON.stringify(body);
  for (const secret of ['LULU_SESSION', 'cookie', 'approvalSecret', 'session']) assert.ok(!serialized.includes(secret));
});

test('Host submit endpoint requires CSRF and returns persisted Lulu evidence', async (t) => {
  const host = await setupService(t, SUBMIT_SERVICE);
  const cookie = await bootstrap(host.url);
  const origin = host.url.slice(0, -1);
  const sessionResponse = await fetch(`${host.url}api/session`, { headers: { cookie } });
  const session = await sessionResponse.json() as { csrfToken: string };
  const body = JSON.stringify({ platform: 'wechat', conversationId: 'local-demo', message: '周末有空吗？' });
  const denied = await fetch(`${host.url}api/lulu/submit`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json', Origin: origin }, body });
  assert.equal(denied.status, 403);
  const submitted = await fetch(`${host.url}api/lulu/submit`, {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/json', Origin: origin, 'X-Daming-CSRF': session.csrfToken },
    body
  });
  assert.equal(submitted.status, 200);
  const result = await submitted.json() as { status: string; runId: string; evidence: { bestReply: string } };
  assert.equal(result.status, 'completed');
  assert.equal(result.runId, 'run-1');
  assert.equal(result.evidence.bestReply, '有空呀');
  const run = await fetch(`${host.url}api/lulu/runs/run-1`, { headers: { cookie } });
  assert.equal(run.status, 200);
  assert.equal((await run.json() as { completedAt: string }).completedAt, '2026-11-11T06:00:00.000Z');
});
