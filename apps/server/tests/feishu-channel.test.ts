import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConflictError, Engine } from '@daming/core';
import { SqliteStore } from '@daming/store-sqlite';
import {
  FeishuChannel, MemoryFeishuCardRepository, computeFeishuSignature,
} from '../src/feishu-channel.ts';
import type { FeishuCard } from '../src/feishu-channel.ts';
import { createFeishuDecisionDispatcher, renderFeishuDecisionCard } from '../src/feishu-long-connection.ts';

const ENCRYPT = 'feishu-encrypt-key-0123456789abcdef';
const TOKEN = 'verification-token-abc123';
const START = Date.parse('2026-11-19T00:00:00Z');
const APP_ID = 'cli_example';

function fixture(t: { after(fn: () => void): void }, onPause?: () => Promise<void>, longConnection = false) {
  const dir = mkdtempSync(join(tmpdir(), 'daming feishu '));
  const path = join(dir, 'data.sqlite');
  const store = new SqliteStore(path);
  const engine = new Engine(store, store);
  const at = new Date(START).toISOString();
  engine.executeProject({
    type: 'create_project', projectId: 'p', eventId: 'create', expectedRevision: 0, at,
    ownerId: 'owner', goal: 'Deliver', documents: {
      spec: [{ id: 'a', text: 'Spec' }], plan: [{ id: 'plan-clause', text: 'Plan v1' }],
      acceptance: [{ id: 'c', text: 'Checks' }],
    },
  });
  const opened = engine.executeProject({
    type: 'open_decision', projectId: 'p', eventId: 'decision', expectedRevision: 1, at,
    decisionId: 'd1', kind: 'proposal', question: 'Apply the plan change?',
    changes: [{ document: 'plan', operation: 'replace', clause: { id: 'plan-clause', text: 'Plan v2' } }],
  });
  const decision = opened.project.decisions.find(d => d.decisionId === 'd1')!;

  let nowMs = START;
  const sent: FeishuCard[] = [];
  const repository = new MemoryFeishuCardRepository();
  const pauses: string[] = [];
  const channel = new FeishuChannel({
    transport: async (card) => {
      sent.push(card);
      return { messageId: 'm-' + sent.length };
    },
    repository, engine, ...(longConnection ? { appId: APP_ID } : { encryptKey: ENCRYPT, verificationToken: TOKEN }),
    now: () => nowMs,
    pause: (projectId) => { pauses.push(projectId); return onPause?.(); },
  });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    engine, decision, channel, repository, sent, pauses,
    now: () => nowMs,
    setNow: (value: number) => { nowMs = value; },
  };
}

function card(targetRevision: number, expiresAtMs: number): FeishuCard {
  return {
    projectId: 'p', decisionId: 'd1', targetRevision, decisionKind: 'proposal',
    ownerOpenId: 'ou_owner', title: '需要你的决定', body: '是否应用计划变更？',
    buttons: [{ action: 'approve', label: '批准' }, { action: 'reject', label: '拒绝' }, { action: 'pause', label: '暂停' }],
    expiresAtMs,
  };
}

function envelope(rawBody: string, options: { ts?: number; nonce?: string; key?: string; signature?: string } = {}) {
  const ts = options.ts ?? Math.floor(START / 1000);
  const nonce = options.nonce ?? 'nonce-1';
  const key = options.key ?? ENCRYPT;
  const signature = options.signature ?? computeFeishuSignature(String(ts), nonce, key, rawBody);
  return { timestamp: String(ts), nonce, signature, rawBody };
}

function callback(value: Record<string, unknown>, options: { eventId?: string; openId?: string; token?: string; createTime?: string } = {}) {
  return JSON.stringify({
    schema: '2.0',
    header: {
      event_id: options.eventId ?? 'evt-1', event_type: 'card.action.trigger',
      token: options.token ?? TOKEN, create_time: options.createTime ?? new Date(START).toISOString(),
    },
    event: { operator: { open_id: options.openId ?? 'ou_owner' }, action: { tag: 'button', value: JSON.stringify(value) } },
  });
}

test('owner approve applies the pending proposal exactly once', async (t) => {
  const h = fixture(t);
  const record = await h.channel.publish(card(h.decision.targetRevision, START + 60_000));
  assert.equal(record.status, 'pending');
  const body = callback({ messageId: record.messageId, decisionId: 'd1', action: 'approve', text: '同意' });
  const result = await h.channel.handleAction(envelope(body));
  assert.equal(result.status, 'answered');
  assert.equal(result.action, 'approve');
  const project = h.engine.getProject('p')!;
  assert.equal(project.decisions.find(d => d.decisionId === 'd1')!.status, 'answered');
  assert.equal(project.documents.plan.clauses.find(c => c.id === 'plan-clause')!.text, 'Plan v2');
});

test('a replayed callback and a reused card are both rejected without a second write', async (t) => {
  const h = fixture(t);
  const record = await h.channel.publish(card(h.decision.targetRevision, START + 60_000));
  const body = callback({ messageId: record.messageId, decisionId: 'd1', action: 'approve' });
  await h.channel.handleAction(envelope(body, { nonce: 'n-1' }));
  const revision = h.engine.getProject('p')!.revision;

  await assert.rejects(h.channel.handleAction(envelope(body, { nonce: 'n-1' })), ConflictError);
  const fresh = callback({ messageId: record.messageId, decisionId: 'd1', action: 'reject' }, { eventId: 'evt-2' });
  await assert.rejects(h.channel.handleAction(envelope(fresh, { nonce: 'n-2' })), /already_answered/);
  assert.equal(h.engine.getProject('p')!.revision, revision);
});

