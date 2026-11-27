import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startBoardHost } from '../src/http.ts';
import { totpCode } from '../src/totp.ts';
import type { MagpieHost } from '../src/magpie-host.ts';

const INSTANCE = '1234567890abcdef1234567890abcdef';
const SECRET = 'sk-offline-byoa-proof-key-xyz123';
const TOKEN = 'fixture-bootstrap-writer-token-987654321';
const PASS = 'correct-horse-battery-staple-2026!';
const PASS_VIEWER = 'another-unique-long-passphrase-2026!';
let vendorProbes = 0, localProofs = 0;
const magpie = {
  async ensure() { return { enabled: false, running: false, configured: false, version: 'offline', checkedAt: new Date().toISOString() }; },
  async status() { return { enabled: false, running: false, configured: false, version: 'offline', checkedAt: new Date().toISOString() }; },
  async read() { throw new Error('fixture_no_real_magpie'); },
  async routingCatalog() {
    return {
      instanceId: INSTANCE, checkedAt: new Date().toISOString(),
      candidates: [{
        candidateId: 'openai|gpt-test', providerId: 'openai', modelId: 'gpt-test',
        accountType: 'single-api-key', accountLabel: '唯一已启用 API Key', accountRef: 'abcde12345'
      }]
    };
  },
  async post() { throw new Error('fixture_no_paid_operation'); },
  stop() {}
} as MagpieHost;
const proof = {
  async verifyVendor(_provider: string, secret: string) {
    vendorProbes++;
    return secret === SECRET;
  },
  async matchMagpie(_binding: unknown, _provider: string, secret: string) {
    localProofs++;
    return secret === SECRET;
  }
};

async function http(host: Awaited<ReturnType<typeof startBoardHost>>, path: string, method = 'GET',
  body?: unknown, auth?: { cookie: string; csrf?: string }) {
  const headers: Record<string, string> = {};
  if (auth) headers.cookie = auth.cookie;
  if (method !== 'GET') {
    headers['content-type'] = 'application/json';
    headers.origin = host.url.slice(0, -1);
    if (auth?.csrf) headers['x-daming-csrf'] = auth.csrf;
  }
  const res = await fetch(host.url + path, { method, headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    redirect: 'manual' });
  const raw = await res.text();
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(raw); } catch {}
  return { status: res.status, data, cookie: res.headers.getSetCookie()[0]?.split(';')[0] ?? '' };
}
async function establish(host: Awaited<ReturnType<typeof startBoardHost>>) {
  const boot = await http(host, '?token=' + TOKEN);
  assert.equal(boot.status, 302);
  const login = await http(host, 'api/session', 'GET', undefined, { cookie: boot.cookie });
  assert.equal(login.status, 200);
  return { bootCookie: boot.cookie, bootCsrf: String(login.data.csrfToken) };
}

