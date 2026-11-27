import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { IdentityRegistry } from '../src/identity-registry.ts';
import { proveExactMagpieCredential } from '../src/magpie-owner-proof.ts';
import { projectMagpieRoutingCatalog } from '../src/magpie-routing.ts';

const PASSWORD = 'very-long-unique-passphrase-alpha-001!';
const OTHER_PASSWORD = 'second-unique-passphrase-beta-002!';
const INSTANCE = '1234567890abcdef1234567890abcdef';
const API_KEY = 'sk-fixture-only-test-key-012345';
const REF = createHash('sha256').update(API_KEY).digest('hex').slice(0, 10);
const fixtureCrypto = {
  protectMaster: (plain: string) => 'fixture:' + plain,
  unprotectMaster: (stored: string) => stored.replace(/^fixture:/, '')
};
const raw = {
  providers: [{
    id: 'openai', name: 'OpenAI synthetic',
    chat: 'https://api.openai.com/v1', key: API_KEY, models: ['gpt-test'],
    ready: true, keyList: [{ id: REF, on: true }]
  }]
};
function mk() { return mkdtempSync(join(tmpdir(), 'daming-identity-')); }

test('Magpie key proof requires full secret match, official endpoint and no symlink', () => {
  const dir = mk();
  const root = join(dir, 'config', 'magpie');
  mkdirSync(root, { recursive: true });
  try {
    writeFileSync(join(root, 'providers.json'), JSON.stringify(raw));
    const binding = { instanceId: INSTANCE, providerId: 'openai', accountRef: REF };
    assert.equal(proveExactMagpieCredential(join(dir, 'config'), binding, 'openai', API_KEY), true);
    assert.equal(proveExactMagpieCredential(join(dir, 'config'), binding, 'openai', API_KEY + 'x'), false);
    assert.equal(proveExactMagpieCredential(join(dir, 'config'), { ...binding, accountRef: 'ffffffffff' }, 'openai', API_KEY), false);
    assert.equal(proveExactMagpieCredential(join(dir, 'config'), binding, 'deepseek', API_KEY), false);
    writeFileSync(join(root, 'providers.json'), JSON.stringify({
      providers: [{ ...raw.providers[0], chat: 'https://evil.example/v1' }]
    }));
    assert.equal(proveExactMagpieCredential(join(dir, 'config'), binding, 'openai', API_KEY), false);
    writeFileSync(join(root, 'providers.json'), JSON.stringify({
      providers: [{ ...raw.providers[0], fallback: ['unapproved/model'] }]
    }));
    assert.equal(proveExactMagpieCredential(join(dir, 'config'), binding, 'openai', API_KEY), false);
    writeFileSync(join(root, 'providers.json'), JSON.stringify({
      providers: [{ ...raw.providers[0], proxy: 'http://127.0.0.1:9999' }]
    }));
    assert.equal(proveExactMagpieCredential(join(dir, 'config'), binding, 'openai', API_KEY), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('persistent local identity, role membership, invitation and session revocation', async () => {
  const dir = mk();
  let clock = Date.now();
  let registry = new IdentityRegistry(dir, { ...fixtureCrypto, clock: () => clock });
  try {
    assert.equal(registry.initialized(), false);
    const first = await registry.setup({ username: 'admin001', password: PASSWORD, tenantName: 'First tenant' });
    assert.equal(registry.initialized(), true);
    assert.equal(first.session.identity.rootAdministrator, true);
    assert.equal(first.session.identity.memberRole, 'owner');
    assert.throws(() => registry.issueInvitation({ ...first.session.identity, memberRole: 'viewer' }, 'operator'), /tenant_owner_required/);
    await assert.rejects(() => registry.setup({
      username: 'hijacker', password: OTHER_PASSWORD, tenantName: 'Hacked tenant'
    }), /identity_already_initialized/);
    await assert.rejects(() => registry.login({ username: 'admin001', password: 'incorrect-long-password' }), /identity_login_failed/);
    assert.equal(registry.getSession('daming_identity=' + first.cookie)?.identity.userId, first.session.identity.userId);
    const { invitationCode } = registry.issueInvitation(first.session.identity, 'viewer');
    const member = await registry.enroll({
      username: 'viewer001', password: OTHER_PASSWORD, invitationCode
    });
    assert.equal(member.session.identity.memberRole, 'viewer');
    assert.equal(member.session.role, 'readonly');
    assert.equal(member.session.identity.tenantId, first.session.identity.tenantId);
    await assert.rejects(() => registry.enroll({
      username: 'viewer002', password: OTHER_PASSWORD, invitationCode
    }), /invitation_invalid/);
    const ownTenant = registry.createTenant(first.session.identity, 'Other tenant');
    assert.ok(ownTenant.tenantId !== first.session.identity.tenantId);
    assert.equal(registry.listTenants(member.session.identity).length, 1);
    assert.throws(() => registry.switchTenant(member.session.identity, ownTenant.tenantId, 
      'daming_identity=' + member.cookie), /tenant_membership_required/);
    const switched = registry.switchTenant(first.session.identity, ownTenant.tenantId,
      'daming_identity=' + first.cookie);
    assert.equal(registry.getSession('daming_identity=' + first.cookie), undefined);
    assert.equal(switched.session.identity.tenantId, ownTenant.tenantId);
    assert.equal(switched.session.identity.rootAdministrator, true);
    registry.logout('daming_identity=' + switched.cookie);
    assert.equal(registry.getSession('daming_identity=' + switched.cookie), undefined);
    registry.close();
    registry = new IdentityRegistry(dir, { ...fixtureCrypto, clock: () => clock });
    assert.equal(registry.initialized(), true);
    const logged = await registry.login({ username: 'admin001', password: PASSWORD });
    assert.equal(logged.session.identity.username, 'admin001');
    assert.equal(registry.getSession('daming_identity=' + member.cookie)?.identity.memberRole, 'viewer');
    assert.ok(!readFileSync(join(dir, 'identities.db')).includes(Buffer.from(PASSWORD)));
  } finally { registry.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 }); }
});

test('password lockout persists across restart and expired sessions become invalid', async () => {
  const dir = mk();
  let clock = Date.now();
  let registry = new IdentityRegistry(dir, { ...fixtureCrypto, clock: () => clock });
  try {
    await registry.setup({ username: 'admin001', password: PASSWORD, tenantName: 'Secure tenant' });
    for (let i = 0; i < 5; i++) {
      await assert.rejects(registry.login({ username: 'admin001', password: OTHER_PASSWORD }), /identity_login_failed/);
    }
    await assert.rejects(registry.login({ username: 'admin001', password: PASSWORD }), /identity_login_delayed/);
    registry.close();
    registry = new IdentityRegistry(dir, { ...fixtureCrypto, clock: () => clock });
    await assert.rejects(registry.login({ username: 'admin001', password: PASSWORD }), /identity_login_delayed/);
    clock += 16 * 60 * 1000;
    const opened = await registry.login({ username: 'admin001', password: PASSWORD });
    assert.ok(registry.getSession('daming_identity=' + opened.cookie));
    clock += 13 * 60 * 60 * 1000;
    assert.equal(registry.getSession('daming_identity=' + opened.cookie), undefined);
  } finally { registry.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 }); }
});