test('only the bound owner open_id may act', async (t) => {
  const h = fixture(t);
  const record = await h.channel.publish(card(h.decision.targetRevision, START + 60_000));
  const body = callback({ messageId: record.messageId, decisionId: 'd1', action: 'approve' }, { openId: 'ou_intruder' });
  await assert.rejects(h.channel.handleAction(envelope(body)), /actor_not_owner/);
  assert.equal(h.engine.getProject('p')!.decisions[0]!.status, 'pending');
});

test('signature, token and timestamp are all enforced', async (t) => {
  const h = fixture(t);
  const record = await h.channel.publish(card(h.decision.targetRevision, START + 60_000));
  const value = { messageId: record.messageId, decisionId: 'd1', action: 'approve' };

  await assert.rejects(h.channel.handleAction(envelope(callback(value), { signature: 'deadbeef' })), /signature_invalid/);
  await assert.rejects(h.channel.handleAction(envelope(callback(value, { token: 'wrong-token' }))), /token_mismatch/);
  await assert.rejects(
    h.channel.handleAction(envelope(callback(value), { ts: Math.floor(START / 1000) - 10_000 })),
    /timestamp_stale/,
  );
  assert.equal(h.engine.getProject('p')!.decisions[0]!.status, 'pending');
});

test('an expired card is refused and marked expired', async (t) => {
  const h = fixture(t);
  const record = await h.channel.publish(card(h.decision.targetRevision, START + 1_000));
  h.setNow(START + 5_000);
  const body = callback({ messageId: record.messageId, decisionId: 'd1', action: 'approve' },
    { createTime: new Date(h.now()).toISOString() });
  await assert.rejects(h.channel.handleAction(envelope(body, { ts: Math.floor(h.now() / 1000) })), /card_expired/);
  assert.equal(h.repository.get(record.messageId)?.status, 'expired');
  assert.equal(h.engine.getProject('p')!.decisions[0]!.status, 'pending');
});

test('owner can pause through Feishu without answering the decision', async (t) => {
  const h = fixture(t);
  const record = await h.channel.publish(card(h.decision.targetRevision, START + 60_000));
  const body = callback({ messageId: record.messageId, decisionId: 'd1', action: 'pause' });
  const result = await h.channel.handleAction(envelope(body));
  assert.equal(result.status, 'paused');
  assert.deepEqual(h.pauses, ['p']);
  assert.equal(h.engine.getProject('p')!.decisions[0]!.status, 'pending');
  assert.equal(h.repository.get(record.messageId)?.chosenAction, 'pause');
});

test('only buttons on the published card can be used', async (t) => {
  const h = fixture(t);
  const published = card(h.decision.targetRevision, START + 60_000);
  const record = await h.channel.publish({ ...published, buttons: [{ action: 'reject', label: '拒绝' }] });
  const body = callback({ messageId: record.messageId, decisionId: 'd1', action: 'approve' });
  await assert.rejects(h.channel.handleAction(envelope(body)), /action_mismatch/);
  assert.equal(h.engine.getProject('p')!.decisions[0]!.status, 'pending');
});

test('callbacks cannot decide or pause again while the card is pausing', async (t) => {
  const pending = Promise.withResolvers<void>();
  const h = fixture(t, () => pending.promise);
  const record = await h.channel.publish(card(h.decision.targetRevision, START + 60_000));
  const target = { messageId: record.messageId, decisionId: 'd1' };
  const pause = h.channel.handleAction(envelope(callback({ ...target, action: 'pause' })));
  try {
    for (const action of ['approve', 'pause']) {
      const body = callback({ ...target, action }, { eventId: `evt-${action}` });
      await assert.rejects(h.channel.handleAction(envelope(body, { nonce: `nonce-${action}` })), /action_in_progress/);
    }
    assert.deepEqual(h.pauses, ['p']);
    assert.equal(h.engine.getProject('p')!.decisions[0]!.status, 'pending');
  } finally {
    pending.resolve();
    await pause;
  }
  assert.equal(h.repository.get(record.messageId)?.chosenAction, 'pause');
});

test('Feishu SDK dispatches a card callback bound to the app, owner and original message', async (t) => {
  const h = fixture(t, undefined, true);
  const published = card(h.decision.targetRevision, START + 60_000);
  const record = await h.channel.publish(published);
  const dispatcher = createFeishuDecisionDispatcher(h.channel);
  const rendered = renderFeishuDecisionCard(published);
  const approve = rendered.body.elements.find(element => 'behaviors' in element)!.behaviors[0]!.value;
  const invoke = async (id: string, appId = APP_ID, openId = 'ou_owner', messageId = record.messageId, created = START * 1000) =>
    dispatcher.invoke({
      schema: '2.0', header: { app_id: appId, event_id: id, event_type: 'card.action.trigger', create_time: String(created) },
      event: { operator: { open_id: openId }, context: { open_message_id: messageId }, action: { tag: 'button', value: approve } },
    }, { needCheck: false });

  assert.equal((await invoke('wrong-app', 'cli_other')).toast.type, 'error');
  assert.equal((await invoke('wrong-owner', APP_ID, 'ou_other')).toast.type, 'error');
  assert.equal((await invoke('wrong-message', APP_ID, 'ou_owner', 'om_other')).toast.type, 'error');
  assert.equal((await invoke('old-event', APP_ID, 'ou_owner', record.messageId, (START - 301_000) * 1000)).toast.type, 'error');
  assert.equal(h.engine.getProject('p')!.decisions[0]!.status, 'pending');
  assert.equal((await invoke('valid')).toast.type, 'success');
  assert.equal((await invoke('valid')).toast.type, 'error');
  assert.equal(h.engine.getProject('p')!.decisions[0]!.status, 'answered');
});
