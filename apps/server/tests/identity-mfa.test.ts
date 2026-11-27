import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { IdentityRegistry } from '../src/identity-registry.ts';
import { createTotpSecret, totpCode, verifyTotp } from '../src/totp.ts';

const crypto = { protectMaster: (v: string) => 'fixture:' + v,
  unprotectMaster: (v: string) => v.slice(8) };
const PASS = 'long-unique-owner-passphrase-2026';

test('RFC 6238 TOTP matches SHA1 reference and rejects reused/outdated steps', () => {
  const knownBase32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(totpCode(knownBase32, 1), '287082');
  assert.equal(verifyTotp(knownBase32, '287082', 59000, -1), 1);
  assert.equal(verifyTotp(knownBase32, '287082', 59000, 1), null);
  assert.equal(verifyTotp(knownBase32, '287082', 200000, -1), null);
  assert.equal(verifyTotp(knownBase32, '00000x', 59000, -1), null);
  assert.equal(createTotpSecret().length, 32);
});

test('TOTP setup rotates old sessions; login needs OTP or one-time recovery and survives restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daming-mfa-'));
  let clock = 1762992900000;
  let db = new IdentityRegistry(dir, { ...crypto, clock: () => clock });
  try {
    const first = await db.setup({
      username: 'rootowner', password: PASS, tenantName: 'First workspace'
    });
    const previous = await db.login({ username: 'rootowner', password: PASS });
    assert.equal(db.hasMfa(first.session.identity), false);
    await assert.rejects(db.beginMfaEnrollment(first.session.identity,
      'daming_identity=' + first.cookie, 'incorrect-passphrase'), /mfa_reauthentication_required/);
    const enrolled = await db.beginMfaEnrollment(first.session.identity,
      'daming_identity=' + first.cookie, PASS);
    assert.match(enrolled.enrollmentUri, /^otpauth:\/\/totp\//);
    assert.equal(enrolled.secret.length, 32);
    assert.equal(db.hasMfa(first.session.identity), false);
    const tick = Math.floor(clock / 30000);
    assert.throws(() => db.confirmMfaEnrollment(
      first.session.identity, 'daming_identity=' + first.cookie, '123x56'
    ), /mfa_code_invalid/);
    const confirmed = db.confirmMfaEnrollment(first.session.identity,
      'daming_identity=' + first.cookie, totpCode(enrolled.secret, tick));
    assert.equal(confirmed.enabled, true);
    assert.equal(confirmed.recoveryCodes.length, 8);
    assert.equal(db.hasMfa(first.session.identity), true);
    assert.equal(db.getSession('daming_identity=' + previous.cookie), undefined);
    assert.ok(db.getSession('daming_identity=' + first.cookie));
    assert.ok(!readFileSync(join(dir, 'identities.db')).includes(Buffer.from(enrolled.secret)));
    assert.ok(!readFileSync(join(dir, 'identities.db')).includes(
      Buffer.from(confirmed.recoveryCodes[0])));
    await assert.rejects(db.login({ username: 'rootowner', password: PASS }), /mfa_code_required/);
    await assert.rejects(db.login({ username: 'rootowner', password: PASS,
      mfaCode: totpCode(enrolled.secret, tick) }), /identity_login_failed/);
    clock += 30000;
    const one = await db.login({ username: 'rootowner', password: PASS,
      mfaCode: totpCode(enrolled.secret, tick + 1) });
    assert.ok(db.getSession('daming_identity=' + one.cookie));
    await assert.rejects(db.login({ username: 'rootowner', password: PASS,
      mfaCode: totpCode(enrolled.secret, tick + 1) }), /identity_login_failed/);
    db.close();
    db = new IdentityRegistry(dir, { ...crypto, clock: () => clock });
    assert.ok(db.getSession('daming_identity=' + one.cookie));
    const rescued = await db.login({
      username: 'rootowner', password: PASS, mfaCode: confirmed.recoveryCodes[0]
    });
    assert.ok(db.getSession('daming_identity=' + rescued.cookie));
    await assert.rejects(db.login({
      username: 'rootowner', password: PASS, mfaCode: confirmed.recoveryCodes[0]
    }), /identity_login_failed/);
    assert.ok(db.auditFor(first.session.identity).some(row => row.event === 'identity.mfa.enabled'));
    assert.ok(db.auditFor(first.session.identity).some(row => row.event === 'identity.mfa.login'));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
});

test('unconfirmed enrollment expires and cannot be enabled or bypassed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daming-mfa-expire-'));
  let clock = 1762992900000;
  const db = new IdentityRegistry(dir, { ...crypto, clock: () => clock });
  try {
    const root = await db.setup({ username: 'rootowner', password: PASS, tenantName: 'Workspace' });
    const prepared = await db.beginMfaEnrollment(root.session.identity,
      'daming_identity=' + root.cookie, PASS);
    clock += 11 * 60 * 1000;
    assert.throws(() => db.confirmMfaEnrollment(root.session.identity,
      'daming_identity=' + root.cookie,
      totpCode(prepared.secret, Math.floor(clock / 30000))), /mfa_enrollment_expired/);
    assert.equal(db.hasMfa(root.session.identity), false);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
});
