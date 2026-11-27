import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../../../packages/core/src/index.ts';
import { SqliteStore } from '../../../packages/store-sqlite/src/index.ts';
import type { SessionContext, WorkerResult, WorkerSession } from '../../../packages/workers/src/index.ts';
import { REAL_CODEX_WORKER, REAL_DSH_WORKER, createRealCodexPlan, createRealDshPlan } from '../src/board-fixture.ts';
import { TaskCoordinator } from '../src/task-coordinator.ts';

class FakeRealWorker implements WorkerSession {
  private readonly contexts = new Map<string, SessionContext>();
  createSession(context: SessionContext): void { this.contexts.set(context.sessionId, context); }
  async run(sessionId: string): Promise<WorkerResult> {
    const context = this.contexts.get(sessionId)!;
    return {
      mode: 'real', sessionId: context.sessionId, taskId: context.taskId, runId: context.runId,
      attemptId: context.attemptId, status: 'completed', output: 'OK', events: [{ type: 'turn.completed' }]
    };
  }
  cancel(): void {}
}

class FakeDshWorker extends FakeRealWorker {
  readonly usage?: Readonly<Record<string, number>>;
  constructor(usage?: Readonly<Record<string, number>>) { super(); this.usage = usage; }
  override async run(sessionId: string): Promise<WorkerResult> {
    const result = await super.run(sessionId);
    return { ...result, events: [{ type: 'final' }], ...(this.usage ? { usage: this.usage } : {}) };
  }
}

test('real executor tasks pass through Task 3 governance without leaving a cash hold', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'daming real worker unit '));
  const store = new SqliteStore(join(dir, 'tasks.sqlite'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const engine = new Engine(store);
  const coordinator = new TaskCoordinator({
    store, engine, authorization: 'synthetic-approved', executionMode: 'real',
    workers: [{ descriptor: REAL_CODEX_WORKER, worker: new FakeRealWorker() }]
  });
  coordinator.createTask({ taskId: 'real-unit', title: 'Real governed unit', goal: 'Reply OK', plan: createRealCodexPlan('real-unit', 'Reply OK'), limitMinor: 100 });
  await coordinator.run('real-unit');
  const task = engine.getTask('real-unit')!;
  assert.equal(task.status, 'completed');
  assert.equal(task.workflow!.assignments[0].delivery?.status, 'completed');
  assert.deepEqual(task.workflow!.assignments[0].delivery?.artifacts, { result: 'OK' });
  const budget = store.governanceGet('budgets', 'real-unit')!;
  assert.equal(budget.id, 'real-unit');
  assert.equal(budget.taskId, 'real-unit');
  assert.equal(budget.currency, 'CNY');
  assert.equal(budget.limitMinor, 100);
  assert.equal(budget.spentMinor, 0);
  assert.equal(budget.heldMinor, 0);
  assert.equal(budget.breached, false);
  const audit = store.listGovernanceAudit('real-unit').map((event) => event.type);
  assert.ok(audit.includes('tool_started'));
  assert.ok(audit.includes('tool_settled'));
});

test('manual approval gates real task execution at awaiting_approval', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'daming real approval unit '));
  const store = new SqliteStore(join(dir, 'tasks.sqlite'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const engine = new Engine(store);
  const coordinator = new TaskCoordinator({
    store, engine, authorization: 'synthetic-approved', executionMode: 'real', approvalMode: 'manual',
    workers: [{ descriptor: REAL_CODEX_WORKER, worker: new FakeRealWorker() }]
  });
  coordinator.createTask({ taskId: 'approval-unit', title: 'Approval gated', goal: 'Reply OK', plan: createRealCodexPlan('approval-unit', 'Reply OK'), limitMinor: 100 });
  assert.equal(engine.getTask('approval-unit')!.status, 'awaiting_approval');
  assert.equal(store.governanceGet('budgets', 'approval-unit')!.spentMinor, 0);
  await coordinator.run('approval-unit');
  assert.equal(engine.getTask('approval-unit')!.status, 'awaiting_approval');
  const approved = coordinator.approve('approval-unit');
  assert.equal(approved.status, 'running');
  await coordinator.run('approval-unit');
  assert.equal(engine.getTask('approval-unit')!.status, 'completed');
  assert.deepEqual(engine.getTask('approval-unit')!.workflow!.assignments[0].delivery?.artifacts, { result: 'OK' });
});

