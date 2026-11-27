import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AvailableModelsView } from '@daming/contracts';
import { demoExecutor, planPipeline, reassignPipelineStep, runPipeline, runPipelineFrom } from '../src/pipeline.ts';
import {
  attachRoomDiscussions, createAndRunPipeline, PipelineRunStore, reassignAndRerun, rerunPipelineStage, syncPipelineRoom
} from '../src/pipeline-runs.ts';
import { AgentRoomStore } from '../src/agent-room.ts';
import { createRealPipelineRuntime, makeModelReviewer, type ModelTextPort } from '../src/pipeline-real.ts';

const CATALOG = {
  models: [{ providerId: 'demo', modelId: 'demo-model', dispatchable: true }]
} as unknown as AvailableModelsView;

test('planPipeline: 每步带分配理由与成本档', () => {
  const plan = planPipeline({ title: 't', goal: 'g', subgoals: ['a', 'b'], catalog: CATALOG });
  for (const step of plan.steps) {
    assert.equal(typeof step.rationale, 'string');
    assert.ok(step.rationale.length > 0);
    assert.ok(['low', 'mid', 'high'].includes(step.costTier));
  }
});

test('runPipelineFrom: 从第二步重跑，保留第一步已通过', async () => {
  const plan = planPipeline({ title: 't', goal: 'g', subgoals: ['a', 'b', 'c'], catalog: CATALOG });
  const full = await runPipeline(plan, { executor: demoExecutor('pass'), budgetMinor: 50, costPerAttemptMinor: 1 });
  const seed = {
    statuses: full.steps.slice(0, 1).map((step) => ({ status: step.status, attempts: step.attempts, lastReview: step.lastReview })),
    spentMinor: 0, iteration: 0
  };
  const reran = await runPipelineFrom(plan, { executor: demoExecutor('pass'), budgetMinor: 50, costPerAttemptMinor: 1, fromIndex: 1, seed });
  assert.equal(reran.steps[0]!.status, 'passed');
  assert.equal(reran.steps[1]!.status, 'passed');
  assert.equal(reran.stage, 'passed');
  assert.ok(reran.events.some((event) => event.stage === 'rework' && event.text.includes('重跑')));
});

test('reassignPipelineStep: 换 Agent 并按新 Agent 重生成评测集', () => {
  const plan = planPipeline({ title: 't', goal: 'g', subgoals: ['a'], catalog: CATALOG });
  const beforeAgent = plan.steps[0]!.agent;
  const target = beforeAgent === 'claude-code' ? 'codex' : 'claude-code';
  const next = reassignPipelineStep(plan, 'sub-1', { agent: target });
  assert.equal(next.steps[0]!.agent, target);
  assert.notEqual(next.steps[0]!.agent, beforeAgent);
  const accept = next.steps[0]!.contract.find((check) => check.kind === 'json_equals');
  assert.equal((accept as { expected?: { agent?: string } }).expected?.agent, target);
  assert.ok(next.steps[0]!.rationale.includes('人工改派'));
});

test('createAndRunPipeline + reassignAndRerun: 换 Agent 后从该阶段重跑并通过', async () => {
  const record = await createAndRunPipeline({ title: 't', goal: 'g', subgoals: ['a', 'b'], catalog: CATALOG, mode: 'pass' });
  assert.equal(record.view.stage, 'passed');
  const target = record.plan.steps[1]!.agent === 'claude-code' ? 'codex' : 'claude-code';
  const next = await reassignAndRerun(record, 'sub-2', { agent: target });
  assert.equal(next.plan.steps[1]!.agent, target);
  assert.equal(next.view.stage, 'passed');
  assert.equal(next.view.steps[0]!.status, 'passed');
});

test('rerunPipelineStage: 不改分配也能重跑指定阶段', async () => {
  const record = await createAndRunPipeline({ title: 't', goal: 'g', subgoals: ['a', 'b'], catalog: CATALOG, mode: 'pass' });
  const next = await rerunPipelineStage(record, 'sub-1');
  assert.equal(next.view.stage, 'passed');
  assert.equal(next.view.steps.length, 2);
});

test('real runtime: 真实模型执行/评审/讨论走注入文本端口，标记 executor=real、reviewer=model', async () => {
  const prompts: string[] = [];
  const port: ModelTextPort = {
    kind: 'test',
    async chat(prompt: string) {
      prompts.push(prompt);
      // 评审提示返回 PASS；执行/讨论返回结果正文。
      if (/只回复一行结论/.test(prompt)) return 'PASS 内容满足验收。';
      return '这是真实模型产出的交付物正文。';
    }
  };
  const runtime = createRealPipelineRuntime(port, 'g');
  // 评审正向：PASS → pass。
  const step = planPipeline({ title: 't', goal: 'g', subgoals: ['a'], catalog: CATALOG }).steps[0]!;
  const okReview = await makeModelReviewer(port)({ step, artifacts: { result: '交付物' }, attempt: 1 });
  assert.equal(okReview.verdict, 'pass');
  // 评审负向：模型回 FAIL → fail，含 model_reject。
  const reject = makeModelReviewer({ kind: 'test', async chat() { return 'FAIL 不满足验收。'; } });
  const badReview = await reject({ step, artifacts: { result: '不足' }, attempt: 1 });
  assert.equal(badReview.verdict, 'fail');
  assert.ok(badReview.reasons.some((reason) => reason.startsWith('model_reject')));
  // 交付物缺失 → fail，不调用模型。
  const missing = await makeModelReviewer(port)({ step, artifacts: {}, attempt: 1 });
  assert.equal(missing.verdict, 'fail');
  // 整链真实运行：留存记录标记 real / model，且全通过。
  const record = await createAndRunPipeline({ title: 't', goal: 'g', subgoals: ['a', 'b'], catalog: CATALOG, runtime });
  assert.equal(record.executorKind, 'real');
  assert.equal(record.view.executor, 'real');
  assert.equal(record.view.reviewerKind, 'model');
  assert.equal(record.view.stage, 'passed');
  assert.ok(prompts.length > 0);
});

test('syncPipelineRoom: 建协作群并把讨论回传挂到步骤，可持久化', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daming-pipe-'));
  const roomStore = new AgentRoomStore(dir);
  let record = await createAndRunPipeline({ title: 't', goal: 'g', subgoals: ['a', 'b'], catalog: CATALOG, mode: 'rework' });
  const { roomId, discussions } = await syncPipelineRoom(roomStore, record);
  assert.ok(roomId.length > 0);
  record = attachRoomDiscussions(record, roomId, discussions);
  assert.equal(record.roomId, roomId);
  assert.ok((record.view.steps[0]!.discussion?.length ?? 0) > 0);
  const room = roomStore.get(roomId);
  assert.ok(room && room.messages.length > 0);
  const store = new PipelineRunStore(dir);
  store.save(record);
  assert.ok(store.get(record.runId));
});
