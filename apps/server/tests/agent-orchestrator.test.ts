import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentOrchestrator } from '../src/agent-orchestrator.ts';
import type { OfflineAgentDriver, ChildRole } from '../src/agent-orchestrator.ts';

function input(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: randomUUID(), missionId: randomUUID(),
    userId: randomUUID(), requestId: randomUUID(),
    goal: '测试两个并行离线子任务', plannedTargets: {
      research: 'group/research-agents', analysis: 'codex/gpt-6'
    },
    ...overrides
  };
}
function fixture(name: string) {
  return mkdtempSync(join(tmpdir(), 'daming-v2-' + name + '-'));
}
async function waitUntil(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('condition_not_reached');
}

test('app-owned parent / child threads, parallel delegation, handoffs and explicit parent completion', async () => {
  const dir = fixture('parallel');
  const pending = new Map<ChildRole, (summary: string) => void>();
  let active = 0, maximum = 0;
  const adapter: OfflineAgentDriver = {
    kind: 'offline-wsl-sandbox',
    execute: ({ role, plannedTarget }) => {
      assert.ok(plannedTarget === 'group/research-agents' || plannedTarget === 'codex/gpt-6');
      active++; maximum = Math.max(maximum, active);
      return new Promise(resolve => pending.set(role, value => {
        active--; resolve(value);
      }));
    }
  };
  const store = new AgentOrchestrator(dir, { driver: adapter });
  try {
    const task = input();
    const original = store.create(task);
    assert.equal(original.status, 'running');
    assert.equal(original.nodes.length, 3);
    assert.equal(original.threads.length, 3);
    assert.equal(original.runs.filter(r => r.countsForConversation).length, 1);
    assert.ok(original.runs.filter(r => !r.countsForConversation).every(
      r => r.parentRunId === original.rootRunId));
    assert.equal(original.nodes.find(n => n.role === 'research')?.plannedMagpieTarget,
      'group/research-agents');
    assert.equal(original.nodes.find(n => n.role === 'research')?.actualDriver,
      'offline-wsl-sandbox');
    assert.equal(original.nodes.find(n => n.role === 'research')?.providerThreadId, null);
    assert.equal(original.paidDispatchPermitted, false);
    assert.equal(original.plannedRoutesNotExecuted, true);
    assert.equal(store.create(task).rootRunId, original.rootRunId);
    assert.throws(() => store.create({ ...task, goal: 'changed' }), /agent_request_id_conflict/);
    assert.throws(() => store.create({ ...task, requestId: randomUUID() }),
      /agent_run_already_active/);
    assert.throws(() => store.graph(original.rootRunId, randomUUID()),
      /agent_run_not_found/);
    const dispatch = store.dispatch(original.rootRunId, task.tenantId);
    await waitUntil(() => pending.size === 2);
    assert.equal(maximum, 2, 'both child adapters must actually run concurrently');
    assert.equal(store.graph(original.rootRunId, task.tenantId).status, 'running');
    assert.throws(() => store.decide(task.tenantId, original.rootRunId,
      randomUUID(), 'approve'), /agent_children_not_ready/);
    pending.get('research')!('first result');
    await waitUntil(() => store.graph(original.rootRunId, task.tenantId)
      .transfers.length === 1);
    assert.equal(store.graph(original.rootRunId, task.tenantId).status, 'running',
      'child result MUST NOT finish parent');
    pending.get('analysis')!('second result with sk-realisticSecretHere123456');
    await dispatch;
    const waiting = store.graph(original.rootRunId, task.tenantId);
    assert.equal(waiting.status, 'waiting_approval');
    assert.equal(waiting.transfers.length, 2);
    assert.ok(waiting.events.some(e => e.event === 'root.waiting_approval'));
    assert.ok(waiting.transfers.every(e => e.kind === 'subagent_result'));
    assert.doesNotMatch(JSON.stringify(waiting), /sk-realisticSecretHere123456/);
    const approval = randomUUID();
    const done = store.decide(task.tenantId, original.rootRunId, approval, 'approve');
    assert.equal(done.status, 'completed');
    assert.ok(done.events.some(e => e.event === 'root.completed'));
    assert.equal(store.decide(task.tenantId, original.rootRunId, approval,
      'approve').status, 'completed');
    assert.throws(() => store.decide(task.tenantId, original.rootRunId, approval,
      'cancel'), /agent_command_request_conflict/);
    await store.close();
    const rebooted = new AgentOrchestrator(dir, { driver: adapter });
    try {
      assert.equal(rebooted.latest(task.missionId, task.tenantId)?.status, 'completed');
      assert.equal(rebooted.graph(original.rootRunId, task.tenantId).transfers.length, 2);
    } finally { await rebooted.close(); }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 60 });
  }
});

