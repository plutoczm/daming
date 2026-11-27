import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startBoardHost } from '../src/http.ts';
import { totpCode } from '../src/totp.ts';
import type { MagpieHost } from '../src/magpie-host.ts';
import type { OfficialReadTransport } from '../src/vendor-billing-readonly.ts';

const PASS = 'long-fixture-owner-password-2026';
const BOOT = 'fixture-setup-link-2026-123456';
const DEEPSEEK = 'sk-deepseek-fixture-key-123456';
const OPENAI = 'sk-openai-fixture-key-123456';
const ADMIN = 'sk-admin-fixture-key-123456';
const PROJECT = 'proj_abc123fixture';
type Auth = { cookie: string; csrf: string };
let reads = 0;
const catalog = {
  instanceId: '1234567890abcdef1234567890abcdef', checkedAt: new Date().toISOString(),
  candidates: [
    { candidateId: 'deepseek|deepseek-chat', providerId: 'deepseek', modelId: 'deepseek-chat',
      accountType: 'single-api-key', accountLabel: 'DeepSeek', accountRef: '1234567890' },
    { candidateId: 'openai|gpt-test', providerId: 'openai', modelId: 'gpt-test',
      accountType: 'single-api-key', accountLabel: 'OpenAI', accountRef: '0123456789' }
  ]
};
const magpie = {
  async ensure() { return { configured: false, running: false, enabled: false,
    version: 'fixture', checkedAt: new Date().toISOString() }; },
  async status() { return { configured: false, running: false, enabled: false,
    version: 'fixture', checkedAt: new Date().toISOString() }; },
  async read() { throw new Error('offline'); },
  async post() { throw new Error('offline'); },
  async routingCatalog() { return catalog; },
  stop() {}
} as MagpieHost;
const proof = {
  async matchMagpie(_binding: unknown, provider: string, key: string) {
    return (provider === 'openai' && key === OPENAI) ||
      (provider === 'deepseek' && key === DEEPSEEK);
  },
  async verifyVendor(provider: string, key: string) {
    return (provider === 'openai' && key === OPENAI) ||
      (provider === 'deepseek' && key === DEEPSEEK);
  }
};
const fakeOfficialRead: OfficialReadTransport = async (host, path, key) => {
  reads++;
  if (host === 'api.deepseek.com' && path === '/user/balance' && key === DEEPSEEK) {
    return { is_available: true, balance_infos: [{
      currency: 'CNY', total_balance: '125.00',
      granted_balance: '25.00', topped_up_balance: '100.00'
    }] };
  }
  if (host === 'api.openai.com' && key === ADMIN) {
    if (path === '/v1/organization/projects/' + PROJECT) {
      return { object: 'organization.project', id: PROJECT };
    }
    if (path.startsWith('/v1/organization/costs?')) {
      const params = new URLSearchParams(path.split('?')[1]);
      if (params.get('project_ids[]') !== PROJECT) throw new Error('wrong_project_filter');
      const start = Number(params.get('start_time'));
      const end = Number(params.get('end_time'));
      return { object: 'page', data: [{
        object: 'bucket', start_time: start, end_time: end,
        results: [{ object: 'organization.costs.result',
          project_id: PROJECT, amount: { value: 0.26, currency: 'usd' } }]
      }], has_more: false, next_page: null };
    }
  }
  throw new Error('fixture_request_unexpected');
};

async function http(base: string, path: string, method = 'GET',
  body?: unknown, auth?: Auth) {
  const request = await fetch(base + path, {
    method,
    headers: {
      ...(auth ? { cookie: auth.cookie } : {}),
      ...(method === 'GET' ? {} : {
        origin: new URL(base).origin, 'content-type': 'application/json',
        ...(auth ? { 'x-daming-csrf': auth.csrf } : {})
      })
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    redirect: 'manual'
  });
  const raw = await request.text();
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(raw); } catch {}
  return { status: request.status, data,
    cookie: request.headers.getSetCookie()[0]?.split(';')[0] ?? '' };
}

