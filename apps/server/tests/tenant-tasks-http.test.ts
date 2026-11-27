import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startBoardHost } from '../src/http.ts';
import { totpCode } from '../src/totp.ts';
import type { MagpieHost } from '../src/magpie-host.ts';
import { projectMagpieUnifiedTargets } from '../src/magpie-unified-targets.ts';

const BOOT = 'fixture-tenant-test-bootstrap-2026';
const PW = 'tenant-test-owner-passphrase-2026';
const PW2 = 'tenant-test-operator-passphrase-2026';
const magpie = {
  async ensure() { return { configured: false, running: false, enabled: false, version: 'fixture',
    checkedAt: new Date().toISOString() }; },
  async status() { return { configured: false, running: false, enabled: false, version: 'fixture',
    checkedAt: new Date().toISOString() }; },
  async unifiedTargets() { return projectMagpieUnifiedTargets({
    models: [{ id: 'openai/gpt-6', sub: false }, { id: 'codex/gpt-6', sub: true }],
    groups: [{ id: 'research', ref: 'group/research', ready: true,
      members: ['openai/gpt-6','codex/gpt-6'] }]
  }); },
  async read() { throw new Error('offline'); },
  async post() { throw new Error('offline'); }, stop() {}
} as MagpieHost;

type Auth = { cookie: string; csrf: string };
type Host = Awaited<ReturnType<typeof startBoardHost>>;
async function call(host: Host, path: string, method = 'GET', body?: unknown, auth?: Auth) {
  const response = await fetch(host.url + path, {
    method, headers: {
      ...(auth ? { cookie: auth.cookie } : {}),
      ...(method !== 'GET' ? {
        origin: new URL(host.url).origin, 'content-type': 'application/json',
        ...(auth ? { 'x-daming-csrf': auth.csrf } : {})
      } : {})
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    redirect: 'manual'
  });
  let data: Record<string, unknown> = {};
  try { data = await response.json() as Record<string, unknown>; } catch {}
  return { status: response.status, data,
    cookie: response.headers.getSetCookie()[0]?.split(';')[0] ?? '' };
}
async function mfa(host: Host, principal: Auth, pw: string) {
  const started = await call(host, 'api/identity/mfa/begin', 'POST', { password: pw }, principal);
  assert.equal(started.status, 200, JSON.stringify(started.data));
  const code = totpCode(String(started.data.secret), Math.floor(Date.now() / 30000));
  const done = await call(host, 'api/identity/mfa/confirm', 'POST', { code }, principal);
  assert.equal(done.status, 200, JSON.stringify(done.data));
}
async function createFixture(host: Host, auth: Auth, title: string, mode = 'fixture') {
  return await call(host, 'api/tasks', 'POST',
    { title, goal: 'Tenant-only offline demonstration', mode }, auth);
}
test('tenant HTTP tasks isolate old and new records, refuse model modes and unknown owners', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'daming-tenant-task-http-'));
  const web = join(dir, 'web');
  mkdirSync(web);
  writeFileSync(join(web, 'index.html'), '<title>Fixture</title>');
  const host = await startBoardHost({ dataDir: join(dir, 'data'), port: 0, webRoot: web,
    bootstrapToken: BOOT, magpie });
  t.after(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  });

  const boot = await fetch(host.url + '?token=' + BOOT, { redirect: 'manual' });
  assert.equal(boot.status, 302);
  const initialCookie = boot.headers.getSetCookie()[0].split(';')[0];
  const original = await call(host, 'api/session', 'GET', undefined,
    { cookie: initialCookie, csrf: '' });
  const oldSession: Auth = { cookie: initialCookie, csrf: String(original.data.csrfToken) };
  const legacy = await createFixture(host, oldSession, 'Pre-migration legacy task');
  assert.equal(legacy.status, 202);
  const legacyId = String(legacy.data.taskId);
  const oldMission = await call(host, 'api/command/missions', 'POST', {
    title: 'Legacy mission', goal: 'Legacy offline only',
    requestId: randomUUID(), mode: 'offline-demo'
  }, oldSession);
  assert.equal(oldMission.status, 201);
  const legacyMissionId = String(oldMission.data.missionId);

  const setup = await call(host, 'api/identity/setup', 'POST',
    { username: 'root-owner', password: PW, tenantName: 'Tenant A' }, oldSession);
  assert.equal(setup.status, 200);
  const rootA: Auth = { cookie: setup.cookie, csrf: String(setup.data.csrfToken) };
  assert.equal((await call(host, 'api/tasks', 'GET', undefined, rootA)).status, 403,
    'first factor alone must not expose shared task data');
  await mfa(host, rootA, PW);
  const paidAdmission = await call(host, 'api/identity/agent-runtime/readiness',
    'GET', undefined, rootA);
  assert.equal(paidAdmission.status, 200, JSON.stringify(paidAdmission.data));
  assert.equal(paidAdmission.data.productionPaidAgentReady, false);
  assert.equal(paidAdmission.data.paidDispatchPermitted, false);
  assert.equal(paidAdmission.data.vendorGuaranteedCashCap, false);
  assert.equal(paidAdmission.data.dockerOfflineIsolationVerified, false);
  assert.ok((paidAdmission.data.blockers as string[]).includes(
    'trusted_egress_disabled_by_default'));
  const dockerInjection = await call(host, 'api/identity/agent-runtime/probe',
    'POST', { text: 'hello', image: 'attacker-owned' }, rootA);
  assert.equal(dockerInjection.status, 400,
    'extra parameters must fail before any Docker process starts');
  const dockerOverflow = await call(host, 'api/identity/agent-runtime/probe',
    'POST', { text: 'x'.repeat(2049) }, rootA);
  assert.equal(dockerOverflow.status, 400);
  if (process.env.DAMING_VALIDATE_DOCKER_AGENT === '1' && process.platform === 'win32') {
    const actualIsolation = await call(host, 'api/identity/agent-runtime/probe',
      'POST', { text: 'Owner scoped offline job' }, rootA);
    assert.equal(actualIsolation.status, 200, JSON.stringify(actualIsolation.data));
    assert.equal(actualIsolation.data.containerIsolated, true);
    assert.equal(actualIsolation.data.networkBlocked, true);
    assert.equal(actualIsolation.data.hostSecretsHidden, true);
    assert.equal(actualIsolation.data.paidDispatchPermitted, false);
    assert.equal(actualIsolation.data.chargedMinor, 0);
    const afterProbe = await call(host, 'api/identity/agent-runtime/readiness',
      'GET', undefined, rootA);
    assert.equal(afterProbe.data.dockerOfflineIsolationVerified, true);
    assert.equal(afterProbe.data.productionPaidAgentReady, false);
    assert.equal(afterProbe.data.paidDispatchPermitted, false);
  }
  const unified = await call(host, 'api/command/targets', 'GET', undefined, rootA);
  assert.equal(unified.status, 200, JSON.stringify(unified.data));
  const unifiedTargets = unified.data.targets as { targetId: string; kind: string }[];
  assert.ok(unifiedTargets.some(t => t.targetId === 'group/research' && t.kind === 'route-group'));
  assert.ok(unifiedTargets.some(t => t.targetId === 'codex/gpt-6' && t.kind === 'agent-backed'));
  const plan = await call(host, 'api/command/missions/' + legacyMissionId + '/role-plan',
    'POST', { requestId: randomUUID(), assignments: [
      { role: 'router', targetId: 'group/research' },
      { role: 'analysis', targetId: 'codex/gpt-6' }
    ] }, rootA);
  assert.equal(plan.status, 200, JSON.stringify(plan.data));
  const nodes = plan.data.nodes as { id: string; modelRoute: string }[];
  assert.equal(nodes.find(n => n.id === 'router')?.modelRoute, 'group/research');
  assert.equal(nodes.find(n => n.id === 'analysis')?.modelRoute, 'codex/gpt-6');
  assert.equal((await call(host, 'api/command/missions/' + legacyMissionId +
    '/role-plan', 'POST', { requestId: randomUUID(), assignments: [
      { role: 'analysis', targetId: 'group/forged' }
    ] }, rootA)).status, 400);
  const agentBase = 'api/command/missions/' + legacyMissionId + '/agent-graph';
  const agentRequestId = randomUUID();
  const launched = await call(host, agentBase + '/launch', 'POST',
    { requestId: agentRequestId }, rootA);
  assert.equal(launched.status, 201, JSON.stringify(launched.data));
  const launchedGraph = launched.data.graph as {
    rootRunId: string; status: string;
    nodes: { role: string; plannedMagpieTarget: string; actualDriver: string }[];
  };
  assert.equal(launchedGraph.nodes.length, 3);
  assert.equal(launchedGraph.nodes.find(n => n.role === 'analysis')?.plannedMagpieTarget,
    'codex/gpt-6');
  assert.equal(launchedGraph.nodes.find(n => n.role === 'analysis')?.actualDriver,
    'offline-wsl-sandbox');
  const replay = await call(host, agentBase + '/launch', 'POST',
    { requestId: agentRequestId }, rootA);
  assert.equal(replay.status, 201);
  assert.equal((replay.data.graph as { rootRunId: string }).rootRunId,
    launchedGraph.rootRunId);
  let completedChildren = false;
  for (let poll = 0; poll < 100; poll++) {
    const state = await call(host, agentBase, 'GET', undefined, rootA);
    assert.equal(state.status, 200);
    const graph = state.data.graph as {
      status: string; transfers: unknown[]; paidDispatchPermitted: boolean;
    };
    if (graph.status === 'waiting_approval') {
      assert.equal(graph.transfers.length, 2);
      assert.equal(graph.paidDispatchPermitted, false);
      completedChildren = true;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  assert.equal(completedChildren, true, 'parallel offline subagents must finish');
  const decidedGraph = await call(host, agentBase + '/decide', 'POST', {
    runId: launchedGraph.rootRunId, requestId: randomUUID(), action: 'approve'
  }, rootA);
  assert.equal(decidedGraph.status, 200);
  assert.equal((decidedGraph.data.graph as { status: string }).status, 'completed');
  const policy = await call(host, 'api/identity/budget/policy', 'POST', {
    currency: 'USD', perRequestMinor: 500, perUtcDayMinor: 800
  }, rootA);
  assert.equal(policy.status, 200, JSON.stringify(policy.data));
  assert.equal(policy.data.authorizedPaidDispatch, false);
  const requestId = randomUUID();
  const budget = await call(host, 'api/identity/budget/preview', 'POST', {
    currency: 'USD', requestId, requestedMinor: 500
  }, rootA);
  assert.equal(budget.status, 201, JSON.stringify(budget.data));
  const holdId = String(budget.data.holdId);
  assert.equal((await call(host, 'api/identity/budget/preview', 'POST', {
    currency: 'USD', requestId, requestedMinor: 500
  }, rootA)).data.holdId, holdId);
  assert.equal((await call(host, 'api/identity/budget/preview', 'POST', {
    currency: 'USD', requestId: randomUUID(), requestedMinor: 400
  }, rootA)).status, 409);
  const listedA = await call(host, 'api/tasks', 'GET', undefined, rootA);
  assert.equal((listedA.data.tasks as { taskId: string }[]).some(row => row.taskId === legacyId), true);
  assert.equal((await call(host, 'api/command/missions/' + legacyMissionId,
    'GET', undefined, rootA)).status, 200);
  const taskA = await createFixture(host, rootA, 'Tenant A owner task');
  assert.equal(taskA.status, 202);
  const aId = String(taskA.data.taskId);

  const inviteOp = await call(host, 'api/identity/invitations', 'POST', { role: 'operator' }, rootA);
  assert.equal(inviteOp.status, 201);
  const enrolled = await call(host, 'api/identity/enroll', 'POST', {
    username: 'operator-a', password: PW2, invitationCode: inviteOp.data.invitationCode
  });
  assert.equal(enrolled.status, 200);
  const operator: Auth = { cookie: enrolled.cookie, csrf: String(enrolled.data.csrfToken) };
  assert.equal((await createFixture(host, operator, 'Cannot write before TOTP')).status, 403);
  await mfa(host, operator, PW2);
  assert.equal((await call(host, 'api/command/targets', 'GET', undefined, operator)).status, 403);
  assert.equal((await call(host, agentBase, 'GET', undefined, operator)).status, 403);
  assert.equal((await call(host, agentBase + '/launch', 'POST',
    { requestId: randomUUID() }, operator)).status, 403);
  assert.equal((await call(host, 'api/command/missions/' + legacyMissionId + '/role-plan',
    'POST', { requestId: randomUUID(), assignments: [
      { role: 'analysis', targetId: 'codex/gpt-6' }
    ] }, operator)).status, 403);
  const isolated = await call(host, 'api/identity/sandbox/inspect', 'POST',
    { text: 'Local offline sandbox test' }, operator);
  assert.equal(isolated.status, 200, JSON.stringify(isolated.data));
  assert.equal(isolated.data.networkBlocked, true);
  assert.equal(isolated.data.windowsDrivesHidden, true);
  assert.equal(isolated.data.modelCallsEnabled, false);
  assert.equal(isolated.data.paidDispatchPermitted, false);
  const fromOp = await createFixture(host, operator, 'Tenant A operator task');
  assert.equal(fromOp.status, 202);
  const opId = String(fromOp.data.taskId);
  assert.equal((await createFixture(host, operator, 'Forbidden remote model task', 'dsh')).status, 403);
  assert.equal((await createFixture(host, operator, 'Forbidden filesystem task', 'local')).status, 403);
  assert.equal((await call(host, 'api/tasks/' + aId, 'GET', undefined, operator)).status, 200);
  assert.equal((await call(host, 'api/tasks/' + opId, 'GET', undefined, operator)).status, 200);
  assert.equal((await call(host, 'api/tasks/' + opId + '/reconcile', 'POST', {}, operator)).status, 403);
  assert.equal((await call(host, 'api/events', 'GET', undefined, operator)).status, 403,
    'global event stream is not tenant aware');

  const inviteView = await call(host, 'api/identity/invitations', 'POST', { role: 'viewer' }, rootA);
  const view = await call(host, 'api/identity/enroll', 'POST', {
    username: 'viewer-a', password: 'viewer-a-long-password-2026',
    invitationCode: inviteView.data.invitationCode
  });
  assert.equal(view.status, 200);
  const viewer: Auth = { cookie: view.cookie, csrf: String(view.data.csrfToken) };
  await mfa(host, viewer, 'viewer-a-long-password-2026');
  assert.equal((await call(host, 'api/tasks', 'GET', undefined, viewer)).status, 200);
  assert.equal((await call(host, 'api/tasks/' + aId, 'GET', undefined, viewer)).status, 200);
  assert.equal((await call(host, 'api/command/missions/' + legacyMissionId,
    'GET', undefined, viewer)).status, 200);
  assert.equal((await createFixture(host, viewer, 'Cannot create by viewer')).status, 403);

  const createdTenant = await call(host, 'api/identity/tenants', 'POST', { name: 'Tenant B' }, rootA);
  assert.equal(createdTenant.status, 201);
  const switched = await call(host, 'api/identity/switch-tenant', 'POST',
    { tenantId: createdTenant.data.tenantId }, rootA);
  assert.equal(switched.status, 200);
  const rootB: Auth = { cookie: switched.cookie, csrf: String(switched.data.csrfToken) };
  assert.equal((await call(host, 'api/session', 'GET', undefined, rootA)).status, 401);
  assert.equal((await call(host, 'api/command/missions/' + legacyMissionId,
    'GET', undefined, rootB)).status, 404);
  assert.equal((await call(host, agentBase, 'GET', undefined, rootB)).status, 404);
  assert.equal((await call(host, agentBase + '/decide', 'POST', {
    runId: launchedGraph.rootRunId, requestId: randomUUID(), action: 'cancel'
  }, rootB)).status, 404);
  const budgetB = await call(host, 'api/identity/budget', 'GET', undefined, rootB);
  assert.equal(budgetB.status, 200);
  assert.deepEqual(budgetB.data.policies, []);
  assert.deepEqual(budgetB.data.holds, []);
  assert.equal((await call(host, 'api/identity/budget/holds/' + holdId,
    'DELETE', {}, rootB)).status, 404);
  const listB = await call(host, 'api/tasks', 'GET', undefined, rootB);
  assert.deepEqual(listB.data.tasks, []);
  for (const id of [legacyId, aId, opId]) {
    assert.equal((await call(host, 'api/tasks/' + id, 'GET', undefined, rootB)).status, 404);
    assert.equal((await call(host, 'api/tasks/' + id + '/cancel', 'POST', {}, rootB)).status, 404);
  }
  const taskB = await createFixture(host, rootB, 'Tenant B separate task');
  assert.equal(taskB.status, 202);
  const bId = String(taskB.data.taskId);
  assert.equal((await call(host, 'api/tasks/' + bId, 'GET', undefined, rootB)).status, 200);
  assert.equal((await call(host, 'api/tasks/' + bId, 'GET', undefined, viewer)).status, 404);
  assert.equal((await call(host, 'api/tasks/' + bId, 'GET', undefined, operator)).status, 404);
  assert.equal((await call(host, 'api/tasks/' + bId + '/approve', 'POST', {}, operator)).status, 404);
  assert.equal((await call(host, 'api/tasks', 'GET', undefined, operator)).status, 200);
  assert.equal(((await call(host, 'api/tasks', 'GET', undefined, operator)).data.tasks as unknown[]).length, 3);
});
