import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CheckinPolicy, evaluateOutcome } from '../src/index.ts';

const base = { accountId: 'stu-1', platform: 'school', owner: 'linux' as const, actions: ['checkin', 'quota.read'] as const, frequency: 'daily' as const, grantedAtMs: 1000 };

test('authorized account may act; unlisted account is denied', () => {
  const p = new CheckinPolicy();
  p.authorize({ ...base });
  assert.equal(p.canAct('stu-1', 'school', 'checkin', 'linux', 2000).allowed, true);
  assert.deepEqual(p.canAct('who', 'school', 'checkin', 'linux', 2000), { allowed: false, reason: 'not_authorized' });
});

test('revoked authorization yields no action (revoked)', () => {
  const p = new CheckinPolicy();
  p.authorize({ ...base });
  assert.equal(p.revoke('stu-1', 'school', 1500), true);
  assert.deepEqual(p.canAct('stu-1', 'school', 'checkin', 'linux', 2000), { allowed: false, reason: 'revoked' });
});

test('owner mismatch / action not authorized / expired are denied', () => {
  const p = new CheckinPolicy();
  p.authorize({ ...base, expiresAtMs: 5000 });
  assert.deepEqual(p.canAct('stu-1', 'school', 'checkin', 'windows', 2000), { allowed: false, reason: 'owner_mismatch' });
  assert.deepEqual(p.canAct('stu-1', 'school', 'checkin', 'linux', 6000), { allowed: false, reason: 'expired' });
  const q = new CheckinPolicy();
  q.authorize({ ...base, actions: ['quota.read'] });
  assert.deepEqual(q.canAct('stu-1', 'school', 'checkin', 'linux', 2000), { allowed: false, reason: 'action_not_authorized' });
});

test('daily frequency: second run same day is limited once acted', () => {
  const p = new CheckinPolicy();
  p.authorize({ ...base });
  assert.equal(p.canAct('stu-1', 'school', 'checkin', 'linux', 2000).allowed, true);
  p.markActed('stu-1', 'school', 2000);
  assert.deepEqual(p.canAct('stu-1', 'school', 'checkin', 'linux', 3000), { allowed: false, reason: 'frequency_limit' });
  assert.equal(p.canAct('stu-1', 'school', 'checkin', 'linux', 2000 + 24 * 60 * 60 * 1000).allowed, true);
});

test('captcha/terms require human and never auto-retry; claimed is ok', () => {
  assert.deepEqual(evaluateOutcome('captcha'), { status: 'needs_human', autoRetry: false });
  assert.deepEqual(evaluateOutcome('terms'), { status: 'needs_human', autoRetry: false });
  assert.deepEqual(evaluateOutcome('claimed'), { status: 'ok', autoRetry: false });
  assert.deepEqual(evaluateOutcome('failed'), { status: 'failed', autoRetry: false });
});
