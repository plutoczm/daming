import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import { ConflictError, Engine } from '@daming/core';
import { ProjectSpendLedger } from '@daming/governance';
import type { ProjectSendIntent } from '@daming/governance';
import { SqliteStore } from '@daming/store-sqlite';
import { ProjectControl } from '../src/project-control.ts';
import { ProjectPaidEgress } from '../src/trusted-paid-egress.ts';
import { withGovernedProjectMagpieTurn } from '../src/magpie-governed-route.ts';
import { withPinnedMagpieTurn } from '../src/magpie-codex-turn.ts';
import type { MagpieHost } from '../src/magpie-host.ts';

const now = Date.parse('2026-11-18T00:00:00Z');
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'daming project spend '));
  const file = join(dir, 'data.sqlite');
  let store = new SqliteStore(file);
  const engine = new Engine(store, store);
  engine.executeProject({
    type: 'create_project', projectId: 'project', eventId: 'create', expectedRevision: 0, at: new Date(now).toISOString(),
    goal: 'Deliver', ownerId: 'owner', documents: {
      spec: [{ id: 'a', text: 'Spec' }], plan: [{ id: 'p', text: 'Plan' }],
      acceptance: [{ id: 'c', text: 'Checks' }],
    },
  });
  const make = () => new ProjectSpendLedger(store, () => now);
  const ledger = make();
  ledger.initializeBudget('project', 1000);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { ledger, engine, reopen: () => { store.close(); store = new SqliteStore(file); return make(); } };
}

function intent(sendId: string): ProjectSendIntent {
  return {
    projectId: 'project', taskId: 'task', attemptId: 'attempt', epoch: 0, sendId,
    provider: 'provider', accountRef: 'isolated-account', model: 'model',
    protocol: 'websocket', requestDigest: 'request-bytes-ref',
    quote: { maximumCashMinor: 200, basisRef: 'verified price', enforcementRef: 'bounded request',
      source: 'fixed_tariff', expiresMs: now + 60_000 },
  };
}

test('complete responses retain their maximum until trusted cash confirmation, including across restart', t => {
  const { ledger, reopen } = fixture(t);
  const first = intent('one');
  ledger.reserveProjectSend(first);
  ledger.consumeProjectSend(first);
  ledger.recordProjectSendOutcome('project', 'one', {
    kind: 'completed', estimatedCashMinor: 1, reference: 'terminal response',
  });
  assert.equal(ledger.budget('project')?.heldMinor, 200);
  const next = reopen();
  next.reserveProjectSend(intent('two'));
  assert.equal(next.budget('project')?.heldMinor, 400);
  next.confirmProjectSendCash('project', 'one', { cashMinor: 2, reference: 'official request receipt' });
  assert.equal(next.budget('project')?.heldMinor, 200);
  assert.equal(next.budget('project')?.spentMinor, 2);
  assert.throws(() => next.confirmProjectSendCash('project', 'one', { cashMinor: 3, reference: 'conflicting receipt' }));
});

test('fallback needs a separate permit and cannot reuse an already claimed send', t => {
  const { ledger } = fixture(t);
  const first = intent('websocket');
  ledger.reserveProjectSend(first);
  assert.throws(() => ledger.consumeProjectSend({ ...first, protocol: 'http' }));
  ledger.consumeProjectSend(first);
  assert.throws(() => ledger.consumeProjectSend(first));
  const fallback = { ...intent('http-fallback'), protocol: 'http' };
  assert.throws(() => ledger.consumeProjectSend(fallback));
  ledger.reserveProjectSend(fallback);
  ledger.consumeProjectSend(fallback);
  assert.equal(ledger.budget('project')?.heldMinor, 400);
});

test('missing price, unknown execution and the cumulative cap all fail closed', t => {
  const { ledger, reopen } = fixture(t);
  const first = intent('one');
  assert.throws(() => ledger.reserveProjectSend({ ...first, quote: { ...first.quote, maximumCashMinor: null } }));
  for (const id of ['one', 'two', 'three', 'four', 'five']) ledger.reserveProjectSend(intent(id));
  assert.throws(() => ledger.reserveProjectSend(intent('six')));
  ledger.consumeProjectSend(first);
  ledger.recordProjectSendOutcome('project', 'one', { kind: 'unknown', reference: 'connection dropped after sending' });
  const next = reopen();
  assert.throws(() => next.consumeProjectSend(intent('two')));
  assert.equal(next.budget('project')?.heldMinor, 1000);
  assert.equal(next.budget('project')?.unresolvedCount, 1);
});

