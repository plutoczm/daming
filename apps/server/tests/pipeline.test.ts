import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AvailableModelsView } from '@daming/contracts';
import { demoExecutor, planPipeline, reviewArtifacts, runPipeline, simulatePipeline } from '../src/pipeline.ts';

const CATALOG = {
  models: [
    { providerId: 'demo', modelId: 'demo-model', dispatchable: true }
  ]
} as unknown as AvailableModelsView;

test('planPipeline: 架构师拆解子目标并为每步生成评测集', () => {
  const plan = planPipeline({
    title: '交付一个功能', goal: '完成交付',
    subgoals: ['调研需求', '实现核心', '测试复核'],
    catalog: CATALOG, maxReworks: 1
  });
  assert.equal(plan.steps.length, 3);
  assert.equal(plan.steps[0]!.stepId, 'sub-1');
  for (const step of plan.steps) {
    assert.equal(step.contract.length, 2);
    assert.equal(step.contract[0]!.kind, 'present');
    assert.equal(step.contract[1]!.kind, 'json_equals');
    assert.equal(step.maxReworks, 1);
  }
});

test('runPipeline: 全部通过 → passed，记录通过通知', async () => {
  const plan = planPipeline({ title: 't', goal: 'g', subgoals: ['a', 'b'], catalog: CATALOG });
  const view = await runPipeline(plan, { executor: demoExecutor('pass'), budgetMinor: 50, costPerAttemptMinor: 1 });
  assert.equal(view.stage, 'passed');
  assert.equal(view.iteration, 2);
  assert.equal(view.spentMinor, 2);
  assert.ok(view.steps.every((step) => step.status === 'passed'));
  assert.ok(view.notifications.some((n) => n.event === 'pipeline.passed'));
});

test('runPipeline: 评审否决一次后返工通过（rework 循环）', async () => {
  const view = await simulatePipeline({ title: 't', goal: 'g', subgoals: ['a', 'b'], catalog: CATALOG, mode: 'rework' });
  assert.equal(view.stage, 'passed');
  assert.equal(view.steps[0]!.attempts, 2);
  assert.equal(view.steps[1]!.attempts, 1);
  assert.ok(view.events.some((event) => event.stage === 'rework'));
  assert.ok(view.events.some((event) => event.stage === 'reviewing'));
});

test('runPipeline: 返工用尽仍不通过 → blocked，通知需人工', async () => {
  const view = await simulatePipeline({ title: 't', goal: 'g', subgoals: ['a'], catalog: CATALOG, maxReworks: 1, mode: 'blocked' });
  assert.equal(view.stage, 'blocked');
  assert.equal(view.steps[0]!.status, 'failed');
  assert.ok(view.notifications.some((n) => n.event === 'pipeline.blocked'));
});

test('runPipeline: 额度耗尽 → budget_exhausted，且花费不超过预算', async () => {
  const view = await simulatePipeline({ title: 't', goal: 'g', subgoals: ['a', 'b', 'c'], catalog: CATALOG, mode: 'budget', budgetMinor: 100 });
  assert.equal(view.stage, 'budget_exhausted');
  assert.ok(view.spentMinor <= view.budgetMinor);
  assert.ok(view.notifications.some((n) => n.event === 'pipeline.budget_exhausted'));
});

test('runPipeline: 连续 2 次评审否决触发打扰通知', async () => {
  const plan = planPipeline({ title: 't', goal: 'g', subgoals: ['a'], catalog: CATALOG, maxReworks: 2 });
  const events: string[] = [];
  await runPipeline(plan, {
    executor: demoExecutor('blocked'), budgetMinor: 99, costPerAttemptMinor: 1,
    notify: (event) => events.push(event.event)
  });
  assert.ok(events.includes('pipeline.reviewer_reject_2'));
  assert.ok(events.includes('pipeline.blocked'));
});

test('reviewArtifacts: 对象按深包含匹配，允许额外字段', () => {
  const contract = [
    { id: 'd', kind: 'present' as const, artifactId: 'result' },
    { id: 'a', kind: 'json_equals' as const, artifactId: 'result', expected: { ok: true, agent: 'dsh' } }
  ];
  const pass = reviewArtifacts(contract, { result: { ok: true, agent: 'dsh', attempt: 3 } }, 1);
  assert.equal(pass.verdict, 'pass');
  const fail = reviewArtifacts(contract, { result: { ok: false, agent: 'dsh' } }, 1);
  assert.equal(fail.verdict, 'fail');
  assert.ok(fail.reasons.some((reason) => reason.startsWith('content_mismatch')));
});
