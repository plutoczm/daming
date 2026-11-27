import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { EscalationItemView, PortfolioDigestView } from '@daming/contracts';
import type { NotificationEvent } from '../src/notification-hub.ts';
import {
  PortfolioNotifier, PortfolioNotifyStore, emptyNotifyState, formatRealtimeMessage, planPortfolioNotifications,
} from '../src/portfolio-notify.ts';

function item(id: string, overrides: Partial<EscalationItemView> = {}): EscalationItemView {
  return {
    itemId: id, projectId: 'p', projectName: '支付对账', kind: 'contract', severity: 'high',
    bucket: 'needs_you', summary: '需确认变更', recommendation: '批准或驳回', impact: '改验收',
    evidence: [], defaultAction: 'hold', realtime: true, createdAt: '2026-11-21T01:00:00Z',
    deadlineAt: '2026-11-22T01:00:00Z', ...overrides,
  };
}
function digest(overrides: Partial<PortfolioDigestView> = {}): PortfolioDigestView {
  return {
    dayKey: '2026-11-21', generatedAt: '2026-11-21T02:00:00Z',
    totals: { projects: 1, needsYou: 1, atRisk: 0, awaitingAcceptance: 0, healthy: 0 },
    realtime: [], digest: [], autoHandled: [], notes: [], ...overrides,
  };
}

test('formatRealtimeMessage contains project, summary and recommendation', () => {
  const text = formatRealtimeMessage([item('i1')]);
  assert.ok(text.includes('支付对账'));
  assert.ok(text.includes('需确认变更'));
  assert.ok(text.includes('批准或驳回'));
});

test('plan: first run pushes realtime + once-a-day digest; repeat is silent; new item only', () => {
  const d1 = digest({ realtime: [item('i1')], digest: [item('d1', { kind: 'acceptance', severity: 'medium', bucket: 'awaiting_acceptance' })] });
  const first = planPortfolioNotifications({ digest: d1, state: emptyNotifyState() });
  assert.ok(first.realtimeText && first.realtimeText.includes('需确认变更'));
  assert.ok(first.digestText && first.digestText.includes('晨间组合 digest'));
  assert.deepEqual(first.nextState.pushedItemIds, ['i1']);
  assert.equal(first.nextState.lastDigestDay, '2026-11-21');

  const repeat = planPortfolioNotifications({ digest: d1, state: first.nextState });
  assert.equal(repeat.realtimeText, null);
  assert.equal(repeat.digestText, null);

  const d2 = digest({ realtime: [item('i1'), item('i2', { projectName: '数据迁移', summary: '账单未知' })] });
  const next = planPortfolioNotifications({ digest: d2, state: first.nextState });
  assert.ok(next.realtimeText && next.realtimeText.includes('账单未知'));
  assert.equal(next.realtimeText!.includes('需确认变更'), false); // 已推过的不重复
  assert.equal(next.digestText, null); // 同一天 digest 不重复
  assert.deepEqual([...next.nextState.pushedItemIds].sort(), ['i1', 'i2']);
});

test('plan: empty digest list never produces a digest message', () => {
  const plan = planPortfolioNotifications({ digest: digest({ realtime: [item('i1')], digest: [] }), state: emptyNotifyState() });
  assert.equal(plan.digestText, null);
  assert.equal(plan.nextState.lastDigestDay, '');
});

test('notifier sends through injected transport once and persists dedupe state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daming portfolio notify '));
  try {
    const sent: { event: NotificationEvent; text: string }[] = [];
    const store = new PortfolioNotifyStore(dir);
    const notifier = new PortfolioNotifier(store, async (event, text) => { sent.push({ event, text }); });
    const d = digest({ realtime: [item('i1')], digest: [item('d1', { kind: 'acceptance', severity: 'medium', bucket: 'awaiting_acceptance' })] });

    const first = await notifier.run(d);
    assert.deepEqual(first, { realtime: true, digest: true });
    assert.equal(sent.length, 2);
    assert.equal(sent[0].event, 'portfolio.lifeline');
    assert.equal(sent[1].event, 'portfolio.digest');

    const second = await notifier.run(d);
    assert.deepEqual(second, { realtime: false, digest: false });
    assert.equal(sent.length, 2); // 不重复推

    // 持久化：新实例读到已推 item
    const reopened = new PortfolioNotifyStore(dir);
    assert.deepEqual(reopened.get().pushedItemIds, ['i1']);
    assert.equal(reopened.get().lastDigestDay, '2026-11-21');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  }
});
