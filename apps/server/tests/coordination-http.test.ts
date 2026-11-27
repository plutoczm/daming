import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startBoardHost } from '../src/http.ts';
import { totpCode } from '../src/totp.ts';
import type { MagpieHost } from '../src/magpie-host.ts';
import { projectMagpieUnifiedTargets } from '../src/magpie-unified-targets.ts';

const BOOT = 'coord-test-bootstrap-2026';
const PW = 'coord-test-owner-passphrase-2026';
const magpie = {
  async ensure() { return { configured: false, running: false, enabled: false, version: 'fixture', checkedAt: new Date().toISOString() }; },
  async status() { return { configured: false, running: false, enabled: false, version: 'fixture', checkedAt: new Date().toISOString() }; },
  async unifiedTargets() { return projectMagpieUnifiedTargets({ models: [{ id: 'deepseek/deepseek-flash', sub: false }, { id: 'codex/gpt-6.2-sol', sub: true }], groups: [] }); },
  async read(alias: string) {
    if (alias === 'quotas') return { alias, count: 1, labels: [], items: [{ name: 'deepseek', id: 'deepseek', kind: 'quota', status: 'ready', detail: '', remainingPercent: 42 }], checkedAt: new Date().toISOString() };
    throw new Error('offline');
  },
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
async function mfa(host: Host, principal: Auth, pw: string): Promise<string> {
  const started = await call(host, 'api/identity/mfa/begin', 'POST', { password: pw }, principal);
  assert.equal(started.status, 200, JSON.stringify(started.data));
  const secret = String(started.data.secret);
  const code = totpCode(secret, Math.floor(Date.now() / 30000));
  const done = await call(host, 'api/identity/mfa/confirm', 'POST', { code }, principal);
  assert.equal(done.status, 200, JSON.stringify(done.data));
  return secret;
}

test('统筹页 HTTP：目录/绑定/四件套/安全拒绝/重启恢复', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'daming-coordination-http-'));
  const web = join(dir, 'web'); mkdirSync(web); writeFileSync(join(web, 'index.html'), '<title>Fixture</title>');
  const dataDir = join(dir, 'data');
  let host = await startBoardHost({ dataDir, port: 0, webRoot: web, bootstrapToken: BOOT, magpie });
  t.after(async () => { try { await host.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 }); });

  // 未认证拒绝
  assert.equal((await call(host, 'api/model-binding', 'GET')).status, 401);

  // bootstrap → 建立持久身份 → 开启 MFA
  const boot = await fetch(host.url + '?token=' + BOOT, { redirect: 'manual' });
  assert.equal(boot.status, 302);
  const initialCookie = boot.headers.getSetCookie()[0].split(';')[0];
  const original = await call(host, 'api/session', 'GET', undefined, { cookie: initialCookie, csrf: '' });
  const oldSession: Auth = { cookie: initialCookie, csrf: String(original.data.csrfToken) };
  const setup = await call(host, 'api/identity/setup', 'POST', { username: 'root-owner', password: PW, tenantName: 'Tenant A' }, oldSession);
  assert.equal(setup.status, 200, JSON.stringify(setup.data));
  const auth: Auth = { cookie: setup.cookie, csrf: String(setup.data.csrfToken) };
  await mfa(host, auth, PW);

  // 统一模型目录（脱敏）
  const cat = await call(host, 'api/model-binding', 'GET', undefined, auth);
  assert.equal(cat.status, 200, JSON.stringify(cat.data));
  const models = (cat.data.catalog as { models: { modelId: string; dispatchable: boolean }[] }).models;
  assert.ok(models.some((m) => m.modelId === 'deepseek/deepseek-flash'));
  assert.deepEqual(cat.data.bindings, []);

  // 选模型绑定 Agent
  const bind = await call(host, 'api/model-binding/bind', 'POST', { agent: 'dsh', modelId: 'deepseek/deepseek-flash', scope: { kind: 'tenant' } }, auth);
  assert.equal(bind.status, 201, JSON.stringify(bind.data));
  assert.equal(bind.data.status, 'active');
  const bindingId = String(bind.data.bindingId);
  assert.equal(((await call(host, 'api/model-binding', 'GET', undefined, auth)).data.bindings as unknown[]).length, 1);

  // 安全：缺 CSRF / 跨站 Origin 拒绝
  const baseBind = { agent: 'dsh', modelId: 'deepseek/deepseek-flash', scope: { kind: 'tenant' } };
  const noCsrf = await fetch(host.url + 'api/model-binding/bind', { method: 'POST', headers: { cookie: auth.cookie, origin: new URL(host.url).origin, 'content-type': 'application/json' }, body: JSON.stringify(baseBind) });
  assert.equal(noCsrf.status, 403);
  const cross = await fetch(host.url + 'api/model-binding/bind', { method: 'POST', headers: { cookie: auth.cookie, origin: 'http://evil.example', 'content-type': 'application/json', 'x-daming-csrf': auth.csrf }, body: JSON.stringify(baseBind) });
  assert.equal(cross.status, 403);
  assert.equal((await call(host, 'api/model-binding/bind', 'POST', { ...baseBind, modelId: 'ghost/model' }, auth)).status, 409);

  // 四件套提交
  const pi = await call(host, 'api/project-input', 'POST', {
    spec: [{ id: 'goal', text: 'ship', check: { kind: 'json_equals', expected: { ok: true } } }],
    planBaseline: [{ stepId: 'build', description: 'build it' }],
    naturalLanguage: '本轮范围', projectId: 'proj-http'
  }, auth);
  assert.equal(pi.status, 201, JSON.stringify(pi.data));
  assert.equal((pi.data.frozen as { revision: number }).revision, 1);
  const latest = await call(host, 'api/project-input/latest?projectId=proj-http', 'GET', undefined, auth);
  assert.equal(latest.status, 200);
  assert.equal((latest.data.frozen as { revision: number }).revision, 1);
  // 缺 plan_baseline 拒绝
  assert.equal((await call(host, 'api/project-input', 'POST', { spec: [{ id: 'g', text: 'x' }], projectId: 'proj-bad' }, auth)).status, 400);

  // 创建 fixture 任务
  const task = await call(host, 'api/tasks', 'POST', { title: 'Coord fixture', goal: 'offline', mode: 'fixture' }, auth);
  assert.equal(task.status, 202, JSON.stringify(task.data));
  const taskId = String(task.data.taskId);

  // 重启恢复：同 dataDir 重新拉起 Host，重新登录 + MFA 后数据仍在
  await host.close();
  host = await startBoardHost({ dataDir, port: 0, webRoot: web, bootstrapToken: BOOT, magpie });
  // 持久身份会话跨 Host 重启保留：同一浏览器会话（cookie）继续可用
  const auth2: Auth = auth;
  assert.equal(((await call(host, 'api/model-binding', 'GET', undefined, auth2)).data.bindings as unknown[]).length, 1);
  assert.equal(((await call(host, 'api/project-input/latest?projectId=proj-http', 'GET', undefined, auth2)).data.frozen as { revision: number }).revision, 1);
  const tasks = await call(host, 'api/tasks', 'GET', undefined, auth2);
  assert.equal(tasks.status, 200);
  assert.ok((tasks.data.tasks as { taskId: string }[]).some((row) => row.taskId === taskId));
  void bindingId;
});
