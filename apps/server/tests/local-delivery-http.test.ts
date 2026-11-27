import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBoardHost } from '../src/http.ts';
import type { MagpieHost } from '../src/magpie-host.ts';
import type { BoardHostHandle } from '../src/http.ts';

const fakeMagpie = {
  async ensure() { return { enabled: false, running: false, configured: false, version: 'offline', checkedAt: new Date().toISOString() }; },
  async status() { return { enabled: false, running: false, configured: false, version: 'offline', checkedAt: new Date().toISOString() }; },
  async read() { throw new Error('offline_test_only'); },
  async post() { throw new Error('offline_test_only'); },
  stop() {}
} as unknown as MagpieHost;

async function session(host: BoardHostHandle, token: string) {
  const response = await fetch(host.url + '?token=' + token, { redirect: 'manual' });
  assert.equal(response.status, 302);
  const cookie = response.headers.getSetCookie()[0]?.split(';')[0];
  assert.ok(cookie);
  const sessionResponse = await fetch(host.url + 'api/session', { headers: { cookie } });
  assert.equal(sessionResponse.status, 200);
  const profile = await sessionResponse.json() as { csrfToken: string };
  return {
    cookie,
    headers: {
      cookie, origin: new URL(host.url).origin, 'content-type': 'application/json',
      'x-daming-csrf': profile.csrfToken
    }
  };
}

test('authenticated HTTP local task: approval -> four real file writes -> audit -> safe delivery -> restart', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'daming-local-http-'));
  const webRoot = join(temp, 'web');
  mkdirSync(webRoot);
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Test</title>');
  const dataDir = join(temp, 'host');
  let host = await startBoardHost({
    dataDir, port: 0, webRoot, magpie: fakeMagpie,
    bootstrapToken: 'offline-local-test-write-token-123',
    readOnlyBootstrapToken: 'offline-local-test-read-token-456'
  });
  t.after(async () => {
    await host.close();
    rmSync(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
  });
  const admin = await session(host, host.bootstrapToken);
  const reader = await session(host, host.readOnlyBootstrapToken!);
  const goal = '离线报告：不访问网络、不执行 shell，真实写入后接受独立审核。';
  const created = await fetch(host.url + 'api/tasks', {
    method: 'POST', headers: admin.headers,
    body: JSON.stringify({ title: '可验收的本地报告', goal, mode: 'local', limitMinor: 1 })
  });
  assert.equal(created.status, 202);
  const { taskId } = await created.json() as { taskId: string };
  const early = await fetch(host.url + 'api/tasks/' + taskId + '/delivery', { headers: { cookie: admin.cookie } });
  assert.equal(early.status, 409);
  const reportPath = join(dataDir, 'local-deliveries', taskId, 'report.md');
  assert.equal(await import('node:fs').then((fs) => fs.existsSync(reportPath)), false);
  const denied = await fetch(host.url + 'api/tasks/' + taskId + '/approve', { method: 'POST', headers: reader.headers });
  assert.equal(denied.status, 403);
  assert.equal(await import('node:fs').then((fs) => fs.existsSync(reportPath)), false);
  const approved = await fetch(host.url + 'api/tasks/' + taskId + '/approve', { method: 'POST', headers: admin.headers });
  assert.equal(approved.status, 200);

  let detail: { status: string; budget?: { spentMinor: number; heldMinor: number }; progress: { completedSteps: number } } | undefined;
  for (let attempt = 0; attempt < 120; attempt++) {
    const response = await fetch(host.url + 'api/tasks/' + taskId, { headers: { cookie: reader.cookie } });
    detail = await response.json() as typeof detail;
    if (detail?.status === 'completed') break;
    await new Promise((done) => setTimeout(done, 30));
  }
  assert.equal(detail?.status, 'completed');
  assert.equal(detail.progress.completedSteps, 4);
  assert.equal(detail.budget?.spentMinor, 0);
  assert.equal(detail.budget?.heldMinor, 0);

  const delivered = await fetch(host.url + 'api/tasks/' + taskId + '/delivery', { headers: { cookie: reader.cookie } });
  assert.equal(delivered.status, 200);
  const artifact = await delivered.json() as { filename: string; content: string; verified: boolean };
  assert.equal(artifact.filename, 'report.md');
  assert.equal(artifact.verified, true);
  assert.match(artifact.content, /可核验|离线报告/);
  assert.equal(readFileSync(reportPath, 'utf8'), artifact.content);

  await host.close();
  host = await startBoardHost({
    dataDir, port: 0, webRoot, magpie: fakeMagpie,
    bootstrapToken: 'offline-local-restart-token-xyz'
  });
  const reopened = await session(host, host.bootstrapToken);
  const persistent = await fetch(host.url + 'api/tasks/' + taskId + '/delivery', { headers: { cookie: reopened.cookie } });
  assert.equal(persistent.status, 200);
  assert.equal((await persistent.json() as { content: string }).content, artifact.content);

  writeFileSync(reportPath, 'tampered');
  const tampered = await fetch(host.url + 'api/tasks/' + taskId + '/delivery', { headers: { cookie: reopened.cookie } });
  assert.equal(tampered.status, 409);
  const failure = await tampered.json() as { reason: string };
  assert.equal(failure.reason, 'local_delivery_integrity_failed');
  assert.equal((await fetch(host.url + 'api/tasks/missing/delivery', { headers: { cookie: reopened.cookie } })).status, 404);
  assert.equal((await fetch(host.url + 'api/tasks/' + taskId + '/delivery')).status, 401);
});