test('a terminal receipt above the quoted maximum keeps the hold and pauses until reviewed', async t => {
  const { ledger, engine } = fixture(t);
  const control = new ProjectControl(engine, () => new Date(now).toISOString());
  const egress = new ProjectPaidEgress(control, ledger);
  const first = intent('suspect');
  await egress.send(first, async () => ({
    value: 'terminal', reference: 'terminal usage receipt', estimatedCashMinor: 201,
  }));
  assert.equal(ledger.budget('project')?.heldMinor, 200);
  assert.equal(ledger.budget('project')?.spentMinor, 0);
  assert.equal(ledger.budget('project')?.unresolvedCount, 1);
  assert.throws(() => ledger.reserveProjectSend(intent('next')));
  const paused = engine.getProject('project')?.control;
  assert.equal(paused?.barrier?.status, 'stopped');
  assert.deepEqual(paused?.blockers, [{ kind: 'budget', id: 'suspect' }]);

  ledger.confirmProjectSendCash('project', 'suspect', { cashMinor: 195, reference: 'verified cash receipt' });
  assert.equal(ledger.budget('project')?.unresolvedCount, 0);
  assert.equal(ledger.budget('project')?.spentMinor, 195);
  assert.equal(engine.getProject('project')?.control.blockers.length, 1);
});

test('trusted egress claims the bound permit before opening an actual request and honors project pause', async t => {
  const { ledger, engine } = fixture(t);
  const control = new ProjectControl(engine, () => new Date(now).toISOString());
  const egress = new ProjectPaidEgress(control, ledger);
  const events: number[] = [];
  const server = createServer((_request, response) => {
    events.push(ledger.budget('project')!.heldMinor);
    response.end('OK');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address !== 'string');
  const launch = () => new Promise<{ value: number; reference: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: address.port, method: 'POST', path: '/' }, res => {
      res.resume();
      res.on('end', () => resolve({ value: res.statusCode!, reference: 'terminal local HTTP response' }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
  const first = { ...intent('http-1'), protocol: 'http' };
  assert.equal(await egress.send(first, launch), 200);
  await assert.rejects(egress.send(first, launch), ConflictError);
  await control.closeProjectStarts('project', { kind: 'manual', id: 'pause' });
  await assert.rejects(egress.send({ ...first, sendId: 'http-2', epoch: 1 }, launch), ConflictError);
  assert.deepEqual(events, [200]);
  assert.equal(ledger.budget('project')?.heldMinor, 200);
});

test('a pinned Magpie stream holds project cash before the HTTP send and requires its terminal receipt', async t => {
  const { ledger, engine } = fixture(t);
  const control = new ProjectControl(engine, () => new Date(now).toISOString());
  const egress = new ProjectPaidEgress(control, ledger);
  const binding = { instanceId: 'a'.repeat(32), providerId: 'stage', modelId: 'model', accountRef: '0123456789' };
  const body = '{"model":"stage/model","stream":true,"input":"local check"}';
  const held: number[] = [];
  let terminal = true;
  const server = createServer((req, res) => {
    assert.equal(req.url, '/v1/responses');
    held.push(ledger.budget('project')!.heldMinor);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"type":"response.created","response":{"id":"resp_local"}}\n\n');
    res.end(terminal
      ? 'data: {"type":"response.completed","response":{"id":"resp_local","status":"completed"}}\n\n'
      : 'data: {"type":"response.output_text.delta","delta":"partial"}\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address !== 'string');
  let revoked = 0;
  const host: Pick<MagpieHost, 'withPinnedModel'> = { withPinnedModel(selected, use, authorizeForward) {
    return withPinnedMagpieTurn({
      binding: selected, checkCurrent: async () => {},
      request: async method => {
        if (method === 'DELETE') { revoked++; return {}; }
        return { id: 'daming-test-scope', key: 'sk-magpie-key-test',
          models: ['stage/model'], accounts: ['stage/0123456789'],
          singleUpstream: true, expires: new Date(Date.now() + 60_000).toISOString() };
      },
      forward: (key, text, signal) => fetch('http://127.0.0.1:' + address.port + '/v1/responses', {
        method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: text, signal,
      }),
      ...(authorizeForward ? { authorizeForward } : {}),
    }, use);
  } };
  const submit = (sendId: string, outgoing = body, epoch = 0) => withGovernedProjectMagpieTurn(host, binding, egress, {
    ...intent(sendId), epoch, provider: binding.providerId, accountRef: binding.accountRef, protocol: 'responses_http',
    requestDigest: createHash('sha256').update(body).digest('hex'),
  }, async send => (await send(outgoing, new AbortController().signal)).text());
  await assert.rejects(submit('altered', body + ' '), /binding/);
  assert.deepEqual(held, []);
  assert.match(await submit('complete'), /response.completed/);
  assert.equal(ledger.budget('project')?.heldMinor, 200);
  terminal = false;
  await assert.rejects(submit('truncated'), /terminal/);
  assert.deepEqual(held, [200, 400]);
  assert.equal(ledger.budget('project')?.unresolvedCount, 1);
  assert.deepEqual(engine.getProject('project')?.control.blockers, [{ kind: 'reconciliation', id: 'truncated' }]);
  await assert.rejects(submit('paused', body, 1));
  assert.deepEqual(held, [200, 400]);
  assert.equal(revoked, 4);
});
