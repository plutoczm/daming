import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { EscalationItemView } from '@daming/contracts';
import { PortfolioDecisionStore } from '../src/portfolio-decisions.ts';
import { handlePortfolioCardAction, renderPortfolioDecisionCard } from '../src/portfolio-feishu.ts';

function item(overrides: Partial<EscalationItemView> = {}): EscalationItemView {
  return {
    itemId: 'proj:contract:contract:c1', projectId: 'proj', projectName: '支付对账', kind: 'contract',
    severity: 'high', bucket: 'needs_you', summary: '需确认变更', recommendation: '批准或驳回', impact: '改验收',
    evidence: [], defaultAction: 'hold', realtime: true, createdAt: '2026-11-21T01:00:00Z',
    deadlineAt: '2026-11-22T01:00:00Z', ...overrides,
  };
}
function dir() { return mkdtempSync(join(tmpdir(), 'daming portfolio decide ')); }

test('decision store: single-use, duplicate same action is idempotent, different action rejected', () => {
  const d = dir();
  try {
    const store = new PortfolioDecisionStore(d);
    const first = store.decide({ itemId: 'a', projectId: 'p', kind: 'contract', action: 'approve', actorId: 'owner', decidedAt: '2026-11-21T02:00:00Z' });
    assert.equal(first.duplicate, false);
    assert.equal(store.isDecided('a'), true);
    assert.deepEqual(store.resolvedItemIds(), ['a']);
    const again = store.decide({ itemId: 'a', projectId: 'p', kind: 'contract', action: 'approve', actorId: 'owner', decidedAt: '2026-11-21T03:00:00Z' });
    assert.equal(again.duplicate, true);
    assert.throws(() => store.decide({ itemId: 'a', projectId: 'p', kind: 'contract', action: 'reject', actorId: 'owner', decidedAt: '2026-11-21T03:00:00Z' }), /already_decided/);
    // 持久化跨实例
    assert.deepEqual(new PortfolioDecisionStore(d).resolvedItemIds(), ['a']);
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 }); }
});

test('decision store: card nonce binds to item and is enforced when required', () => {
  const d = dir();
  try {
    const store = new PortfolioDecisionStore(d);
    const nonce = store.cardNonce('a');
    assert.notEqual(nonce, store.cardNonce('b'));
    assert.throws(() => store.decide({ itemId: 'a', projectId: 'p', kind: 'contract', action: 'approve', actorId: 'o', decidedAt: 'x', nonce: 'wrong', requireNonce: true }), /nonce/);
    const ok = store.decide({ itemId: 'a', projectId: 'p', kind: 'contract', action: 'approve', actorId: 'o', decidedAt: 'x', nonce, requireNonce: true });
    assert.equal(ok.duplicate, false);
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 }); }
});

test('feishu card: renders 3 module=portfolio buttons carrying the item nonce', () => {
  const d = dir();
  try {
    const store = new PortfolioDecisionStore(d);
    const it = item();
    const card = renderPortfolioDecisionCard(it, store.cardNonce(it.itemId)) as { body: { elements: { tag: string; actions?: { behaviors: { value: Record<string, unknown> }[] }[] }[] } };
    const actionEl = card.body.elements.find((el) => el.tag === 'action')!;
    assert.equal(actionEl.actions!.length, 3);
    for (const button of actionEl.actions!) {
      const value = button.behaviors[0].value;
      assert.equal(value.module, 'portfolio');
      assert.equal(value.itemId, it.itemId);
      assert.equal(value.nonce, store.cardNonce(it.itemId));
      assert.ok(['approve', 'reject', 'defer'].includes(String(value.action)));
    }
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 }); }
});

function cardEvent(value: Record<string, unknown>, openId = 'ou_owner') {
  return { event_id: 'evt1', event_type: 'card.action.trigger', operator: { open_id: openId }, action: { tag: 'button', value } };
}

test('feishu handler: approve writes a decision; replay ok; different action after decided errors; owner enforced; bad nonce rejected', () => {
  const d = dir();
  try {
    const store = new PortfolioDecisionStore(d);
    const it = item();
    const value = { module: 'portfolio', itemId: it.itemId, projectId: it.projectId, kind: it.kind, action: 'approve', nonce: store.cardNonce(it.itemId) };

    const ok = handlePortfolioCardAction(store, cardEvent(value), { ownerOpenId: 'ou_owner', now: Date.parse('2026-11-21T02:00:00Z') });
    assert.equal(ok.toast.type, 'success');
    assert.equal(store.get(it.itemId)?.action, 'approve');

    const replay = handlePortfolioCardAction(store, cardEvent(value), { ownerOpenId: 'ou_owner' });
    assert.equal(replay.toast.type, 'success'); // 相同动作幂等

    const different = handlePortfolioCardAction(store, cardEvent({ ...value, action: 'reject' }), { ownerOpenId: 'ou_owner' });
    assert.equal(different.toast.type, 'error');

    const otherItem = item({ itemId: 'proj:contract:contract:c2' });
    const otherValue = { module: 'portfolio', itemId: otherItem.itemId, projectId: 'proj', kind: 'contract', action: 'approve', nonce: store.cardNonce(otherItem.itemId) };
    assert.equal(handlePortfolioCardAction(store, cardEvent(otherValue, 'ou_attacker'), { ownerOpenId: 'ou_owner' }).toast.type, 'error');
    assert.equal(store.isDecided(otherItem.itemId), false);

    assert.equal(handlePortfolioCardAction(store, cardEvent({ ...otherValue, nonce: 'bad' }), { ownerOpenId: 'ou_owner' }).toast.type, 'error');
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 }); }
});
