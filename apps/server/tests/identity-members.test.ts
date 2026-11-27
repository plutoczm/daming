import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { IdentityRegistry } from '../src/identity-registry.ts';

const seal = {
  protectMaster: (value: string) => 'test:' + value,
  unprotectMaster: (value: string) => value.slice(5)
};

test('removing a member kills current sessions and leaves owner-only audit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daming-member-'));
  const registry = new IdentityRegistry(dir, seal);
  try {
    const admin = await registry.setup({ username: 'primary', password: 'primary-long-passphrase-2026',
      tenantName: 'Team' });
    const invite = registry.issueInvitation(admin.session.identity, 'operator');
    const member = await registry.enroll({ username: 'operator001', password: 'operator-long-passphrase-2026',
      invitationCode: invite.invitationCode });
    assert.ok(registry.getSession('daming_identity=' + member.cookie));
    assert.equal(registry.listMembers(admin.session.identity).length, 2);
    assert.throws(() => registry.removeMember(member.session.identity, admin.session.identity.userId),
      /tenant_owner_required/);
    assert.throws(() => registry.removeMember(admin.session.identity, admin.session.identity.userId),
      /cannot_remove_self/);
    registry.removeMember(admin.session.identity, member.session.identity.userId);
    assert.equal(registry.getSession('daming_identity=' + member.cookie), undefined);
    assert.equal(registry.listMembers(admin.session.identity).length, 1);
    const audit = registry.auditFor(admin.session.identity);
    assert.ok(audit.some(event => event.event === 'member.removed'));
    assert.ok(audit.some(event => event.event === 'member.invited'));
    assert.throws(() => registry.auditFor(member.session.identity), /tenant_owner_required/);
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
});

test('account revalidation is exact-key only; no second tenant can own one binding', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daming-reverify-'));
  const registry = new IdentityRegistry(dir, seal);
  try {
    const admin = await registry.setup({ username: 'primary', password: 'primary-long-passphrase-2026',
      tenantName: 'Team' });
    const owned = registry.registerAccount(admin.session.identity, {
      instanceId: '1234567890abcdef1234567890abcdef',
      candidate: { candidateId: 'x|m', providerId: 'x', modelId: 'm',
        accountRef: '12345abcde', accountType: 'single-api-key', accountLabel: 'one' },
      providerKind: 'openai', secret: 'mock-only-vendor-key-for-test', label: 'Primary key'
    });
    assert.ok(registry.accountForVerification(admin.session.identity, owned.credentialId));
    assert.throws(() => registry.reverifyAccount(admin.session.identity, owned.credentialId,
      'other-vendor-key-for-test'), /credential_reverification_denied/);
    const renewed = registry.reverifyAccount(admin.session.identity, owned.credentialId,
      'mock-only-vendor-key-for-test');
    assert.equal(renewed.credentialId, owned.credentialId);
    assert.equal(renewed.vendorBillingOwnerVerified, false);
    const newTenant = registry.createTenant(admin.session.identity, 'Other team');
    const changed = registry.switchTenant(admin.session.identity, newTenant.tenantId,
      'daming_identity=' + admin.cookie);
    assert.equal(registry.accountForVerification(changed.session.identity, owned.credentialId), null);
    assert.throws(() => registry.registerAccount(changed.session.identity, {
      instanceId: '1234567890abcdef1234567890abcdef',
      candidate: { candidateId: 'x|m', providerId: 'x', modelId: 'm',
        accountRef: '12345abcde', accountType: 'single-api-key', accountLabel: 'one' },
      providerKind: 'openai', secret: 'mock-only-vendor-key-for-test', label: 'Hijack'
    }), /credential_already_registered/);
    registry.revokeAccount(admin.session.identity, owned.credentialId);
    assert.ok(registry.auditFor(admin.session.identity).some(event => event.event === 'account.revoked'));
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
});
