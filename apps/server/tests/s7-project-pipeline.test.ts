import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Engine } from '../../../packages/core/src/index.ts';
import type { AcceptanceCheck, WorkflowPlan } from '../../../packages/core/src/index.ts';
import { SqliteStore } from '../../../packages/store-sqlite/src/index.ts';
import { FixtureWorker } from '../../../packages/workers/src/index.ts';
import type { WorkerDescriptor } from '../../../packages/workers/src/index.ts';
import { TaskCoordinator } from '../src/task-coordinator.ts';
import { ProjectInputStore } from '../src/project-input.ts';
import type { FrozenProjectInput } from '../src/project-input.ts';

function descriptor(id: string, executorKind: 'dsh' | 'codex'): WorkerDescriptor {
  return { id, executorKind, executionMode: 'fixture', runtime: 'fixture-v1', provider: 'fixture', model: 'fixture', routeMode: 'native', os: 'win32', health: 'ready', credentialsReady: true, capabilities: ['text'], permissions: [], network: 'offline', dataScopes: ['synthetic'], maxCashMinor: 10, priceVerified: true, quotaRemaining: 100, concurrencyLimit: 3, activeCount: 0, isolation: 'fixture_only' };
}
function planFromFrozen(frozen: FrozenProjectInput): WorkflowPlan {
  const checks = frozen.acceptance.flatMap((criterion): AcceptanceCheck[] => {
    const check = criterion.check;
    if (!check) return [];
    return check.kind === 'json_equals'
      ? [{ id: criterion.id, version: 1, kind: 'json_equals', artifactId: 'result', expected: check.expected as never }]
      : [{ id: criterion.id, version: 1, kind: 'present', artifactId: 'result' }];
  });
  const candidates = [descriptor('a', 'dsh'), descriptor('b', 'codex')].map((d) => ({ id: d.id, executorKind: d.executorKind, version: d.runtime, provider: d.provider, model: d.model, routeMode: d.routeMode, concurrencyLimit: d.concurrencyLimit }));
  const steps = frozen.planRuntime.map((s, i) => ({ stepId: s.stepId, workerId: i % 2 ? 'b' : 'a', description: s.description, dependsOn: [...(s.dependsOn ?? [])], input: '{"ok":true}', contract: { version: 1, checks } }));
  return { planId: 'p-' + frozen.projectId, version: 1, category: 'project-input', policyVersion: 'supervisor-v1', candidates, steps };
}
function setup(t: { after(fn: () => void): void }, behavior: 'echo' | 'invalid' | 'first_invalid' = 'echo') {
  const dir = mkdtempSync(join(tmpdir(), 'daming s7 pipeline '));
  const store = new SqliteStore(join(dir, 'tasks.sqlite'));
  const inputs = new ProjectInputStore(dir, () => Date.parse('2026-11-19T00:00:00Z'));
  t.after(() => { inputs.close(); store.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const engine = new Engine(store);
  const coordinator = new TaskCoordinator({
    store, engine, authorization: 'synthetic-approved',
    workers: [
      { descriptor: descriptor('a', 'dsh'), worker: new FixtureWorker('dsh', { delayMs: 1 }), behavior },
      { descriptor: descriptor('b', 'codex'), worker: new FixtureWorker('codex', { delayMs: 1 }) }
    ]
  });
  return { dir, store, inputs, engine, coordinator };
}
function frozen(inputs: ProjectInputStore, projectId: string): FrozenProjectInput {
  return inputs.submitProject({
    ownerId: 'owner',
    spec: [{ id: 'deliver', text: 'Return ok', check: { kind: 'json_equals', expected: { ok: true } } }],
    planBaseline: [{ stepId: 'one', description: 'first' }, { stepId: 'two', description: 'second', dependsOn: ['one'] }],
    naturalLanguage: '本轮只做核心功能，不作为验收标准',
    projectId
  });
}

test('提交→冻结→派工→按 spec 验收→交付全链路（两 Worker）', async (t) => {
  const h = setup(t);
  const input = frozen(h.inputs, 'proj-1');
  const plan = planFromFrozen(input);
  h.coordinator.createTask({ taskId: 'pipeline', title: 'Project pipeline', goal: input.naturalLanguage ?? 'project pipeline', plan, limitMinor: 100 });
  await h.coordinator.run('pipeline');
  const task = h.engine.getTask('pipeline')!;
  assert.equal(task.status, 'completed');
  assert.equal(task.workflow!.assignments.length, 2);
  assert.ok(new Set(task.workflow!.assignments.map((a) => a.workerId)).size === 2);
  assert.ok(task.workflow!.reviews.length === 2 && task.workflow!.reviews.every((r) => r.verdict === 'pass'));
  assert.equal(h.coordinator.externalModelRequests, 0);
  // 版本可追溯：冻结记录仍在，验收来自 spec
  const history = h.inputs.history('proj-1');
  assert.equal(history.length, 1);
  assert.deepEqual(input.acceptance.map((c) => c.id), ['deliver']);
  assert.equal(input.naturalLanguageIsAcceptance, false);
});

test('执行失败分支：返工耗尽后阻断，不降低 spec 合同版本', async (t) => {
  const h = setup(t, 'invalid');
  const input = frozen(h.inputs, 'proj-2');
  const plan = planFromFrozen(input);
  h.coordinator.createTask({ taskId: 'pipeline-fail', title: 'Project pipeline fail', goal: input.naturalLanguage ?? 'project pipeline', plan, limitMinor: 100 });
  await h.coordinator.run('pipeline-fail');
  const task = h.engine.getTask('pipeline-fail')!;
  assert.equal(task.status, 'blocked');
  assert.equal(task.workflow!.assignments.filter((a) => a.stepId === 'one').length, 2);
  assert.ok(task.workflow!.plan.steps.every((s) => s.contract.version === 1));
});

test('冲突输入（plan 降低验收）仍以 spec 为准进入流水线', async (t) => {
  const h = setup(t);
  const input = h.inputs.submitProject({
    ownerId: 'owner',
    spec: [{ id: 'deliver', text: 'Return ok', check: { kind: 'json_equals', expected: { ok: true } } }],
    planBaseline: [{ stepId: 'one', description: 'first', waives: ['deliver'] }],
    naturalLanguage: 'scope',
    projectId: 'proj-3'
  });
  assert.equal(input.status, 'frozen_spec_precedence');
  assert.deepEqual(input.acceptance.map((c) => c.id), ['deliver']);
  const plan = planFromFrozen(input);
  h.coordinator.createTask({ taskId: 'pipeline-precedence', title: 'Precedence', goal: input.naturalLanguage ?? 'project pipeline', plan, limitMinor: 100 });
  await h.coordinator.run('pipeline-precedence');
  assert.equal(h.engine.getTask('pipeline-precedence')!.status, 'completed');
});
