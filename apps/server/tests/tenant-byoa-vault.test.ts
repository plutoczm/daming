import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { IdentityRegistry } from '../src/identity-registry.ts';

const c = { protectMaster: (s: string) => 'test:' + s,
  unprotectMaster: (s: string) => s.slice(5) };
const secret = 'sk-independent-account-fixture-only-2026';

test('independent tenant vault never grants shared Magpie dispatch or leaks API keys', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daming-tenant-vault-'));
  let store = new IdentityRegistry(dir, c);
  try {
    const root = await store.setup({
      username: 'rootowner', password: 'fixture-root-owner-password-2026',
      tenantName: 'first tenant'
    });
    const a = root.session.identity;
    const tenant = store.createTenant(a, 'separate tenant');
    const b = store.switchTenant(a, tenant.tenantId, 'daming_identity=' + root.cookie)
      .session.identity;
    const first = store.registerIndependentAccount(a, {
      provider: 'deepseek', modelId: 'deepseek-chat',
      label: 'Private account A', apiKey: secret
    });
    assert.equal(first.magpieBindingVerified, false);
    assert.equal(first.vendorBillingOwnerVerified, false);
    assert.equal(first.productionDispatchEnabled, false);
    assert.equal(store.listIndependentAccounts(a).length, 1);
    assert.equal(store.listIndependentAccounts(b).length, 0);
    assert.equal(store.filterCatalog(a, {
      instanceId: '1234567890abcdef1234567890abcdef',
      checkedAt: new Date().toISOString(), candidates: []
    }).candidates.length, 0);
    assert.equal(store.productionReadiness(a).paidModelDispatchPermitted, false);
    assert.equal(store.productionReadiness(a).validKeyControlProofs, 1);
    assert.equal(store.productionReadiness(b).validKeyControlProofs, 0);
    assert.equal(store.independentAccountForVerification(b, first.credentialId), null);
    assert.throws(() => store.renewIndependentAccount(b, first.credentialId, secret),
      /tenant_api_key_mismatch/);
    assert.throws(() => store.registerIndependentAccount(b, {
      provider: 'deepseek', modelId: 'deepseek-chat',
      label: 'stolen', apiKey: secret
    }), /tenant_key_already_claimed/);
    assert.throws(() => store.renewIndependentAccount(a, first.credentialId,
      'different-api-key-fixture-2026'), /tenant_api_key_mismatch/);
    const renewed = store.renewIndependentAccount(a, first.credentialId, secret);
    assert.equal(renewed.credentialId, first.credentialId);
    store.close();
    store = new IdentityRegistry(dir, c);
    assert.equal(store.listIndependentAccounts(a).length, 1);
    assert.ok(!readFileSync(join(dir, 'identities.db')).includes(Buffer.from(secret)));
    store.revokeIndependentAccount(a, first.credentialId);
    assert.equal(store.listIndependentAccounts(a).length, 0);
    assert.throws(() => store.revokeIndependentAccount(b, first.credentialId),
      /tenant_account_not_found/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
});
