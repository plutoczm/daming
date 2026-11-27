import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Engine } from '@daming/core';
import { SqliteStore } from '@daming/store-sqlite';
import { CodexWebApproval } from '../src/codex-web-approval.ts';

const binding = { instanceId: 'a'.repeat(32), providerId: 'codex', modelId: 'gpt-6.1-sol',
  accountRef: '0123456789abcdef', accountKind: 'codex-subscription' as const };
const actor = { tenantId: 'tenant-a', userId: 'owner-a', sessionId: 'session-a' };

test('hard crash keeps in-flight facts and budget, exposes manual recovery and never resumes automatically', async t => {
  const root = mkdtempSync(join(tmpdir(), 'daming-web-hard-crash-'));
  const file = join(root, 'tasks.sqlite');
  const script = `
    import { Engine } from './packages/core/src/index.ts';
    import { SqliteStore } from './packages/store-sqlite/src/index.ts';
    import { CodexWebApproval } from './apps/server/src/codex-web-approval.ts';
    const store = new SqliteStore(process.argv[1]);
    const service = new CodexWebApproval(store, new Engine(store), {
      binding: async () => (${JSON.stringify(binding)}), run: async () => process.exit(0)
    });
    const task = await service.prepare(${JSON.stringify(actor)}, {requestId:'crash-request',prompt:'OK',limitMinor:500});
    await service.approve(${JSON.stringify(actor)},task.taskId,500);
  `;
  const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', script, file], { encoding: 'utf8' });
  assert.equal(crashed.status, 0, crashed.stderr);
  const store = new SqliteStore(file);
  let sends = 0;
  const service = new CodexWebApproval(store, new Engine(store), { binding: async () => binding,
    run: async () => { sends++; throw new Error('must_not_replay'); } });
  t.after(async () => { await service.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const [view] = service.list(actor);
  assert.equal(view.recoveryRequired, true);
  assert.equal(view.cashHeldMinor, 500);
  assert.equal(view.status, 'running', 'projection must not mutate Task facts without explicit recovery');
  assert.equal(store.effectsForTask(view.taskId)[0].status, 'executing');
  await assert.rejects(service.approve(actor, view.taskId, 500), /not_awaiting/);
  await assert.rejects(service.prepare(actor, { requestId: 'after-crash', prompt: 'OK', limitMinor: 500 }), /unresolved/);
  assert.equal(sends, 0);
});

test('web consent reserves before its only send and persists unknown cash without replay', async t => {
  const root = mkdtempSync(join(tmpdir(), 'daming-web-consent-'));
  let store = new SqliteStore(join(root, 'tasks.sqlite'));
  let sends = 0;
  const make = () => new CodexWebApproval(store, new Engine(store), {
    binding: async () => binding,
    run: async (_binding, prompt, _signal) => {
      sends++;
      assert.equal(prompt, 'Answer OK');
      assert.equal(store.governanceGet('budgets', prepared.taskId)?.heldMinor, 123);
      assert.equal(store.governanceList('approvals', prepared.taskId)[0]?.status, 'consumed');
      return { status: 'completed', exitCode: 0, output: 'OK', events: [], usage: { input_tokens: 7 } };
    }
  });
  let service = make();
  t.after(async () => { await service.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const prepared = await service.prepare(actor, { requestId: 'request-one', prompt: 'Answer OK', limitMinor: 123 });
  assert.equal(prepared.status, 'awaiting_approval');
  assert.equal(prepared.cashHeldMinor, 0);
  assert.equal(sends, 0);
  assert.equal((await service.prepare(actor, { requestId: 'request-one', prompt: 'Answer OK', limitMinor: 123 })).taskId, prepared.taskId);
  await assert.rejects(service.prepare(actor, { requestId: 'request-one', prompt: 'Changed', limitMinor: 123 }), /request_conflict/);
  await assert.rejects(service.approve(actor, prepared.taskId, 122), /budget_mismatch/);
  const results = await Promise.allSettled([service.approve(actor, prepared.taskId, 123), service.approve(actor, prepared.taskId, 123)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  await service.drain();
  const result = service.detail(actor, prepared.taskId);
  assert.equal(result.status, 'blocked');
  assert.equal(result.modelStatus, 'completed');
  assert.equal(result.output, 'OK');
  assert.equal(result.cashHeldMinor, 123);
  assert.equal(result.cashChargedMinor, null);
  assert.equal(store.effectsForTask(prepared.taskId)[0]?.status, 'needs_reconciliation');
  assert.doesNotMatch(JSON.stringify(result), /0123456789abcdef|session-a|instanceId/);
  await assert.rejects(service.prepare(actor, { requestId: 'request-two', prompt: 'Again', limitMinor: 123 }), /unresolved/);
  await service.close(); store.close();
  store = new SqliteStore(join(root, 'tasks.sqlite')); service = make();
  await assert.rejects(service.approve(actor, prepared.taskId, 123), /not_awaiting/);
  assert.equal(service.detail(actor, prepared.taskId).cashHeldMinor, 123);
  assert.equal(sends, 1);
});

test('cancel, expiry, restart, owner and binding checks prevent unapproved execution', async t => {
  const root = mkdtempSync(join(tmpdir(), 'daming-web-expiry-'));
  const store = new SqliteStore(join(root, 'tasks.sqlite'));
  let now = Date.now(), sends = 0, changed = false;
  const options = { now: () => now, binding: async () => ({ ...binding, ...(changed ? { accountRef: 'b'.repeat(16) } : {}) }),
    run: async () => { sends++; throw new Error('private_transport_secret'); } };
  let service = new CodexWebApproval(store, new Engine(store), options);
  t.after(async () => { await service.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  for (const limitMinor of [0, 501, 1.5]) await assert.rejects(service.prepare(actor, { requestId: 'bad-budget', prompt: 'OK', limitMinor }), /input_invalid/);
  const first = await service.prepare(actor, { requestId: 'first-req', prompt: 'OK', limitMinor: 500 });
  assert.throws(() => service.detail({ ...actor, tenantId: 'other' }, first.taskId), /not_found/);
  assert.throws(() => service.detail({ ...actor, userId: 'other' }, first.taskId), /not_found/);
  await assert.rejects(service.approve({ ...actor, sessionId: 'new-session' }, first.taskId, 500), /session_changed/);
  now += 300001;
  await assert.rejects(service.approve(actor, first.taskId, 500), /expired/);
  service.cancel(actor, first.taskId);
  const second = await service.prepare(actor, { requestId: 'second-req', prompt: 'OK', limitMinor: 500 });
  await service.close(); service = new CodexWebApproval(store, new Engine(store), options);
  await assert.rejects(service.approve(actor, second.taskId, 500), /expired/);
  service.cancel(actor, second.taskId);
  const third = await service.prepare(actor, { requestId: 'third-req', prompt: 'OK', limitMinor: 500 });
  changed = true;
  await assert.rejects(service.approve(actor, third.taskId, 500), /binding_changed/);
  assert.equal(sends, 0);
  changed = false;
  await assert.rejects(service.approve(actor, third.taskId, 500, () => { throw new Error('session_revoked'); }), /session_revoked/);
  assert.equal(sends, 0);
  await service.approve(actor, third.taskId, 500); await service.drain();
  assert.equal(service.detail(actor, third.taskId).cashHeldMinor, 500);
  assert.doesNotMatch(JSON.stringify(service.detail(actor, third.taskId)), /private_transport_secret/);
  assert.equal(sends, 1);
});
