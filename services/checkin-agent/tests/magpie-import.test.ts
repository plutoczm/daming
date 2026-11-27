import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckinPolicy } from '../../../packages/governance/src/index.ts';
import { LocalCredentialStore, importMagpieAccounts, importMagpieSources, listMagpieAccounts, listMagpieSources } from '../src/index.ts';

const sample = [
  { id: 'acc1', agent: 'workbuddy', user: 'me@x.com', auth: { tokens: { access_token: 'tok-123' } } },
  { id: 'acc2', agent: 'plugin:zcode', user: 'ZCode', auth: '' },
];

test('listMagpieAccounts reports secret presence without exposing secrets', () => {
  const listed = listMagpieAccounts(sample);
  assert.equal(listed.length, 2);
  assert.deepEqual(listed[0], { accountId: 'acc1', platform: 'workbuddy', user: 'me@x.com', hasSecret: true });
  assert.equal(listed[1].hasSecret, false);
  assert.equal(JSON.stringify(listed).includes('tok-123'), false, 'listing must not leak the secret');
});

test('importMagpieAccounts imports records with a secret into Daming own store + authorization', () => {
  const d = mkdtempSync(join(tmpdir(), 'daming-magpie-import-'));
  const store = new LocalCredentialStore({ dir: d, passphrase: 'passphrase-123' });
  const policy = new CheckinPolicy();
  const summary = importMagpieAccounts(sample, { store, policy, owner: 'windows', nowMs: 1000, include: ['workbuddy'] });
  assert.equal(summary.imported, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(store.get('acc1', 'workbuddy').secret.includes('tok-123'), true);
  assert.equal(policy.canAct('acc1', 'workbuddy', 'checkin', 'windows', 2000).allowed, true);
  rmSync(d, { recursive: true, force: true });
});

test('include filter excludes platforms not listed', () => {
  const d = mkdtempSync(join(tmpdir(), 'daming-magpie-import2-'));
  const store = new LocalCredentialStore({ dir: d, passphrase: 'passphrase-123' });
  const policy = new CheckinPolicy();
  const summary = importMagpieAccounts(sample, { store, policy, owner: 'linux', nowMs: 1000, include: ['trae'] });
  assert.equal(summary.imported, 0);
  assert.equal(summary.skipped, 2);
  rmSync(d, { recursive: true, force: true });
});

test('listMagpieSources merges plugin-auth.json (plugin accounts carry secrets there)', () => {
  const sources = {
    logins: [
      { id: 'codex1', agent: 'codex', user: 'me@x', auth: { tokens: { access_token: 'c' } } },
      { id: 'wb1', agent: 'plugin:workbuddy', user: '小白' }, // placeholder, no secret in logins
    ],
    pluginAuth: {
      workbuddy: { type: 'oauth', accountId: '小白', uid: 'u-1', access: 'at-1', refresh: 'rt-1' },
      'workbuddy#x2': { type: 'oauth', accountId: '小新', uid: 'u-2', access: 'at-2' },
      zcode: { type: 'oauth', accountId: 'ZCode', uid: 'u-z' },
    },
  };
  const listed = listMagpieSources(sources);
  const byKey = Object.fromEntries(listed.map((a) => [a.platform + '/' + a.accountId, a.hasSecret]));
  assert.equal(byKey['codex/codex1'], true);
  assert.equal(byKey['workbuddy/workbuddy'], true, 'plugin-auth workbuddy carries a secret');
  assert.equal(byKey['workbuddy/workbuddy_x2'], true);
  assert.equal(byKey['zcode/zcode'], true);
  assert.equal(JSON.stringify(listed).includes('at-1'), false, 'must not leak tokens');

  const d = mkdtempSync(join(tmpdir(), 'daming-magpie-src-'));
  const store = new LocalCredentialStore({ dir: d, passphrase: 'passphrase-123' });
  const policy = new CheckinPolicy();
  const summary = importMagpieSources(sources, { store, policy, owner: 'windows', nowMs: 1000, include: ['workbuddy'] });
  assert.equal(summary.imported, 2);
  assert.equal(store.get('workbuddy', 'workbuddy').secret.includes('at-1'), true);
  rmSync(d, { recursive: true, force: true });
});
