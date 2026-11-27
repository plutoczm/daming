import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBoardHost } from '../src/http.ts';
import { totpCode } from '../src/totp.ts';
import type { MagpieHost } from '../src/magpie-host.ts';
const PASS = 'web-consent-owner-passphrase-2026';
const status = { enabled: true, running: true, configured: true, version: 'offline', checkedAt: new Date().toISOString() };
const magpie: MagpieHost = {
  ensure: async () => status, status: async () => status,
  read: async () => { throw new Error('offline'); }, post: async () => { throw new Error('offline'); }, stop() {},
  scopeCapability: async () => true,
  codexSubscriptionBinding: async () => ({ instanceId: 'a'.repeat(32), providerId: 'codex', modelId: 'gpt-6.1-sol',
    accountRef: '0123456789abcdef', accountKind: 'codex-subscription' })
};
test('HTTP consent requires persistent MFA, CSRF, owner and exact budget; generic endpoints cannot bypass it', async t => {
  const root = mkdtempSync(join(tmpdir(), 'daming-web-consent-http-'));
  let sends = 0;
  const host = await startBoardHost({ dataDir: root, port: 0, bootstrapToken: 'offline-token-long-enough', magpie,
    codexSubscriptionTest: { run: async () => {
      sends++; return { status: 'completed', exitCode: 0, output: 'offline OK', events: [], usage: { input_tokens: 9 } };
    } } });
  t.after(async () => { await host.close(); rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });
  let cookie = '', csrf = '';
  const api = async (path: string, method = 'GET', body?: unknown, token = csrf) => {
    const res = await fetch(host.url + path, { method, redirect: 'manual', headers: { cookie,
      ...(method !== 'GET' ? { origin: host.url.slice(0, -1), 'content-type': 'application/json', 'x-daming-csrf': token } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const newCookie = res.headers.getSetCookie()[0]?.split(';')[0];
    if (newCookie) cookie = newCookie;
    return { status: res.status, data: await res.json().catch(() => ({})) as Record<string, any> };
  };
  await api('?token=offline-token-long-enough');
  csrf = (await api('api/session')).data.csrfToken;
  const path = 'api/codex-subscription/tasks';
  assert.equal((await api(path)).status, 403);
  const setup = await api('api/identity/setup', 'POST', { username: 'rootowner', password: PASS, tenantName: 'Owner' });
  csrf = setup.data.csrfToken;
  assert.equal((await api(path)).status, 403);
  const enroll = await api('api/identity/mfa/begin', 'POST', { password: PASS });
  assert.equal((await api('api/identity/mfa/confirm', 'POST', {
    code: totpCode(enroll.data.secret, Math.floor(Date.now() / 30000)) })).status, 200);
  const input = { requestId: 'http-request-one', prompt: 'Answer OK', limitMinor: 200 };
  assert.equal((await api(path, 'POST', input, 'wrong-csrf')).status, 403);
  assert.equal((await api(path, 'POST', { ...input, executable: 'untrusted' })).status, 400);
  const chinese = await api(path, 'POST', { ...input, requestId: 'chinese-request', prompt: '中文任务'.repeat(1000) });
  assert.equal(chinese.status, 201, '4000 Chinese characters must fit the dedicated HTTP request limit');
  assert.equal((await api(path + '/' + chinese.data.taskId + '/cancel', 'POST', {})).status, 200);
  const prepared = await api(path, 'POST', input);
  assert.equal(prepared.status, 201, JSON.stringify(prepared.data));
  const id = prepared.data.taskId;
  assert.equal(sends, 0);
  assert.equal((await api('api/tasks/' + id + '/approve', 'POST', {})).status, 409);
  assert.equal((await api(path + '/' + id + '/approve', 'POST', { approvedMaximumMinor: 201 })).status, 400);
  assert.equal(sends, 0);
  const approved = await api(path + '/' + id + '/approve', 'POST', { approvedMaximumMinor: 200 });
  assert.equal(approved.status, 202, JSON.stringify(approved.data));
  let detail = await api(path + '/' + id);
  for (let i = 0; i < 20 && detail.data.status !== 'blocked'; i++) detail = await api(path + '/' + id);
  assert.equal(detail.data.output, 'offline OK');
  assert.equal(detail.data.cashHeldMinor, 200);
  assert.equal((await api(path + '/' + id + '/approve', 'POST', { approvedMaximumMinor: 200 })).status, 409);
  assert.equal(sends, 1);
  assert.doesNotMatch(JSON.stringify(detail.data), /0123456789abcdef|instanceId|sessionHash/);
  const tenant = await api('api/identity/tenants', 'POST', { name: 'Other tenant' });
  const switched = await api('api/identity/switch-tenant', 'POST', { tenantId: tenant.data.tenantId });
  csrf = switched.data.csrfToken;
  assert.equal((await api(path + '/' + id)).status, 404);
  assert.equal((await api('api/tasks/' + id)).status, 404);
  const encodedId = '%' + id.charCodeAt(0).toString(16) + id.slice(1);
  assert.equal((await api('api/tasks/' + encodedId)).status, 404);
  assert.deepEqual((await api(path)).data.tasks, []);
});