test('BYOA account proof binds one tenant to exact key, stores only ciphertext and fails closed after revocation', async () => {
  const dir = mk();
  const registry = new IdentityRegistry(dir, fixtureCrypto);
  try {
    const owner = await registry.setup({
      username: 'owner001', password: PASSWORD, tenantName: 'Owner tenant'
    });
    const alternateTenant = registry.createTenant(owner.session.identity, 'Second tenant');
    const alt = registry.switchTenant(owner.session.identity, alternateTenant.tenantId,
      'daming_identity=' + owner.cookie);
    const route = projectMagpieRoutingCatalog(raw, INSTANCE);
    const candidate = route.candidates[0];
    assert.ok(candidate);
    assert.equal(candidate.accountRef, REF);
    const input = { candidate, instanceId: INSTANCE, providerKind: 'openai' as const,
      label: 'My vendor key', secret: API_KEY };
    const item = registry.registerAccount(owner.session.identity, input);
    assert.equal(item.vendorBillingOwnerVerified, false);
    assert.equal(item.productionDispatchEnabled, false);
    assert.equal(item.accountRef, '[private]');
    assert.ok(registry.hasVerifiedBinding(owner.session.identity, candidate, INSTANCE));
    assert.equal(registry.filterCatalog(alt.session.identity, route).candidates.length, 0);
    assert.equal(registry.filterCatalog(owner.session.identity, route).candidates.length, 1);
    assert.throws(() => registry.registerAccount(alt.session.identity, input), /credential_already_registered/);
    assert.ok(!readFileSync(join(dir, 'identities.db')).includes(Buffer.from(API_KEY)));
    assert.equal(registry.listAccounts(owner.session.identity).length, 1);
    assert.equal(registry.listAccounts(alt.session.identity).length, 0);
    const missionId = randomUUID();
    registry.bindMission(owner.session.identity, missionId);
    assert.equal(registry.ownsMission(owner.session.identity, missionId), true);
    assert.equal(registry.ownsMission(alt.session.identity, missionId), false);
    assert.throws(() => registry.assertMission(alt.session.identity, missionId), /mission_not_found/);
    registry.revokeAccount(owner.session.identity, item.credentialId);
    assert.equal(registry.hasVerifiedBinding(owner.session.identity, candidate, INSTANCE), false);
    assert.equal(registry.filterCatalog(owner.session.identity, route).candidates.length, 0);
    assert.throws(() => registry.revokeAccount(alt.session.identity, item.credentialId), /credential_not_found/);
  } finally { registry.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 }); }
});

test('fixed local machine owner: single account, MFA-exempt, auto session across restarts', async () => {
  const dir = mk();
  let registry = new IdentityRegistry(dir, fixtureCrypto);
  try {
    assert.equal(registry.initialized(), false);
    await registry.ensureLocalOwner();
    assert.equal(registry.initialized(), true);
    const opened = registry.openLocalOwnerSession();
    assert.equal(opened.session.identity.rootAdministrator, true);
    assert.equal(opened.session.identity.memberRole, 'owner');
    assert.equal(opened.session.identity.localMachine, true);
    // The machine owner needs no TOTP: every gate that asks hasMfa sees true.
    assert.equal(registry.hasMfa(opened.session.identity), true);
    const userId = opened.session.identity.userId;
    registry.close();
    // Restart: the same fixed user is reused, never a second administrator.
    registry = new IdentityRegistry(dir, fixtureCrypto);
    await registry.ensureLocalOwner();
    const reopened = registry.openLocalOwnerSession();
    assert.equal(reopened.session.identity.userId, userId);
    assert.equal(reopened.session.identity.localMachine, true);
    assert.equal(reopened.session.identity.tenantId, opened.session.identity.tenantId);
  } finally { registry.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 }); }
});
