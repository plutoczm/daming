import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionContext, WorkerResult, WorkerSession } from '@daming/workers';
import type { MagpieHost } from '../src/magpie-host.ts';
import { startBoardHost } from '../src/http.ts';

class OfflineModel implements WorkerSession {
  private readonly contexts = new Map<string, SessionContext>();
  calls = 0;
  constructor(privateResult: string) { this.result = privateResult; }
  private readonly result: string;
  createSession(context: SessionContext): void { this.contexts.set(context.sessionId, context); }
  async run(sessionId: string): Promise<WorkerResult> {
    const state = this.contexts.get(sessionId)!;
    this.calls++;
    return {
      mode: 'real', sessionId, taskId: state.taskId, runId: state.runId,
      attemptId: state.attemptId, status: 'completed', output: this.result,
      events: [], usage: { inputTokens: 0, outputTokens: 0 }
    };
  }
  cancel(): void {}
}
const magpie = {
  async ensure() { return { enabled: false, running: false, configured: false, version: 'offline', checkedAt: new Date().toISOString() }; },
  async status() { return { enabled: false, running: false, configured: false, version: 'offline', checkedAt: new Date().toISOString() }; },
  async read() { throw new Error('offline_only'); },
  async post() { throw new Error('offline_only'); },
  stop() {}
} as unknown as MagpieHost;

async function login(base: string, token: string) {
  const landing = await fetch(base + '?token=' + token, { redirect: 'manual' });
  assert.equal(landing.status, 302);
  const cookie = landing.headers.getSetCookie()[0].split(';')[0];
  const session = await fetch(base + 'api/session', { headers: { cookie } });
  assert.equal(session.status, 200);
  const data = await session.json() as { csrfToken: string };
  return {
    cookie, headers: { cookie, origin: new URL(base).origin, 'content-type': 'application/json',
      'x-daming-csrf': data.csrfToken }
  };
}

