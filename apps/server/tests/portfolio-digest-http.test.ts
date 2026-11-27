import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startBoardHost } from '../src/http.ts';
import { ProjectInputStore } from '../src/project-input.ts';
import { projectInputToPortfolioView } from '../src/portfolio-projects.ts';
import { totpCode } from '../src/totp.ts';
import type { PortfolioDigestView } from '@daming/contracts';

const T0 = Date.parse('2026-11-21T00:00:00Z');

test('adapter: conflicts → 契约升级, blocked → 阻塞, doing 停滞 → 异常', () => {
  const dir = mkdtempSync(join(tmpdir(), 'daming portfolio adapter '));
  try {
    const store = new ProjectInputStore(join(dir, 'pi'), () => T0);
    store.submitProject({ ownerId: 'owner', spec: [{ id: 's1', text: '必须满足 A' }],
      planBaseline: [{ stepId: 'p1', description: '做 A' }], projectId: 'proj-ok' });
    const ok = projectInputToPortfolioView({ projectId: 'proj-ok', frozen: store.latest('proj-ok')!, progress: undefined, now: T0 });
    assert.equal(ok.pendingDecisions.length, 0);
    assert.equal(ok.blockers.length, 0);
    assert.equal(ok.stalledMinutes, 0);

    store.submitProject({ ownerId: 'owner', spec: [{ id: 's2', text: '必须满足 B' }],
      planBaseline: [{ stepId: 'p2', description: '跳过 B', waives: ['s2'] }], projectId: 'proj-conflict' });
    const conflict = projectInputToPortfolioView({ projectId: 'proj-conflict', frozen: store.latest('proj-conflict')!, progress: undefined, now: T0 });
    assert.equal(conflict.pendingDecisions.some((decision) => decision.kind === 'proposal'), true);

    store.writeProgress({ projectId: 'proj-ok', stage: 'S1', status: 'blocked', record: '等切图' });
    const blocked = projectInputToPortfolioView({ projectId: 'proj-ok', frozen: store.latest('proj-ok')!, progress: store.getProgress('proj-ok'), now: T0 });
    assert.equal(blocked.blockers.length, 1);

    store.writeProgress({ projectId: 'proj-ok', stage: 'S1', status: 'doing', record: '进行中' });
    const stalled = projectInputToPortfolioView({ projectId: 'proj-ok', frozen: store.latest('proj-ok')!, progress: store.getProgress('proj-ok'), now: T0 + 45 * 60000 });
    assert.ok(stalled.stalledMinutes >= 30);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  }
});

const BOOT = 'portfolio-digest-bootstrap-2026';
const PW = 'portfolio-digest-owner-passphrase-2026';
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
async function mfa(host: Host, principal: Auth, pw: string) {
  const started = await call(host, 'api/identity/mfa/begin', 'POST', { password: pw }, principal);
  assert.equal(started.status, 200, JSON.stringify(started.data));
  const code = totpCode(String(started.data.secret), Math.floor(Date.now() / 30000));
  assert.equal((await call(host, 'api/identity/mfa/confirm', 'POST', { code }, principal)).status, 200);
}

test('HTTP /api/portfolio/digest：聚合项目、冲突进契约、指标与鉴权', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'daming-portfolio-digest-http-'));
  const web = join(dir, 'web'); mkdirSync(web); writeFileSync(join(web, 'index.html'), '<title>Fixture</title>');
  const host = await startBoardHost({ dataDir: join(dir, 'data'), port: 0, webRoot: web, bootstrapToken: BOOT });
  t.after(async () => { try { await host.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 }); });

  assert.equal((await call(host, 'api/portfolio/digest', 'GET')).status, 401);

  const boot = await fetch(host.url + '?token=' + BOOT, { redirect: 'manual' });
  assert.equal(boot.status, 302);
  const initialCookie = boot.headers.getSetCookie()[0].split(';')[0];
  const original = await call(host, 'api/session', 'GET', undefined, { cookie: initialCookie, csrf: '' });
  const oldSession: Auth = { cookie: initialCookie, csrf: String(original.data.csrfToken) };
  const setup = await call(host, 'api/identity/setup', 'POST', { username: 'root-owner', password: PW, tenantName: 'Tenant A' }, oldSession);
  assert.equal(setup.status, 200, JSON.stringify(setup.data));
  const auth: Auth = { cookie: setup.cookie, csrf: String(setup.data.csrfToken) };
  await mfa(host, auth, PW);

  // 两个项目：一个正常，一个 spec/plan 冲突
  assert.equal((await call(host, 'api/project-input', 'POST', {
    spec: [{ id: 'a', text: '正常项目目标' }], planBaseline: [{ stepId: 'p', description: '做' }], projectId: 'proj-normal'
  }, auth)).status, 201);
  assert.equal((await call(host, 'api/project-input', 'POST', {
    spec: [{ id: 'b', text: '必须 B' }], planBaseline: [{ stepId: 'q', description: '跳过 B', waives: ['b'] }], projectId: 'proj-conflict'
  }, auth)).status, 201);

  const digest = await call(host, 'api/portfolio/digest', 'GET', undefined, auth);
  assert.equal(digest.status, 200, JSON.stringify(digest.data));
  const view = digest.data as unknown as PortfolioDigestView;
  assert.ok(view.totals.projects >= 2);
  assert.equal(view.totals.healthy >= 1, true);
  assert.ok(view.realtime.some((item) => item.kind === 'contract'), 'conflict should surface as a contract escalation');
  assert.ok(view.digest.every((item) => typeof item.recommendation === 'string' && item.recommendation.length > 0));

  // 授权档位可写（owner），并反映为 managed
  const setMode = await call(host, 'api/portfolio/autonomy', 'POST', { projectId: 'proj-normal', mode: 'managed', maxInterruptsPerDay: 1 }, auth);
  assert.equal(setMode.status, 200, JSON.stringify(setMode.data));
  assert.equal(setMode.data.mode, 'managed');

  // 一键审批：把冲突项 approve → 从收件箱消失；再点同项 404
  const before = (await call(host, 'api/portfolio/digest', 'GET', undefined, auth)).data as unknown as PortfolioDigestView;
  const conflictItem = before.realtime.find((entry) => entry.kind === 'contract');
  assert.ok(conflictItem);
  const decide = await call(host, 'api/portfolio/decide', 'POST', { itemId: conflictItem!.itemId, action: 'approve' }, auth);
  assert.equal(decide.status, 200, JSON.stringify(decide.data));
  assert.equal((decide.data.decision as { action: string }).action, 'approve');
  const after = (await call(host, 'api/portfolio/digest', 'GET', undefined, auth)).data as unknown as PortfolioDigestView;
  assert.equal([...after.realtime, ...after.digest].some((entry) => entry.itemId === conflictItem!.itemId), false);
  assert.equal((await call(host, 'api/portfolio/decide', 'POST', { itemId: conflictItem!.itemId, action: 'approve' }, auth)).status, 404);
});