test('persistent login, tenant account proof, inherited role gates and legacy token cutoff', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'daming-identity-http-'));
  const web = join(dir, 'web');
  mkdirSync(web);
  writeFileSync(join(web, 'index.html'), '<title>Fixture</title>');
  let host = await startBoardHost({
    dataDir: join(dir, 'host'), port: 0, bootstrapToken: TOKEN,
    webRoot: web, magpie, identityProofTest: proof
  });
  t.after(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  });
  const before = await http(host, 'api/identity/status');
  assert.equal(before.data.initialized, false);
  const boot = await establish(host);
  assert.equal((await http(host, 'api/identity/setup', 'POST', {
    username: 'rootuser', password: PASS, tenantName: 'Owner tenant'
  })).status, 403);
  const setup = await http(host, 'api/identity/setup', 'POST', {
    username: 'rootuser', password: PASS, tenantName: 'Owner tenant'
  }, { cookie: boot.bootCookie, csrf: boot.bootCsrf });
  assert.equal(setup.status, 200, JSON.stringify(setup.data));
  assert.ok(setup.cookie.startsWith('daming_identity='));
  assert.equal((setup.data.identity as { username: string }).username, 'rootuser');
  const root = { cookie: setup.cookie, csrf: String(setup.data.csrfToken) };
  assert.equal((await http(host, 'api/identity/accounts', 'POST', {}, root)).status, 403,
    'an unprotected new administrator cannot mutate credential ownership');
  const enrollment = await http(host, 'api/identity/mfa/begin', 'POST', { password: PASS }, root);
  assert.equal(enrollment.status, 200, JSON.stringify(enrollment.data));
  const otp = totpCode(String(enrollment.data.secret), Math.floor(Date.now() / 30000));
  const finished = await http(host, 'api/identity/mfa/confirm', 'POST', { code: otp }, root);
  assert.equal(finished.status, 200, JSON.stringify(finished.data));
  const backupCode = (finished.data.recoveryCodes as string[])[0];
  assert.equal((await http(host, 'api/session', 'GET', undefined, root)).data.mfaEnabled, true);
  assert.equal((await http(host, 'api/identity/status')).data.initialized, true);
  assert.equal((await http(host, 'api/tasks', 'GET', undefined, { cookie: boot.bootCookie })).status, 401,
    'bootstrap cookie may no longer reach tasks');
  assert.equal((await http(host, '?token=' + TOKEN)).status, 410,
    'bootstrap link may not create a superuser after initialization');
  assert.equal((await http(host, 'api/identity/setup', 'POST', {
    username: 'hijacker', password: PASS, tenantName: 'Bad'
  }, root)).status, 409);
  assert.equal((await http(host, 'api/tasks', 'GET', undefined, root)).status, 200);
  const filtered = await http(host, 'api/command/routes', 'GET', undefined, root);
  assert.equal((filtered.data.candidates as unknown[]).length, 0);
  const publicCatalog = await http(host, 'api/identity/candidates', 'GET', undefined, root);
  assert.equal((publicCatalog.data.candidates as unknown[]).length, 1);
  assert.doesNotMatch(JSON.stringify(publicCatalog.data), /abcde12345|sk-offline/);
  const wrong = await http(host, 'api/identity/accounts', 'POST', {
    candidateId: 'openai|gpt-test', providerKind: 'openai', apiKey: 'wrong-long-secret-4321',
    label: 'Wrong credential'
  }, root);
  assert.equal(wrong.status, 422);
  assert.equal(vendorProbes, 0, 'mismatched local credential must never be sent to vendor');
  const added = await http(host, 'api/identity/accounts', 'POST', {
    candidateId: 'openai|gpt-test', providerKind: 'openai', apiKey: SECRET, label: 'Verified fixture key'
  }, root);
  assert.equal(added.status, 201, JSON.stringify(added.data));
  assert.equal(added.data.vendorBillingOwnerVerified, false);
  assert.equal(added.data.productionDispatchEnabled, false);
  assert.equal(vendorProbes, 1);
  assert.ok(localProofs >= 2);
  assert.doesNotMatch(JSON.stringify(added.data), /abcde12345|sk-offline/);
  const accounts = await http(host, 'api/identity/accounts', 'GET', undefined, root);
  assert.equal((accounts.data.accounts as unknown[]).length, 1);
  const readiness = await http(host, 'api/identity/readiness', 'GET', undefined, root);
  assert.equal(readiness.status, 200);
  assert.equal(readiness.data.mfaEnabled, true);
  assert.equal(readiness.data.validKeyControlProofs, 1);
  assert.equal(readiness.data.paidModelDispatchPermitted, false);
  assert.ok((readiness.data.blockers as string[]).includes('vendor_billing_organization_proof_missing'));
  const routeList = await http(host, 'api/command/routes', 'GET', undefined, root);
  assert.equal((routeList.data.candidates as unknown[]).length, 1);
  const mission = await http(host, 'api/command/missions', 'POST', {
    title: 'Synthetic task', goal: 'Never call models', requestId: randomUUID(), mode: 'offline-demo'
  }, root);
  assert.equal(mission.status, 201, JSON.stringify(mission.data));
  const missionId = String(mission.data.missionId);
  const invitation = await http(host, 'api/identity/invitations', 'POST', { role: 'viewer' }, root);
  assert.equal(invitation.status, 201);
  const invite = String(invitation.data.invitationCode);
  assert.equal(invite.length, 43);
  const invited = await http(host, 'api/identity/enroll', 'POST', {
    username: 'viewerusr', password: PASS_VIEWER, invitationCode: invite
  });
  assert.equal(invited.status, 200);
  const viewer = { cookie: invited.cookie, csrf: String(invited.data.csrfToken) };
  const viewerEnroll = await http(host, 'api/identity/mfa/begin', 'POST',
    { password: PASS_VIEWER }, viewer);
  assert.equal(viewerEnroll.status, 200);
  assert.equal((await http(host, 'api/identity/mfa/confirm', 'POST', {
    code: totpCode(String(viewerEnroll.data.secret), Math.floor(Date.now() / 30000))
  }, viewer)).status, 200);
  assert.equal((invited.data.identity as { memberRole: string }).memberRole, 'viewer');
  const viewerTasks = await http(host, 'api/tasks', 'GET', undefined, viewer);
  assert.equal(viewerTasks.status, 200);
  assert.deepEqual(viewerTasks.data.tasks, []);
  assert.equal((await http(host, 'api/command/missions/' + missionId, 'GET', undefined, viewer)).status, 200,
    'member of same tenant may read its mission');
  assert.equal((await http(host, 'api/identity/accounts', 'POST', {
    candidateId: 'openai|gpt-test', providerKind: 'openai', apiKey: SECRET, label: 'stolen'
  }, viewer)).status, 403);
  assert.equal((await http(host, 'api/identity/enroll', 'POST', {
    username: 'viewer002', password: PASS_VIEWER, invitationCode: invite
  })).status, 403, 'invitation must be one-time');
  const tenant = await http(host, 'api/identity/tenants', 'POST', { name: 'Unrelated tenant' }, root);
  assert.equal(tenant.status, 201);
  const switched = await http(host, 'api/identity/switch-tenant', 'POST', {
    tenantId: String(tenant.data.tenantId)
  }, root);
  assert.equal(switched.status, 200);
  assert.equal((await http(host, 'api/session', 'GET', undefined, root)).status, 401);
  const other = { cookie: switched.cookie, csrf: String(switched.data.csrfToken) };
  assert.equal(((await http(host, 'api/identity/accounts', 'GET', undefined, other)).data.accounts as unknown[]).length, 0);
  assert.equal(((await http(host, 'api/command/routes', 'GET', undefined, other)).data.candidates as unknown[]).length, 0);
  assert.equal((await http(host, 'api/command/missions/' + missionId, 'GET', undefined, other)).status, 404);
  const claimAgain = await http(host, 'api/identity/accounts', 'POST', {
    candidateId: 'openai|gpt-test', providerKind: 'openai', apiKey: SECRET, label: 'duplicate'
  }, other);
  assert.equal(claimAgain.status, 409);
  // Restart Host with the same private directory. Sessions and tenant ACLs
  // must survive; legacy bootstrap access must remain disabled.
  await host.close();
  host = await startBoardHost({
    dataDir: join(dir, 'host'), port: 0, bootstrapToken: TOKEN,
    webRoot: web, magpie, identityProofTest: proof
  });
  assert.equal((await http(host, 'api/session', 'GET', undefined, other)).status, 200);
  assert.equal((await http(host, 'api/tasks', 'GET', undefined, { cookie: boot.bootCookie })).status, 401);
  const deniedWithoutFactor = await http(host, 'api/identity/login', 'POST', { username: 'rootuser', password: PASS });
  assert.equal(deniedWithoutFactor.status, 428);
  const login = await http(host, 'api/identity/login', 'POST', {
    username: 'rootuser', password: PASS, mfaCode: backupCode
  });
  assert.equal(login.status, 200);
  assert.ok(login.cookie.startsWith('daming_identity='));
  assert.equal((await http(host, 'api/identity/logout', 'POST', {}, {
    cookie: login.cookie, csrf: String(login.data.csrfToken)
  })).status, 200);
  assert.equal((await http(host, 'api/session', 'GET', undefined, { cookie: login.cookie })).status, 401);
  const dbBytes = readFileSync(join(dir, 'host', 'identity', 'identities.db'));
  assert.ok(!dbBytes.includes(Buffer.from(SECRET)), 'plaintext BYOA key must never be stored');
});