test('cancel interrupts children and late responses cannot resurrect the parent', async () => {
  const dir = fixture('cancel');
  let aborted = 0;
  const driver: OfflineAgentDriver = {
    kind: 'offline-wsl-sandbox',
    execute: ({ signal }) => new Promise((_resolve, reject) => {
      if (signal.aborted) { reject(new Error('aborted')); return; }
      signal.addEventListener('abort', () => {
        aborted++; reject(new Error('cancelled'));
      }, { once: true });
    })
  };
  const store = new AgentOrchestrator(dir, { driver });
  try {
    const task = input();
    const graph = store.create(task);
    const work = store.dispatch(graph.rootRunId, task.tenantId);
    await waitUntil(() => store.graph(graph.rootRunId, task.tenantId)
      .nodes.filter(n => n.status === 'running').length === 3);
    const cancelled = store.decide(task.tenantId, graph.rootRunId, randomUUID(), 'cancel');
    assert.equal(cancelled.status, 'cancelled');
    await work;
    assert.equal(aborted, 2);
    assert.equal(store.graph(graph.rootRunId, task.tenantId).status, 'cancelled');
    assert.ok(store.graph(graph.rootRunId, task.tenantId).nodes
      .filter(n => n.kind === 'subagent').every(n => n.status === 'cancelled'));
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 60 });
  }
});

test('failed worker blocks approval; incomplete run after a simulated crash is fail-closed', async () => {
  const dir = fixture('recovery');
  const failed: OfflineAgentDriver = {
    kind: 'offline-wsl-sandbox',
    execute: async ({ role }) => {
      if (role === 'analysis') throw new Error('sk-secret-from-provider-should-not-appear');
      return 'offline success';
    }
  };
  let store = new AgentOrchestrator(dir, { driver: failed });
  try {
    const task = input();
    const one = store.create(task);
    await store.dispatch(one.rootRunId, task.tenantId);
    assert.equal(store.graph(one.rootRunId, task.tenantId).status, 'blocked');
    assert.throws(() => store.decide(task.tenantId, one.rootRunId, randomUUID(), 'approve'),
      /agent_children_not_ready/);
    assert.doesNotMatch(JSON.stringify(store.graph(one.rootRunId, task.tenantId)),
      /sk-secret-from-provider/);
    const two = store.create({ ...task, requestId: randomUUID() });
    // Mimic an abrupt host restart with a second connection; no driver call
    // may be replayed merely because the persisted root was running.
    const recovered = new AgentOrchestrator(dir, { driver: failed });
    try {
      const observed = recovered.graph(two.rootRunId, task.tenantId);
      assert.equal(observed.status, 'interrupted');
      assert.ok(observed.events.some(e => e.event === 'root.interrupted'));
      assert.equal(observed.transfers.length, 0);
      await recovered.dispatch(two.rootRunId, task.tenantId);
      assert.equal(recovered.graph(two.rootRunId, task.tenantId).status, 'interrupted');
    } finally { await recovered.close(); }
    assert.equal(store.decide(task.tenantId, two.rootRunId,
      randomUUID(), 'cancel').status, 'cancelled');
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 60 });
  }
});
