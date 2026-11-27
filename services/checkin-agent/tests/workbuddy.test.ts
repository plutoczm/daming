import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckinPolicy } from '../../../packages/governance/src/index.ts';
import { CheckinAgent, LocalCredentialStore, WorkBuddyPlatform } from '../src/index.ts';

type Resp = { status: number; body: unknown };
function server(routes: { status?: Resp; claim?: Resp }) {
  const seen: string[] = [];
  const srv = createServer((req, res) => {
    seen.push(String(req.url));
    let r: Resp | undefined;
    if (req.url?.endsWith('/checkin-activity-status')) r = routes.status ?? { status: 200, body: {} };
    else if (req.url?.endsWith('/daily-checkin')) r = routes.claim ?? { status: 200, body: {} };
    else { res.writeHead(404); res.end(); return; }
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r.body));
  });
  return new Promise<{ baseUrl: string; seen: string[]; close: () => Promise<void> }>((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      resolve({ baseUrl: 'http://127.0.0.1:' + port, seen, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}
const cred = { accountId: 'wb1', platform: 'workbuddy', owner: 'windows', secret: JSON.stringify({ access: 'tok-real', type: 'oauth' }) };

test('WorkBuddy: active & not checked -> claims (claimed + credits)', async () => {
  const s = await server({ status: { status: 200, body: { active: true, today_checked_in: false, streak_days: 5 } }, claim: { status: 200, body: { credit: 100, streak_days: 12 } } });
  try {
    const p = new WorkBuddyPlatform({ baseUrl: s.baseUrl });
    const r = await p.checkin(cred);
    assert.deepEqual(r, { kind: 'claimed', credits: 100 });
    assert.ok(s.seen.some((u) => u.includes('/daily-checkin')), 'must call daily-checkin');
  } finally { await s.close(); }
});

test('WorkBuddy: today already checked -> already, no claim call', async () => {
  const s = await server({ status: { status: 200, body: { active: true, today_checked_in: true, today_credit: 88 } } });
  try {
    const r = await new WorkBuddyPlatform({ baseUrl: s.baseUrl }).checkin(cred);
    assert.deepEqual(r, { kind: 'already', credits: 88 });
    assert.equal(s.seen.some((u) => u.includes('/daily-checkin')), false, 'must not claim when already in');
  } finally { await s.close(); }
});

test('WorkBuddy: 401 -> terms (needs official app, no bypass)', async () => {
  const s = await server({ status: { status: 401, body: {} } });
  try {
    const r = await new WorkBuddyPlatform({ baseUrl: s.baseUrl }).checkin(cred);
    assert.equal(r.kind, 'terms');
    assert.equal(typeof r.detail, 'string');
  } finally { await s.close(); }
});

test('WorkBuddy: claim code 1001 -> already; 1003 -> no_event', async () => {
  const s1 = await server({ status: { status: 200, body: { active: true, today_checked_in: false } }, claim: { status: 400, body: { code: 1001 } } });
  try { assert.equal((await new WorkBuddyPlatform({ baseUrl: s1.baseUrl }).checkin(cred)).kind, 'already'); } finally { await s1.close(); }
  const s2 = await server({ status: { status: 200, body: { active: true, today_checked_in: false } }, claim: { status: 400, body: { code: 1003 } } });
  try { assert.equal((await new WorkBuddyPlatform({ baseUrl: s2.baseUrl }).checkin(cred)).kind, 'no_event'); } finally { await s2.close(); }
});

test('WorkBuddy end-to-end via CheckinAgent (authorized account, claimed)', async () => {  const s = await server({ status: { status: 200, body: { active: true, today_checked_in: false } }, claim: { status: 200, body: { credit: 100 } } });
  const d = mkdtempSync(join(tmpdir(), 'daming-wb-'));
  try {
    const store = new LocalCredentialStore({ dir: d, passphrase: 'passphrase-123' });
    store.put({ accountId: 'wb1', platform: 'workbuddy', owner: 'windows', secret: JSON.stringify({ access: 'tok' }) });
    const policy = new CheckinPolicy();
    policy.authorize({ accountId: 'wb1', platform: 'workbuddy', owner: 'windows', actions: ['checkin'], frequency: 'daily', grantedAtMs: 1000 });
    const report = await new CheckinAgent({ policy, platform: new WorkBuddyPlatform({ baseUrl: s.baseUrl }), store, owner: 'windows' }).run(2000);
    assert.equal(report.items.find((i) => i.action === 'checkin')?.result, 'done');
    assert.equal(report.items.find((i) => i.action === 'checkin')?.outcome, 'claimed');
  } finally { await s.close(); rmSync(d, { recursive: true, force: true }); }
});

test('WorkBuddy readQuota: non-200 (needs device signing) returns no fabricated number', async () => {
  const s = await server({ status: { status: 200, body: {} } }); // /get-user-resource-summary hits 404 on this fixture -> non-200
  try {
    const q = await new WorkBuddyPlatform({ baseUrl: s.baseUrl }).readQuota(cred);
    assert.deepEqual(q, { platform: 'workbuddy' });
  } finally { await s.close(); }
});
