import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LuluConnector, createLuluApproval, luluSubmitBody
} from '../src/index.ts';
import type { LuluSubmitInput } from '../src/index.ts';
import { startFakeLulu } from './helpers.ts';

const NOW = Date.parse('2026-11-10T00:00:00Z');
const SECRET = 'lulu-test-approval-secret-0123456789';
const INPUT: LuluSubmitInput = {
  platform: 'web', conversationId: 'conversation-1', personId: 'person-1', accountId: 'account-1',
  userAlias: '我', otherAlias: '对方', relationshipStage: '朋友', goal: '礼貌回复',
  userStyle: '简洁', messages: [{ sender: 'other', text: '周末有空吗？', time: '2026-11-10T08:00:00+08:00' }]
};

async function fakeSubmitServer(t: Parameters<typeof startFakeLulu>[0]) {
  return await startFakeLulu(t, (request, response) => {
    if (request.url !== '/api/ai/coach/suggest/quick') { response.statusCode = 404; response.end(); return; }
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ needsClarification: false, aggressive: 'A', normal: 'B', conservative: 'C' }));
  });
}

test('Lulu submit requires an explicit signed approval and never infers it from task existence', async (t) => {
  const fake = await fakeSubmitServer(t);
  const connector = new LuluConnector({ baseUrl: fake.url, sessionCookie: 'valid-session', approvalSecret: SECRET, now: () => NOW });
  assert.deepEqual(await connector.submit(INPUT, undefined), { status: 'rejected', reason: 'approval_required' });
  assert.equal(fake.requests.length, 0);
});

test('Lulu submit rejects expired, changed, wrong-target and tampered approvals before HTTP', async (t) => {
  const fake = await fakeSubmitServer(t);
  const connector = new LuluConnector({ baseUrl: fake.url, sessionCookie: 'valid-session', approvalSecret: SECRET, now: () => NOW });
  const base = { taskId: 'task-1', target: fake.url, expiresAtMs: NOW + 60000, nonce: 'nonce-001', secret: SECRET };
  const valid = createLuluApproval(INPUT, base);

  const expired = createLuluApproval(INPUT, { ...base, expiresAtMs: NOW - 1 });
  assert.deepEqual(await connector.submit(INPUT, expired), { status: 'rejected', reason: 'approval_expired' });

  const wrongTarget = createLuluApproval(INPUT, { ...base, target: 'http://127.0.0.1:9/api' });
  assert.deepEqual(await connector.submit(INPUT, wrongTarget), { status: 'rejected', reason: 'target_mismatch' });

  const changedInput: LuluSubmitInput = { ...INPUT, messages: [{ sender: 'other', text: 'changed' }] };
  assert.deepEqual(await connector.submit(changedInput, valid), { status: 'rejected', reason: 'request_changed' });

  assert.deepEqual(await connector.submit(INPUT, { ...valid, signature: '0'.repeat(64) }), { status: 'rejected', reason: 'signature_invalid' });
  assert.equal(fake.requests.length, 0);
});

test('Lulu submit sends exactly the approved body once and keeps status/evidence', async (t) => {
  const fake = await fakeSubmitServer(t);
  const connector = new LuluConnector({ baseUrl: fake.url, sessionCookie: 'valid-session', approvalSecret: SECRET, now: () => NOW });
  const approval = createLuluApproval(INPUT, { taskId: 'task-1', target: fake.url, expiresAtMs: NOW + 60000, nonce: 'nonce-001', secret: SECRET });
  const result = await connector.submit(INPUT, approval);
  assert.equal(result.status, 'completed');
  assert.equal(result.runId, 'nonce-001');
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].method, 'POST');
  assert.equal(fake.requests[0].url, '/api/ai/coach/suggest/quick');
  assert.equal(fake.requests[0].headers.cookie, 'LULU_SESSION=valid-session');
  assert.equal(fake.requests[0].headers['x-lulu-request-id'], 'nonce-001');
  assert.deepEqual(JSON.parse(fake.requests[0].body), luluSubmitBody(INPUT));
  assert.deepEqual(connector.status('nonce-001'), { status: 'completed', evidence: { needsClarification: false, aggressive: 'A', normal: 'B', conservative: 'C' } });
  assert.deepEqual(connector.evidence('nonce-001'), { needsClarification: false, aggressive: 'A', normal: 'B', conservative: 'C' });
  assert.deepEqual(connector.status('missing'), { status: 'unknown' });
});

test('Lulu auth rejection and outage are returned without throwing', async (t) => {
  const rejected = await startFakeLulu(t, (_request, response) => { response.statusCode = 401; response.end(); });
  const connector = new LuluConnector({ baseUrl: rejected.url, sessionCookie: 'valid-session', approvalSecret: SECRET, now: () => NOW });
  const approval = createLuluApproval(INPUT, { taskId: 'task-1', target: rejected.url, expiresAtMs: NOW + 60000, nonce: 'nonce-001', secret: SECRET });
  assert.deepEqual(await connector.submit(INPUT, approval), { status: 'unauthorized', reason: 'lulu_auth_rejected' });

  const dead = await startFakeLulu(t, (_request, response) => { response.statusCode = 200; response.end('{}'); });
  await dead.close();
  const offline = new LuluConnector({ baseUrl: dead.url, sessionCookie: 'valid-session', approvalSecret: SECRET, timeoutMs: 50, now: () => NOW });
  const offlineApproval = createLuluApproval(INPUT, { taskId: 'task-1', target: dead.url, expiresAtMs: NOW + 60000, nonce: 'nonce-002', secret: SECRET });
  assert.equal((await offline.submit(INPUT, offlineApproval)).status, 'unavailable');
});