test('desktop single-user mode: fixed machine owner is auto-signed-in, no setup or login', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'daming-single-user-http-'));
  const web = join(dir, 'web');
  mkdirSync(web);
  writeFileSync(join(web, 'index.html'), '<title>Fixture</title>');
  const host = await startBoardHost({
    dataDir: join(dir, 'host'), port: 0, bootstrapToken: TOKEN,
    webRoot: web, magpie, identityProofTest: proof, singleUser: true
  });
  t.after(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  });
  const status = await http(host, 'api/identity/status');
  assert.equal(status.data.initialized, true);
  assert.equal(status.data.singleUser, true);
  // The per-launch token signs the fixed local owner in directly (no password / TOTP).
  const boot = await http(host, '?token=' + TOKEN);
  assert.equal(boot.status, 302);
  assert.ok(boot.cookie.startsWith('daming_identity='));
  const me = await http(host, 'api/session', 'GET', undefined, { cookie: boot.cookie });
  assert.equal(me.status, 200);
  assert.equal(me.data.localMode, true);
  assert.equal(me.data.mfaEnabled, true);
  assert.equal(me.data.role, 'readwrite');
  const identity = me.data.identity as Record<string, unknown>;
  assert.equal(identity.rootAdministrator, true);
  assert.equal(identity.localMachine, true);
  assert.equal((await http(host, 'api/tasks', 'GET', undefined, { cookie: boot.cookie })).status, 200);
  const setup = await http(host, 'api/identity/setup', 'POST', {
    username: 'someone', password: PASS, tenantName: 'No second admin'
  }, { cookie: boot.cookie, csrf: String(me.data.csrfToken) });
  assert.equal(setup.status, 409);
  assert.equal(setup.data.reason, 'single_user_mode');
});
