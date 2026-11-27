import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CrewPlanStore, planCrew } from '../src/crew-planner.ts';

const AT = '2026-11-22T10:00:00.000Z';

function plan(store: CrewPlanStore) {
  const created = planCrew({
    title: '交付多 Agent 功能', goal: '完成需求梳理\n实现核心功能',
    planner: 'main-agent',
    catalog: {
      tenantId: 'tenant-a', dispatchEnabled: false, checkedAt: AT,
      models: [{
        modelId: 'deepseek-v4-pro', providerId: 'workbuddy', sourceKind: 'subscription',
        billing: 'quota', quota: {}, dispatchable: true
      }]
    },
    bindings: []
  });
  store.save(created);
  return created;
}

test('dispatch receipts persist across reload and stay append-only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'daming crew store '));
  try {
    const store = new CrewPlanStore(dir);
    const created = plan(store);
    assert.equal(store.get(created.planId)?.dispatches, undefined);

    const updated = store.recordDispatch(created.planId, [
      { assignmentId: 'sub-1', taskId: 'task-1', agent: 'dsh', modelId: 'deepseek-v4-pro', mode: 'dsh', bound: true, at: AT }
    ], [{ assignmentId: 'sub-2', reason: 'needs_provider_model', at: AT }]);
    assert.equal(updated.dispatches?.length, 1);
    assert.equal(updated.skipped?.[0]?.reason, 'needs_provider_model');

    // Reload from disk: the tree is recoverable without React state.
    const reopened = new CrewPlanStore(dir);
    const stored = reopened.get(created.planId)!;
    assert.equal(stored.dispatches?.[0]?.taskId, 'task-1');
    assert.equal(stored.dispatchedAt, AT);

    // Replaying the same dispatch must not duplicate receipts.
    reopened.recordDispatch(created.planId, [
      { assignmentId: 'sub-1', taskId: 'task-1', agent: 'dsh', modelId: 'deepseek-v4-pro', mode: 'dsh', bound: true, at: AT }
    ], []);
    assert.equal(reopened.get(created.planId)?.dispatches?.length, 1);

    assert.throws(() => reopened.recordDispatch('missing-plan', [], []), /crew_plan_not_found/);
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 }); }
});

test('sequential planning records advisory dependencies without serialising the engine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'daming crew seq '));
  try {
    const store = new CrewPlanStore(dir);
    const catalog = {
      tenantId: 'tenant-a', dispatchEnabled: false as const, checkedAt: AT,
      models: [{
        modelId: 'deepseek-v4-pro', providerId: 'workbuddy', sourceKind: 'subscription' as const,
        billing: 'quota' as const, quota: {}, dispatchable: true
      }]
    };
    const sequential = planCrew({ title: '顺序编队', goal: '调研\n实现\n复核', catalog, sequence: 'sequential' });
    assert.deepEqual(sequential.assignments.map((item) => item.dependsOn ?? []), [[], ['sub-1'], ['sub-2']]);
    assert.ok(sequential.notes.some((note) => note.includes('不会强制串行')), 'the plan states the advisory nature');

    const parallel = planCrew({ title: '并行编队', goal: '调研\n实现', catalog, sequence: 'parallel' });
    assert.deepEqual(parallel.assignments.map((item) => item.dependsOn ?? []), [[], []]);

    store.save(sequential);
    // Dependencies survive a store reload (they are plan data, not UI state).
    const reopened = new CrewPlanStore(dir);
    assert.equal(reopened.get(sequential.planId)?.assignments[2]?.dependsOn?.[0], 'sub-2');
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 }); }
});