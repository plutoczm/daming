import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startBoardHost } from '../src/http.ts';
import { totpCode } from '../src/totp.ts';
import type { MagpieHost } from '../src/magpie-host.ts';

type Auth = { cookie: string; csrf: string };
const mockMagpie = {
  async ensure() { return { running: false, enabled: false, configured: false,
    version: 'offline', checkedAt: new Date().toISOString() }; },
  async status() { return { running: false, enabled: false, configured: false,
    version: 'offline', checkedAt: new Date().toISOString() }; },
  async read() { throw new Error('offline'); },
  async post() { throw new Error('offline'); },
  stop() {}
} as MagpieHost;
async function call(host: Awaited<ReturnType<typeof startBoardHost>>,
  path: string, method = 'GET', body?: unknown, auth?: Auth) {
  const response = await fetch(host.url + path, {
    method, headers: {
      ...(auth ? { cookie: auth.cookie } : {}),
      ...(method === 'GET' ? {} : {
        origin: new URL(host.url).origin, 'content-type': 'application/json',
        ...(auth ? { 'x-daming-csrf': auth.csrf } : {})
      })
    }, ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    redirect: 'manual'
  });
  let data: Record<string, unknown> = {};
  try { data = await response.json() as Record<string, unknown>; } catch {}
  return { status: response.status, data,
    cookie: response.headers.getSetCookie()[0]?.split(';')[0] ?? '' };
}
test('HTTP owner MFA + exact BYOA account + one-shot budget gate paid Host egress', async t => {
  const base = mkdtempSync(join(tmpdir(), 'daming-egress-http-'));
  const web = join(base, 'web');
  mkdirSync(web);
  writeFileSync(join(web, 'index.html'), '<title>Mock</title>');
  const secret = 'sk-tenant-egress-mock-private-secret-2026';
  let outbound = 0;
  const host = await startBoardHost({
    dataDir: join(base, 'data'), webRoot: web, port: 0,
    bootstrapToken: 'test-egress-host-bootstrap-2026',
    magpie: mockMagpie,
    identityProofTest: {
      verifyVendor: async (_provider, key, model) =>
        key === secret && model === 'deepseek-flash',
      matchMagpie: async () => false
    },
    paidEgressTest: {
      transport: async req => {
        outbound++;
        assert.equal(req.provider, 'deepseek');
        assert.equal(req.modelId, 'deepseek-flash');
        assert.equal(req.apiKey, secret);
        assert.equal(req.maxOutputTokens, 16);
        return { text: 'single-model-answer', inputTokens: 8, outputTokens: 3 };
      },
      runner: async (_job, send) => (await send()).text
    }
  });
  t.after(async () => {
    await host.close();
    rmSync(base, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  });
  const bootstrap = await fetch(host.url + '?token=test-egress-host-bootstrap-2026',
    { redirect: 'manual' });
  const bootstrapCookie = bootstrap.headers.getSetCookie()[0].split(';')[0];
  const session = await call(host, 'api/session', 'GET', undefined,
    { cookie: bootstrapCookie, csrf: '' });
  const setup = await call(host, 'api/identity/setup', 'POST', {
    username: 'egressowner', password: 'trusted-egress-test-password-2026',
    tenantName: 'Test Tenant'
  }, { cookie: bootstrapCookie, csrf: String(session.data.csrfToken) });
  assert.equal(setup.status, 200);
  const owner = { cookie: setup.cookie, csrf: String(setup.data.csrfToken) };
  assert.equal((await call(host, 'api/identity/paid-egress/attempts', 'GET', undefined, owner)).status,
    403, 'first factor cannot inspect payment attempts');
  const begin = await call(host, 'api/identity/mfa/begin', 'POST',
    { password: 'trusted-egress-test-password-2026' }, owner);
  assert.equal(begin.status, 200, JSON.stringify(begin.data));
  const confirmed = await call(host, 'api/identity/mfa/confirm', 'POST', {
    code: totpCode(String(begin.data.secret), Math.floor(Date.now() / 30000))
  }, owner);
  assert.equal(confirmed.status, 200);
  assert.equal((await call(host, 'api/identity/paid-egress/prepare', 'POST',
    {}, { cookie: owner.cookie, csrf: 'invalid' })).status, 403);
  const added = await call(host, 'api/identity/tenant-accounts', 'POST', {
    provider: 'deepseek', modelId: 'deepseek-flash', apiKey: secret, label: 'My model'
  }, owner);
  assert.equal(added.status, 201, JSON.stringify(added.data));
  const credentialId = String(added.data.credentialId);
  assert.ok(!JSON.stringify(added.data).includes(secret));
  assert.equal((await call(host, 'api/identity/budget/policy', 'POST', {
    currency: 'CNY', perRequestMinor: 100, perUtcDayMinor: 150
  }, owner)).status, 200);
  const input = {
    requestId: randomUUID(), credentialId, currency: 'CNY',
    reservedMinor: 80, maxOutputTokens: 16, prompt: 'Hello from isolated tenant'
  };
  assert.equal((await call(host, 'api/identity/paid-egress/execute', 'POST', {
    ...input, confirmation: 'SEND_ONE_PAID_MODEL_REQUEST_WITH_UNVERIFIED_CASH_CAP'
  }, owner)).status, 404, 'unprepared requests cannot trigger vendor calls');
  assert.equal(outbound, 0);
  const prepared = await call(host, 'api/identity/paid-egress/prepare', 'POST', {
    ...input, confirmation: 'PREPARE_ONE_PAID_AGENT_ATTEMPT'
  }, owner);
  assert.equal(prepared.status, 201, JSON.stringify(prepared.data));
  assert.equal((prepared.data.attempt as { status: string }).status, 'prepared');
  assert.equal((await call(host, 'api/identity/paid-egress/execute', 'POST', {
    ...input, confirmation: 'NO'
  }, owner)).status, 400);
  const sent = await call(host, 'api/identity/paid-egress/execute', 'POST', {
    ...input, confirmation: 'SEND_ONE_PAID_MODEL_REQUEST_WITH_UNVERIFIED_CASH_CAP'
  }, owner);
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal(sent.data.text, 'single-model-answer');
  assert.equal(sent.data.vendorInvoiceVerified, false);
  assert.equal(sent.data.vendorHardCapGuaranteed, false);
  assert.equal(sent.data.chargedMinor, null);
  assert.equal((sent.data.attempt as { status: string }).status, 'uncertain');
  assert.ok(!JSON.stringify(sent.data).includes(secret));
  assert.equal(outbound, 1);
  assert.equal((await call(host, 'api/identity/paid-egress/execute', 'POST', {
    ...input, confirmation: 'SEND_ONE_PAID_MODEL_REQUEST_WITH_UNVERIFIED_CASH_CAP'
  }, owner)).status, 409);
  assert.equal(outbound, 1);
  assert.equal((await call(host, 'api/identity/paid-egress/attempts', 'GET', undefined,
    owner)).data.attempts instanceof Array, true);
  const switchTenant = await call(host, 'api/identity/tenants', 'POST',
    { name: 'Unrelated' }, owner);
  const switched = await call(host, 'api/identity/switch-tenant', 'POST',
    { tenantId: switchTenant.data.tenantId }, owner);
  const ownerB = { cookie: switched.cookie, csrf: String(switched.data.csrfToken) };
  assert.deepEqual((await call(host, 'api/identity/paid-egress/attempts', 'GET',
    undefined, ownerB)).data.attempts, []);
  assert.equal((await call(host, 'api/identity/paid-egress/execute', 'POST', {
    ...input, confirmation: 'SEND_ONE_PAID_MODEL_REQUEST_WITH_UNVERIFIED_CASH_CAP'
  }, ownerB)).status, 403);
  assert.equal(outbound, 1);
});
