import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RequestLogStore, contextComposition, summarize } from '../src/gateway-observability.ts';
import type { GatewayRequestView } from '@daming/contracts';

function dir() { return mkdtempSync(join(tmpdir(), 'daming gateway obs ')); }
function record(over: Partial<GatewayRequestView> = {}): Record<string, unknown> {
  return {
    requestId: 'r1', at: '2026-11-21T13:00:00Z', agent: 'dsh', providerId: 'deepseek', modelId: 'deepseek/deepseek-chat',
    status: 'ok', latencyMs: 1200, firstTokenMs: 300, inputTokens: 1000, outputTokens: 200, cacheHitPercent: 99.9,
    costMinor: 0.12, maskedCount: 2, contextLimitTokens: 500000,
    contextParts: [
      { label: '系统提示词', category: 'system', tokens: 5000 },
      { label: '文件', category: 'files', tokens: 120000 },
      { label: '会话内容', category: 'conversation', tokens: 21000 },
    ], ...over,
  };
}

test('request log: append / list / summary / persist', () => {
  const d = dir();
  try {
    const store = new RequestLogStore(d);
    store.append(record({ requestId: 'r1', at: '2026-11-21T13:00:00Z' }));
    store.append(record({ requestId: 'r2', at: '2026-11-21T13:05:00Z', status: 'error', latencyMs: 800, maskedCount: 1, error: 'timeout' }));
    const view = store.view();
    assert.equal(view.summary.requests, 2);
    assert.equal(view.summary.errors, 1);
    assert.equal(view.summary.maskedTotal, 3);
    assert.equal(view.summary.totalCostMinor, 0.24);
    assert.equal(view.requests[0].requestId, 'r2'); // newest first
    // 持久化
    const reopened = new RequestLogStore(d);
    assert.equal(reopened.view().summary.requests, 2);
    // 校验
    assert.throws(() => store.append({ requestId: 'x' }), /missing_at/);
    assert.throws(() => store.append(record({ latencyMs: -1 })), /invalid_latency_ms/);
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 }); }
});

test('context composition: percents, remaining, sorted desc', () => {
  const r = record() as unknown as GatewayRequestView;
  const comp = contextComposition(r);
  assert.equal(comp.usedTokens, 146000);
  assert.equal(comp.parts[0].category, 'files'); // 最大在首
  assert.ok(Math.abs(comp.parts.reduce((sum, part) => sum + part.percent, 0) - 100) < 0.5);
  assert.ok((comp.remainingPercent ?? 0) > 0);
});

test('summarize averages cache hit and latency', () => {
  const s = summarize([record() as unknown as GatewayRequestView, record({ requestId: 'r2', latencyMs: 800, cacheHitPercent: 90 }) as unknown as GatewayRequestView]);
  assert.equal(s.avgLatencyMs, 1000);
  assert.equal(s.cacheHitPercentAvg, 95);
});

test('task attribution is explicit: header-backed rows are attributed, others stay unattributed', () => {
  const d = dir();
  try {
    const store = new RequestLogStore(d);
    const attributed = store.append(record({ requestId: 'r-task', taskId: 'task-abc-1234' }));
    assert.equal(attributed.attribution, 'task');
    assert.equal(attributed.taskId, 'task-abc-1234');

    const plain = store.append(record({ requestId: 'r-plain' }));
    assert.equal(plain.attribution, 'unattributed');
    assert.equal(plain.taskId, undefined);

    assert.deepEqual(store.recordsForTask('task-abc-1234').map((row) => row.requestId), ['r-task']);
    assert.deepEqual(store.recordsForTask('task-other'), []);
    // The model name alone never creates attribution.
    assert.equal(store.recordsForTask('deepseek/deepseek-chat').length, 0);

    assert.throws(() => store.append(record({ requestId: 'r-bad', taskId: 'bad task id' })), /invalid_task_id/);

    // Rows written before the field existed still load and report unattributed.
    const reopened = new RequestLogStore(d);
    assert.equal(reopened.get('r-task')?.attribution, 'task');
    assert.equal(reopened.get('r-plain')?.attribution, 'unattributed');
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 }); }
});