test('real DSH with unknown model conservatively estimates at V4 Pro peak through governance', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'daming dsh worker unit '));
  const store = new SqliteStore(join(dir, 'tasks.sqlite'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const engine = new Engine(store);
  const coordinator = new TaskCoordinator({
    store, engine, authorization: 'synthetic-approved', executionMode: 'real',
    workers: [{ descriptor: REAL_DSH_WORKER, worker: new FakeDshWorker({ inputTokens: 8880, outputTokens: 2 }) }]
  });
  coordinator.createTask({ taskId: 'dsh-unit', title: 'Real DSH governed unit', goal: 'Reply OK', plan: createRealDshPlan('dsh-unit', 'Reply OK'), limitMinor: 100 });
  await coordinator.run('dsh-unit');
  const task = engine.getTask('dsh-unit')!;
  assert.equal(task.status, 'completed');
  assert.deepEqual(task.workflow!.assignments[0].delivery?.artifacts, { result: 'OK' });
  const budget = store.governanceGet('budgets', 'dsh-unit')!;
  assert.equal(budget.limitMinor, 100);
  assert.equal(budget.spentMinor, 8); // Unknown DSH model is quoted at V4 Pro peak.
  assert.equal(budget.heldMinor, 0);
  const quote = store.governanceList('quotes', 'dsh-unit')[0];
  assert.equal(quote.billingSource, 'official_api');
});

test('real DSH official_api tasks prefer a positive official balance delta over the usage estimate', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'daming dsh balance unit '));
  const store = new SqliteStore(join(dir, 'tasks.sqlite'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const engine = new Engine(store);
  let calls = 0;
  const coordinator = new TaskCoordinator({
    store, engine, authorization: 'synthetic-approved', executionMode: 'real',
    workers: [{ descriptor: REAL_DSH_WORKER, worker: new FakeDshWorker({ inputTokens: 8880, outputTokens: 2 }) }],
    cashSnapshot: async () => (++calls === 1 ? { currency: 'CNY', totalMinor: 1000 } : { currency: 'CNY', totalMinor: 997 })
  });
  coordinator.createTask({ taskId: 'dsh-balance', title: 'Official balance delta', goal: 'Reply OK', plan: createRealDshPlan('dsh-balance', 'Reply OK'), limitMinor: 100 });
  await coordinator.run('dsh-balance');
  assert.equal(engine.getTask('dsh-balance')!.status, 'completed');
  const budget = store.governanceGet('budgets', 'dsh-balance')!;
  assert.equal(budget.spentMinor, 3);
  assert.equal(budget.heldMinor, 0);
  const execution = store.governanceList('executions', 'dsh-balance')[0];
  const outcome = execution.outcome as unknown as { result: { toolResult: { balance: { deltaMinor: number; usedForSettlement: boolean } } } };
  assert.equal(outcome.result.toolResult.balance.deltaMinor, 3);
  assert.equal(outcome.result.toolResult.balance.usedForSettlement, true);
});

test('real DSH tasks without provider usage keep an unknown hold and block for reconciliation', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'daming dsh worker unknown '));
  const store = new SqliteStore(join(dir, 'tasks.sqlite'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const engine = new Engine(store);
  const coordinator = new TaskCoordinator({
    store, engine, authorization: 'synthetic-approved', executionMode: 'real',
    workers: [{ descriptor: REAL_DSH_WORKER, worker: new FakeDshWorker() }]
  });
  coordinator.createTask({ taskId: 'dsh-unknown', title: 'Real DSH unknown cash', goal: 'Reply OK', plan: createRealDshPlan('dsh-unknown', 'Reply OK'), limitMinor: 100 });
  await coordinator.run('dsh-unknown');
  const task = engine.getTask('dsh-unknown')!;
  assert.equal(task.status, 'blocked');
  assert.equal(store.effectsForTask('dsh-unknown')[0].status, 'needs_reconciliation');
  const budget = store.governanceGet('budgets', 'dsh-unknown')!;
  assert.equal(budget.spentMinor, 0);
  assert.equal(budget.heldMinor, 100);

  const execution = store.governanceList('executions', 'dsh-unknown')[0];
  coordinator.reconcile('dsh-unknown', execution.id, { resolution: 'succeeded', actualCashMinor: 2, evidence: 'official DeepSeek invoice line A-1' });
  assert.equal(engine.getTask('dsh-unknown')!.status, 'blocked');
  assert.equal(store.governanceGet('executions', execution.id)!.status, 'settled');
  const reconciled = store.governanceGet('budgets', 'dsh-unknown')!;
  assert.equal(reconciled.spentMinor, 2);
  assert.equal(reconciled.heldMinor, 0);
});