test('tenant observations use official readonly source and cannot be replayed across tenants', async (t) => {
  reads = 0;
  const dir = mkdtempSync(join(tmpdir(), 'daming-vendor-probe-http-'));
  const webRoot = join(dir, 'web');
  mkdirSync(webRoot);
  writeFileSync(join(webRoot, 'index.html'), '<title>fixture</title>');
  const host = await startBoardHost({
    dataDir: join(dir, 'data'), webRoot, port: 0,
    bootstrapToken: BOOT, magpie, identityProofTest: proof,
    identityBillingReadTest: fakeOfficialRead,
    openAiKeyIssuanceTest: async (method, path, key, body) => {
      assert.equal(key, ADMIN);
      if (method === 'GET' && path.endsWith('/' + PROJECT))
        return { object: 'organization.project', id: PROJECT };
      if (method === 'GET' && path.endsWith('/svc_acct_fixture2026'))
        return { object: 'organization.project.service_account',
          id: 'svc_acct_fixture2026', role: 'member' };
      if (method === 'POST' && path.endsWith('/api_keys')) {
        assert.deepEqual(body?.scopes, ['api.responses.write']);
        const now = Math.floor(Date.now() / 1000);
        return { object: 'organization.project.service_account.api_key',
          id: 'key_fixture2026', value: 'sk-created-service-key-fixture-2026',
          created_at: now, expires_at: now + 3600 };
      }
      throw new Error('unexpected_official_admin_endpoint');
    }
  });
  t.after(async () => { await host.close(); rmSync(dir,
    { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  const boot = await fetch(host.url + '?token=' + BOOT, { redirect: 'manual' });
  const bootstrap: Auth = { cookie: boot.headers.getSetCookie()[0].split(';')[0], csrf: '' };
  const session = await http(host.url, 'api/session', 'GET', undefined, bootstrap);
  bootstrap.csrf = String(session.data.csrfToken);
  const created = await http(host.url, 'api/identity/setup', 'POST',
    { username: 'financeowner', password: PASS, tenantName: 'First tenant' }, bootstrap);
  assert.equal(created.status, 200);
  const owner: Auth = { cookie: created.cookie, csrf: String(created.data.csrfToken) };
  const mfa = await http(host.url, 'api/identity/mfa/begin', 'POST', { password: PASS }, owner);
  assert.equal(mfa.status, 200);
  assert.equal((await http(host.url, 'api/identity/mfa/confirm', 'POST', {
    code: totpCode(String(mfa.data.secret), Math.floor(Date.now() / 30000))
  }, owner)).status, 200);

  const ds = await http(host.url, 'api/identity/accounts', 'POST', {
    candidateId: 'deepseek|deepseek-chat', providerKind: 'deepseek',
    label: 'DeepSeek key', apiKey: DEEPSEEK
  }, owner);
  const oa = await http(host.url, 'api/identity/accounts', 'POST', {
    candidateId: 'openai|gpt-test', providerKind: 'openai',
    label: 'OpenAI key', apiKey: OPENAI
  }, owner);
  assert.equal(ds.status, 201, JSON.stringify(ds.data));
  assert.equal(oa.status, 201, JSON.stringify(oa.data));
  const dsId = String(ds.data.credentialId), oaId = String(oa.data.credentialId);

  assert.equal((await http(host.url, 'api/identity/billing/probe', 'POST', {
    provider: 'deepseek', credentialId: dsId, apiKey: 'wrong-fixture-key-123456'
  }, owner)).status, 403);
  assert.equal(reads, 0, 'wrong credential must not trigger a network request');

  const observedDs = await http(host.url, 'api/identity/billing/probe', 'POST', {
    provider: 'deepseek', credentialId: dsId, apiKey: DEEPSEEK
  }, owner);
  assert.equal(observedDs.status, 201, JSON.stringify(observedDs.data));
  assert.deepEqual(observedDs.data.amounts, [{ currency: 'CNY', minor: 12500 }]);
  assert.equal(observedDs.data.vendorInvoiceVerified, false);
  assert.equal(observedDs.data.perRequestCashCapGuaranteed, false);

  const observedOa = await http(host.url, 'api/identity/billing/probe', 'POST', {
    provider: 'openai', credentialId: oaId, adminKey: ADMIN, projectId: PROJECT
  }, owner);
  assert.equal(observedOa.status, 201, JSON.stringify(observedOa.data));
  assert.deepEqual(observedOa.data.amounts, [{ currency: 'USD', minor: 26 }]);
  assert.equal(observedOa.data.modelKeyProjectLinkVerified, false);
  assert.equal(observedOa.data.billingOwnerVerified, false);

  const observations = await http(host.url, 'api/identity/billing/observations', 'GET', undefined, owner);
  assert.equal(observations.status, 200);
  assert.equal((observations.data.observations as unknown[]).length, 2);
  const safe = JSON.stringify([observedDs.data, observedOa.data, observations.data]);
  assert.doesNotMatch(safe, /sk-admin|sk-openai|sk-deepseek|proj_abc123fixture|1234567890|0123456789/);
  const db = readFileSync(join(dir, 'data', 'identity', 'identities.db'));
  assert.ok(!db.includes(Buffer.from(ADMIN)), 'privileged Admin API key must never persist');

  const other = await http(host.url, 'api/identity/tenants', 'POST', { name: 'Second tenant' }, owner);
  const switched = await http(host.url, 'api/identity/switch-tenant', 'POST',
    { tenantId: other.data.tenantId }, owner);
  assert.equal(switched.status, 200);
  const second: Auth = { cookie: switched.cookie, csrf: String(switched.data.csrfToken) };
  const otherObservations = await http(host.url, 'api/identity/billing/observations',
    'GET', undefined, second);
  assert.deepEqual(otherObservations.data.observations, []);
  assert.equal((await http(host.url, 'api/identity/billing/probe', 'POST', {
    provider: 'deepseek', credentialId: dsId, apiKey: DEEPSEEK
  }, second)).status, 404);
  assert.equal((await http(host.url, 'api/identity/billing/probe', 'POST', {
    provider: 'openai', credentialId: oaId, adminKey: ADMIN, projectId: PROJECT
  }, second)).status, 404);
  assert.equal(reads, 3, 'cross-tenant probes must be blocked before sending HTTP');
  const readiness = await http(host.url, 'api/identity/readiness', 'GET', undefined, second);
  assert.equal(readiness.data.paidModelDispatchPermitted, false);
});

test('shared Magpie and AutoLoop command POSTs do not cross invited tenants', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'daming-shared-command-'));
  const webRoot = join(dir, 'web');
  mkdirSync(webRoot);
  writeFileSync(join(webRoot, 'index.html'), '<title>fixture</title>');
  const host = await startBoardHost({ dataDir: join(dir, 'data'), webRoot,
    port: 0, bootstrapToken: BOOT, magpie, identityProofTest: proof });
  t.after(async () => { await host.close(); rmSync(dir,
    { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const boot = await fetch(host.url + '?token=' + BOOT, { redirect: 'manual' });
  const bootstrap: Auth = { cookie: boot.headers.getSetCookie()[0].split(';')[0], csrf: '' };
  bootstrap.csrf = String((await http(host.url, 'api/session', 'GET', undefined, bootstrap)).data.csrfToken);
  const opened = await http(host.url, 'api/identity/setup', 'POST', {
    username: 'owneradmin', password: PASS, tenantName: 'Owner tenant'
  }, bootstrap);
  const owner: Auth = { cookie: opened.cookie, csrf: String(opened.data.csrfToken) };
  const invite = await http(host.url, 'api/identity/invitations', 'POST',
    { role: 'operator' }, owner);
  assert.equal(invite.status, 403, 'before MFA no invite');
  const mfa = await http(host.url, 'api/identity/mfa/begin', 'POST', { password: PASS }, owner);
  await http(host.url, 'api/identity/mfa/confirm', 'POST', {
    code: totpCode(String(mfa.data.secret), Math.floor(Date.now() / 30000))
  }, owner);
  const accepted = await http(host.url, 'api/identity/invitations', 'POST',
    { role: 'operator' }, owner);
  const joined = await http(host.url, 'api/identity/enroll', 'POST', {
    username: 'tenantmember', password: 'long-tenant-member-password-2026',
    invitationCode: accepted.data.invitationCode
  });
  const member: Auth = { cookie: joined.cookie, csrf: String(joined.data.csrfToken) };
  assert.equal((await http(host.url, 'api/command/missions', 'POST', {
    title: 'not allowed', goal: 'external side effects'
  }, member)).status, 403);
  const memberMfa = await http(host.url, 'api/identity/mfa/begin', 'POST',
    { password: 'long-tenant-member-password-2026' }, member);
  await http(host.url, 'api/identity/mfa/confirm', 'POST', {
    code: totpCode(String(memberMfa.data.secret), Math.floor(Date.now() / 30000))
  }, member);
  assert.equal((await http(host.url, 'api/command/missions', 'POST', {
    title: 'still forbidden', goal: 'global autoloop', mode: 'offline-demo'
  }, member)).status, 403);
  assert.equal((await http(host.url, 'api/command/resources', 'GET', undefined, member)).status, 403);
  assert.equal((await http(host.url, 'api/command/missions', 'GET', undefined, member)).status, 200);
  assert.equal((await http(host.url, 'api/command/routes', 'GET', undefined, member)).status, 200);
  const personalSpace = await http(host.url, 'api/identity/tenants', 'POST',
    { name: 'Own isolated tenant' }, member);
  assert.equal(personalSpace.status, 201);
  const switched = await http(host.url, 'api/identity/switch-tenant', 'POST',
    { tenantId: personalSpace.data.tenantId }, member);
  const tenantOwner: Auth = {
    cookie: switched.cookie, csrf: String(switched.data.csrfToken)
  };
  assert.equal((await http(host.url, 'api/identity/candidates', 'GET', undefined,
    tenantOwner)).status, 403);
  const saved = await http(host.url, 'api/identity/tenant-accounts', 'POST', {
    provider: 'openai', modelId: 'gpt-test', label: 'Tenant key', apiKey: OPENAI
  }, tenantOwner);
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  assert.equal(saved.data.magpieBindingVerified, false);
  assert.equal(saved.data.productionDispatchEnabled, false);
  const keyId = String(saved.data.credentialId);
  assert.equal((await http(host.url, 'api/identity/tenant-accounts',
    'GET', undefined, tenantOwner)).status, 200);
  assert.deepEqual((await http(host.url, 'api/identity/tenant-accounts',
    'GET', undefined, owner)).data.accounts, []);
  assert.equal((await http(host.url, 'api/identity/tenant-accounts', 'POST', {
    provider: 'openai', modelId: 'gpt-test', label: 'Duplicate', apiKey: OPENAI
  }, owner)).status, 409);
  assert.equal((await http(host.url, 'api/identity/tenant-accounts/' +
    keyId + '/verify', 'POST', { apiKey: OPENAI }, owner)).status, 404);
  assert.equal((await http(host.url, 'api/identity/tenant-accounts/' +
    keyId + '/verify', 'POST', { apiKey: OPENAI }, tenantOwner)).status, 200);
  assert.equal((await http(host.url, 'api/identity/tenant-accounts/' +
    keyId, 'DELETE', {}, tenantOwner)).status, 200);
});
