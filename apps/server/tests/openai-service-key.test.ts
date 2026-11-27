import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { IdentityRegistry } from '../src/identity-registry.ts';
import { issueOpenAiProjectServiceKey } from '../src/openai-service-key.ts';
import type { OpenAiAdminTransport } from '../src/openai-service-key.ts';

const PROJECT = 'proj_fake2026';
const SERVICE = 'svc_acct_fake2026';
const ADMIN = 'sk-admin-fixture-no-real-access-2026';
const SECRET = 'sk-service-account-issued-fixture-2026';
const requestId = () => randomUUID();
const NOW = Date.UTC(2026, 10, 12, 14, 0, 0);
const issuer = (): { transport: OpenAiAdminTransport; calls: string[] } => {
  const calls: string[] = [];
  const transport: OpenAiAdminTransport = async (method, path, key, body) => {
    calls.push(method + ' ' + path);
    assert.equal(key, ADMIN);
    if (method === 'GET' && path.endsWith('/' + PROJECT)) {
      return { object: 'organization.project', id: PROJECT };
    }
    if (method === 'GET' && path.endsWith('/' + SERVICE)) {
      return { object: 'organization.project.service_account', role: 'member', id: SERVICE };
    }
    if (method === 'POST' && path.endsWith('/api_keys')) {
      assert.deepEqual(body?.scopes, ['api.responses.write']);
      assert.equal(body?.expires_in_seconds, 3600);
      return {
        object: 'organization.project.service_account.api_key',
        id: 'key_fake2026', value: SECRET,
        created_at: Math.floor(NOW / 1000),
        expires_at: Math.floor(NOW / 1000) + 3600
      };
    }
    throw new Error('unexpected test request');
  };
  return { transport, calls };
};

test('official Admin API project service key issue is scoped, never treated as invoice/cash cap', async () => {
  const io = issuer();
  const issued = await issueOpenAiProjectServiceKey({
    adminKey: ADMIN, projectId: PROJECT, serviceAccountId: SERVICE,
    requestId: requestId()
  }, io.transport, () => NOW);
  assert.equal(io.calls.length, 3);
  assert.ok(io.calls[2].endsWith('/api_keys'));
  assert.equal(issued.officialProjectIssuanceVerified, true);
  assert.equal(issued.vendorBillingOwnerVerified, false);
  assert.equal(issued.invoiceReconciled, false);
  assert.equal(issued.guaranteedCashCap, false);
  assert.equal(issued.paidDispatchPermitted, false);
  assert.equal(issued.secret, SECRET);
  const invalid = issuer();
  await assert.rejects(issueOpenAiProjectServiceKey({
    adminKey: ADMIN, projectId: 'http://attacker.invalid',
    serviceAccountId: SERVICE, requestId: requestId()
  }, invalid.transport, () => NOW), /openai_service_key_input_invalid/);
  assert.equal(invalid.calls.length, 0, 'host/path injection cannot reach HTTP');
});

test('wrong project or service role prevents official key creation', async () => {
  let wrote = false;
  await assert.rejects(issueOpenAiProjectServiceKey({
    adminKey: ADMIN, projectId: PROJECT,
    serviceAccountId: SERVICE, requestId: requestId()
  }, async (method, path) => {
    if (method === 'POST') wrote = true;
    return path.endsWith(PROJECT) ? {
      object: 'organization.project', id: 'proj_DIFFERENT'
    } : {};
  }, () => NOW), /openai_admin_project_not_verified/);
  assert.equal(wrote, false);
  await assert.rejects(issueOpenAiProjectServiceKey({
    adminKey: ADMIN, projectId: PROJECT,
    serviceAccountId: SERVICE, requestId: requestId()
  }, async (method, path) => {
    if (method === 'POST') wrote = true;
    return path.endsWith(PROJECT)
      ? { object: 'organization.project', id: PROJECT }
      : { object: 'organization.project.service_account',
          role: 'none', id: SERVICE };
  }, () => NOW), /openai_service_account_role_not_verified/);
  assert.equal(wrote, false);
});

test('journal is single-use, persists a sealed project key and cannot cross tenants', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daming-openai-admin-key-'));
  let now = NOW;
  const seal = { protectMaster: (v: string) => 'fixture:' + v,
    unprotectMaster: (v: string) => v.slice(8), clock: () => now };
  let store = new IdentityRegistry(dir, seal);
  try {
    const root = await store.setup({
      username: 'rootowner', password: 'secure-root-passphrase-fixture-2026',
      tenantName: 'primary'
    });
    const a = root.session.identity;
    const tenantB = store.createTenant(a, 'Other');
    const b = store.switchTenant(a, tenantB.tenantId, 'daming_identity=' + root.cookie)
      .session.identity;
    const req = requestId();
    const input = { requestId: req, projectId: PROJECT,
      serviceAccountId: SERVICE, modelId: 'gpt-test' };
    store.beginOpenAiKeyIssuance(a, input);
    assert.throws(() => store.beginOpenAiKeyIssuance(a, input),
      /openai_issuance_id_already_used/);
    assert.throws(() => store.beginOpenAiKeyIssuance(b, input),
      /openai_issuance_id_already_used/);
    const issued = await issueOpenAiProjectServiceKey({
      adminKey: ADMIN, projectId: PROJECT, serviceAccountId: SERVICE,
      requestId: req
    }, issuer().transport, () => NOW);
    const saved = store.completeOpenAiKeyIssuance(a, req, issued);
    assert.equal(saved.officialProjectIssuanceVerified, true);
    assert.equal(saved.vendorBillingOwnerVerified, false);
    assert.equal(saved.guaranteedCashCap, false);
    assert.equal(saved.productionDispatchEnabled, false);
    assert.throws(() => store.completeOpenAiKeyIssuance(a, req, issued),
      /openai_issuance_not_authorized_or_replayed/);
    assert.equal(store.listOpenAiKeyIssuances(a).length, 1);
    assert.deepEqual(store.listOpenAiKeyIssuances(b), []);
    assert.equal(store.listIndependentAccounts(b).length, 0);
    const ownAccount = store.listIndependentAccounts(a)[0];
    assert.equal(ownAccount.credentialId, saved.credentialId);
    assert.equal(ownAccount.expiresAt, new Date(NOW + 3600000).toISOString());
    assert.equal(store.productionReadiness(a).paidModelDispatchPermitted, false);
    const dbContent = readFileSync(join(dir, 'identities.db'));
    assert.ok(!dbContent.includes(Buffer.from(SECRET)));
    assert.ok(!dbContent.includes(Buffer.from(ADMIN)));
    store.close();
    store = new IdentityRegistry(dir, seal);
    assert.equal(store.listOpenAiKeyIssuances(a)[0].status, 'issued');
    assert.equal(store.listIndependentAccounts(a).length, 1);

    const uncertainId = requestId();
    store.beginOpenAiKeyIssuance(a, {
      requestId: uncertainId, projectId: 'proj_second2026',
      serviceAccountId: SERVICE, modelId: 'gpt-test'
    });
    store.close();
    store = new IdentityRegistry(dir, seal);
    assert.equal(store.listOpenAiKeyIssuances(a).find(item =>
      item.requestId === uncertainId)?.status, 'uncertain');
    assert.throws(() => store.beginOpenAiKeyIssuance(a, {
      requestId: requestId(), projectId: 'proj_second2026',
      serviceAccountId: SERVICE, modelId: 'gpt-test'
    }), /openai_prior_issuance_requires_reconciliation/);
    now += 3600001;
    assert.ok(store.listIndependentAccounts(a)[0].expiresAt <= new Date(now).toISOString());
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
