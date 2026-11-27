import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckinPolicy } from '../../../packages/governance/src/index.ts';
import { CheckinAgent, HttpCheckinPlatform, LocalCredentialStore, SimulatedPlatform } from '../src/index.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'daming-checkin-'));
const auth = (over: Partial<Record<string, unknown>> = {}) => ({
  accountId: 'stu-1', platform: 'school', owner: 'linux' as const,
  actions: ['checkin', 'quota.read'] as const, frequency: 'manual' as const, grantedAtMs: 1000, ...over,
});

test('authorized read-only check-in + quota; daily frequency limits a second run', async () => {
  const d = dir();
  const store = new LocalCredentialStore({ dir: d, passphrase: 'passphrase-123' });
  store.put({ accountId: 'stu-1', platform: 'school', owner: 'linux', secret: 'tok-abc' });
  const policy = new CheckinPolicy();
  policy.authorize(auth({ frequency: 'daily' }));
  const platform = new SimulatedPlatform({ outcomes: ['claimed'] });
  const agent = new CheckinAgent({ policy, platform, store, owner: 'linux' });
  const r1 = await agent.run(2000);
  assert.equal(platform.calls.length, 1);
  assert.equal(r1.items.find((i) => i.action === 'checkin')?.result, 'done');
  const r2 = await agent.run(3000);
  assert.equal(platform.calls.length, 1, 'second same-day run must not call the platform');
  assert.equal(r2.items.find((i) => i.action === 'checkin')?.reason, 'frequency_limit');
  rmSync(d, { recursive: true, force: true });
});

test('revoke yields NO platform action', async () => {
  const d = dir();
  const store = new LocalCredentialStore({ dir: d, passphrase: 'passphrase-123' });
  store.put({ accountId: 'stu-1', platform: 'school', owner: 'linux', secret: 'tok-abc' });
  const policy = new CheckinPolicy();
  policy.authorize(auth());
  policy.revoke('stu-1', 'school', 1500);
  const platform = new SimulatedPlatform();
  const report = await new CheckinAgent({ policy, platform, store, owner: 'linux' }).run(2000);
  assert.equal(platform.calls.length, 0, 'revoked account must not be acted on');
  assert.equal(report.items.find((i) => i.action === 'checkin')?.reason, 'revoked');
  rmSync(d, { recursive: true, force: true });
});

test('captcha is handed to the human, never solved or retried', async () => {
  const d = dir();
  const store = new LocalCredentialStore({ dir: d, passphrase: 'passphrase-123' });
  store.put({ accountId: 'stu-1', platform: 'school', owner: 'linux', secret: 'tok-abc' });
  const policy = new CheckinPolicy();
  policy.authorize(auth({ actions: ['checkin'] }));
  const platform = new SimulatedPlatform({ outcomes: ['captcha'] });
  const report = await new CheckinAgent({ policy, platform, store, owner: 'linux' }).run(2000);
  assert.equal(platform.calls.length, 1);
  assert.deepEqual(report.needsHuman, [{ accountId: 'stu-1', platform: 'school', reason: 'captcha' }]);
  assert.equal(report.items.find((i) => i.action === 'checkin')?.result, 'needs_human');
  rmSync(d, { recursive: true, force: true });
});

test('owner mismatch leaves the account untouched', async () => {
  const d = dir();
  const store = new LocalCredentialStore({ dir: d, passphrase: 'passphrase-123' });
  store.put({ accountId: 'stu-1', platform: 'school', owner: 'windows', secret: 'tok-abc' });
  const policy = new CheckinPolicy();
  policy.authorize(auth({ owner: 'windows' }));
  const platform = new SimulatedPlatform();
  const report = await new CheckinAgent({ policy, platform, store, owner: 'linux' }).run(2000);
  assert.equal(platform.calls.length, 0);
  assert.equal(report.items[0].reason, 'owner_mismatch');
  rmSync(d, { recursive: true, force: true });
});

test('credential store encrypts at rest and rejects a wrong passphrase', () => {
  const d = dir();
  const store = new LocalCredentialStore({ dir: d, passphrase: 'passphrase-123' });
  store.put({ accountId: 'stu-1', platform: 'school', owner: 'linux', secret: 'plaintext-secret-xyz' });
  assert.equal(store.get('stu-1', 'school').secret, 'plaintext-secret-xyz');
  const file = join(d, readdirSync(d).find((n) => n.endsWith('.enc'))!);
  const blob = readFileSync(file);
  assert.equal(blob.toString('utf8').includes('plaintext-secret-xyz'), false, 'secret must not be stored in plaintext');
  const wrong = new LocalCredentialStore({ dir: d, passphrase: 'different-pass-999' });
  assert.throws(() => wrong.get('stu-1', 'school'), /checkin_credential_decrypt_failed/);
  rmSync(d, { recursive: true, force: true });
});

test('end-to-end against a local HTTP platform (real network path, simulated platform)', async () => {
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/checkin') {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ kind: 'claimed', credits: 10 }));
    } else if (req.method === 'GET' && req.url && req.url.startsWith('/quota')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ remainingMinor: 800, unit: 'credits' }));
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const d = dir();
    const store = new LocalCredentialStore({ dir: d, passphrase: 'passphrase-123' });
    store.put({ accountId: 'stu-1', platform: 'school', owner: 'linux', secret: 'tok-abc' });
    const policy = new CheckinPolicy();
    policy.authorize(auth());
    const agent = new CheckinAgent({ policy, platform: new HttpCheckinPlatform({ baseUrl: 'http://127.0.0.1:' + port }), store, owner: 'linux' });
    const report = await agent.run(2000);
    const checkinItem = report.items.find((i) => i.action === 'checkin');
    const quotaItem = report.items.find((i) => i.action === 'quota.read');
    assert.equal(checkinItem?.result, 'done');
    assert.equal(checkinItem?.outcome, 'claimed');
    assert.equal(quotaItem?.quota?.remainingMinor, 800);
    rmSync(d, { recursive: true, force: true });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