test('HTTP project preview: manually approved two-agent workflow writes only copy and exposes verified diff', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'daming-project-http-'));
  const src = join(temp, 'source');
  mkdirSync(join(src, 'src'), { recursive: true });
  writeFileSync(join(src, 'src', 'sample.ts'), 'const answer = 1;\n');
  const webRoot = join(temp, 'web');
  mkdirSync(webRoot);
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Offline host</title>');
  const root = join(temp, 'host');
  const codex = new OfflineModel(JSON.stringify({ path: 'src/sample.ts', find: 'answer = 1', replace: 'answer = 2' }));
  const dsh = new OfflineModel(JSON.stringify({ approved: true, reason: 'Reviewed copy only' }));
  let host = await startBoardHost({
    dataDir: root, port: 0, webRoot, magpie, bootstrapToken: 'offline-project-owner-token-123',
    readOnlyBootstrapToken: 'offline-project-reader-token-987',
    projectPreviewTest: { sourceRoot: src, mockWorkers: { codex, dsh } }
  });
  t.after(async () => {
    await host.close();
    rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  let admin = await login(host.url, host.bootstrapToken);
  const reader = await login(host.url, host.readOnlyBootstrapToken!);

  const status = await fetch(host.url + 'api/project/status', { headers: { cookie: reader.cookie } });
  assert.equal(status.status, 200);
  assert.deepEqual((await status.json() as { enabled: boolean; readonlyModels: boolean; mergeEnabled: boolean }),
    { enabled: true, readonlyModels: true, mergeEnabled: false, reason: 'offline_test_double' });

  const create = await fetch(host.url + 'api/tasks', {
    method: 'POST', headers: admin.headers,
    body: JSON.stringify({
      title: 'Preview diff', goal: 'Change the test source in the copied workspace',
      filePaths: ['src/sample.ts'], mode: 'project', limitMinor: 200
    })
  });
  assert.equal(create.status, 202);
  const { taskId } = await create.json() as { taskId: string };
  assert.equal(existsSync(join(root, 'project-previews', taskId)), false);
  assert.equal(codex.calls, 0);
  const before = await fetch(host.url + 'api/tasks/' + taskId + '/project-preview', { headers: { cookie: admin.cookie } });
  assert.equal(before.status, 409);
  const denied = await fetch(host.url + 'api/tasks/' + taskId + '/approve', { method: 'POST', headers: reader.headers });
  assert.equal(denied.status, 403);
  assert.equal(codex.calls, 0);
  assert.equal((await fetch(host.url + 'api/tasks/' + taskId + '/approve', {
    method: 'POST', headers: admin.headers
  })).status, 200);

  let state = 'running';
  for (let i = 0; i < 100; i++) {
    const result = await fetch(host.url + 'api/tasks/' + taskId, { headers: { cookie: reader.cookie } });
    const detail = await result.json() as { status: string };
    state = detail.status;
    if (state === 'completed' || state === 'blocked') break;
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.equal(state, 'completed');
  assert.equal(codex.calls, 1);
  assert.equal(dsh.calls, 1);

  const diff = await fetch(host.url + 'api/tasks/' + taskId + '/project-preview', { headers: { cookie: reader.cookie } });
  assert.equal(diff.status, 200);
  const preview = await diff.json() as {
    filename: string; before: string; after: string;
    originalUnchanged: boolean; mergeEnabled: boolean; reviewerNote: string;
  };
  assert.equal(preview.filename, 'src/sample.ts');
  assert.equal(preview.before, 'const answer = 1;\n');
  assert.equal(preview.after, 'const answer = 2;\n');
  assert.equal(preview.originalUnchanged, true);
  assert.equal(preview.mergeEnabled, false);
  assert.equal(readFileSync(join(src, 'src', 'sample.ts'), 'utf8'), 'const answer = 1;\n');
  assert.equal((await fetch(host.url + 'api/tasks/' + taskId + '/project-preview')).status, 401);
  assert.equal((await fetch(host.url + 'api/tasks/' + taskId + '/project-merge', {
    method: 'POST', headers: admin.headers
  })).status, 404, 'There must be no merge endpoint');

  await host.close();
  host = await startBoardHost({
    dataDir: root, port: 0, webRoot, magpie, bootstrapToken: 'offline-project-restart-token-xyz',
    projectPreviewTest: { sourceRoot: src, mockWorkers: { codex, dsh } }
  });
  admin = await login(host.url, host.bootstrapToken);
  const again = await fetch(host.url + 'api/tasks/' + taskId + '/project-preview', { headers: { cookie: admin.cookie } });
  assert.equal(again.status, 200);
  assert.equal((await again.json() as { after: string }).after, preview.after);
  writeFileSync(join(src, 'src', 'sample.ts'), 'const answer = 15;\n');
  const altered = await fetch(host.url + 'api/tasks/' + taskId + '/project-preview', { headers: { cookie: admin.cookie } });
  assert.equal(altered.status, 200);
  assert.equal((await altered.json() as { originalUnchanged: boolean }).originalUnchanged, false);
});

test('project preview requires explicit Host configuration and strictly validated files', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'daming-project-no-config-'));
  const webRoot = join(temp, 'web');
  mkdirSync(webRoot);
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html>');
  const host = await startBoardHost({ dataDir: join(temp, 'host'), port: 0, webRoot, magpie,
    bootstrapToken: 'offline-project-absent-token-123' });
  t.after(async () => {
    await host.close();
    rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const session = await login(host.url, host.bootstrapToken);
  const status = await fetch(host.url + 'api/project/status', { headers: { cookie: session.cookie } });
  assert.equal((await status.json() as { enabled: boolean }).enabled, false);
  const priceResponse = await fetch(host.url + 'api/project/pricing', { headers: { cookie: session.cookie } });
  assert.equal(priceResponse.status, 200);
  const price = await priceResponse.json() as {
    currency: string; peak: { flashInputMissMinorPerMillion: number; proOutputMinorPerMillion: number;
      searchOrFetchMinorPerThousand: number }; pricingIsHardSpendingCap: boolean; modelExecutionIsolated: boolean;
  };
  assert.equal(price.currency, 'CNY');
  assert.equal(price.peak.flashInputMissMinorPerMillion, 200);
  assert.equal(price.peak.proOutputMinorPerMillion, 2700);
  assert.equal(price.peak.searchOrFetchMinorPerThousand, 500);
  assert.equal(price.pricingIsHardSpendingCap, false);
  assert.equal(price.modelExecutionIsolated, false);
  assert.equal((await fetch(host.url + 'api/project/pricing')).status, 401);
  const create = await fetch(host.url + 'api/tasks', {
    method: 'POST', headers: session.headers,
    body: JSON.stringify({ title: 'Unavailable', goal: 'Will not run', mode: 'project',
      filePaths: ['src/sample.ts'] })
  });
  assert.equal(create.status, 503);
  assert.equal((await create.json() as { reason: string }).reason, 'project_preview_not_configured');
  const unsupported = await fetch(host.url + 'api/tasks', {
    method: 'POST', headers: session.headers,
    body: JSON.stringify({ title: 'Bad mode', goal: 'Fail', mode: 'dangerously-bypass' })
  });
  assert.equal(unsupported.status, 400);
});

test('environment opt-in cannot bypass missing isolated Windows model launcher', async (t) => {
  const original = process.env.DAMING_ENABLE_PROJECT_AGENTS;
  process.env.DAMING_ENABLE_PROJECT_AGENTS = '1';
  const temp = mkdtempSync(join(tmpdir(), 'daming-project-isolation-gate-'));
  const webRoot = join(temp, 'web');
  mkdirSync(webRoot);
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html>');
  let host: Awaited<ReturnType<typeof startBoardHost>> | undefined;
  t.after(async () => {
    if (original === undefined) delete process.env.DAMING_ENABLE_PROJECT_AGENTS;
    else process.env.DAMING_ENABLE_PROJECT_AGENTS = original;
    if (host) await host.close();
    rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  host = await startBoardHost({
    dataDir: join(temp, 'data'), port: 0, webRoot, magpie,
    bootstrapToken: 'offline-project-isolation-gate-test-123'
  });
  const session = await login(host.url, host.bootstrapToken);
  const status = await fetch(host.url + 'api/project/status', { headers: { cookie: session.cookie } });
  assert.equal(status.status, 200);
  const body = await status.json() as { enabled: boolean; reason: string; mergeEnabled: boolean };
  assert.equal(body.enabled, false);
  assert.equal(body.mergeEnabled, false);
  assert.equal(body.reason, 'isolated_model_cli_not_integrated');
  const attempt = await fetch(host.url + 'api/tasks', {
    method: 'POST', headers: session.headers,
    body: JSON.stringify({
      title: 'Explicit flag is insufficient', goal: 'Do not run Windows CLI',
      filePaths: ['src/example.ts'], mode: 'project'
    })
  });
  assert.equal(attempt.status, 503);
});
