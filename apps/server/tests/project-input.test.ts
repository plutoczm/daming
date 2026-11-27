import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ProjectInputError, ProjectInputStore } from '../src/project-input.ts';

function store(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'daming project input '));
  const s = new ProjectInputStore(dir, () => Date.parse('2026-11-19T00:00:00Z'));
  t.after(() => { s.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  return { dir, store: s };
}
const spec = [
  { id: 'goal', text: 'Deliver working build' },
  { id: 'perf', text: 'Response under 200ms', check: { kind: 'json_equals' as const, expected: { ok: true } } }
];
const planBaseline = [{ stepId: 'build', description: 'Build it' }, { stepId: 'verify', description: 'Verify it', dependsOn: ['build'] }];
const input = (extra: Record<string, unknown> = {}) => ({ ownerId: 'owner', spec, planBaseline, naturalLanguage: '本轮只做核心功能', ...extra } as never);

test('四件套冻结：spec + plan_baseline（→plan_runtime）+ progress(空) + naturalLanguage(可选)，验收只来自 spec', (t) => {
  const { store: s } = store(t);
  const frozen = s.submitProject(input({ projectId: 'project-a' }));
  assert.equal(frozen.projectId, 'project-a');
  assert.equal(frozen.revision, 1);
  assert.equal(frozen.runtimeRevision, 1);
  assert.equal(frozen.status, 'frozen');
  assert.equal(frozen.naturalLanguageIsAcceptance, false);
  assert.deepEqual(frozen.planBaseline.map((step) => step.stepId), ['build', 'verify']);
  assert.deepEqual(frozen.planRuntime.map((step) => step.stepId), ['build', 'verify']); // 初始 runtime = baseline
  assert.deepEqual(frozen.acceptance.map((c) => c.id), ['goal', 'perf']);
  assert.equal(frozen.specHash.length, 64);
  assert.equal(frozen.baselineHash.length, 64);
  assert.equal(s.getProgress('project-a'), undefined);
  assert.deepEqual(frozen.conflicts, []);
  // 自然语言可选
  const noNl = s.submitProject({ ownerId: 'owner', spec, planBaseline, projectId: 'project-nonl' });
  assert.equal(noNl.naturalLanguage, undefined);
  assert.equal(noNl.naturalLanguageIsAcceptance, false);
});

test('缺 spec / 缺 plan_baseline 即拒绝；非法 id 拒绝', (t) => {
  const { store: s } = store(t);
  assert.throws(() => s.submitProject(input({ spec: [] })), /missing_spec/);
  assert.throws(() => s.submitProject(input({ planBaseline: [] })), /missing_plan_baseline/);
  assert.throws(() => s.submitProject({ ownerId: 'o', spec, planBaseline, projectId: 'bad id!' } as never), /invalid_project_id/);
});

test('非法结构、重复 id、未知依赖/豁免、非法 check 被拒', (t) => {
  const { store: s } = store(t);
  assert.throws(() => s.submitProject(input({ spec: [{ id: 'a', text: 'x' }, { id: 'a', text: 'y' }] })), /duplicate_spec_clause/);
  assert.throws(() => s.submitProject(input({ planBaseline: [{ stepId: 'x', description: 'd' }, { stepId: 'x', description: 'd2' }] })), /duplicate_plan_step/);
  assert.throws(() => s.submitProject(input({ planBaseline: [{ stepId: 'a', description: 'd', dependsOn: ['ghost'] }] })), /plan_dependency_unknown/);
  assert.throws(() => s.submitProject(input({ planBaseline: [{ stepId: 'a', description: 'd', waives: ['ghost'] }] })), /plan_waives_unknown_clause/);
  assert.throws(() => s.submitProject(input({ spec: [{ id: 'a', text: 'x', check: { kind: 'bogus' } }] })), /invalid_spec_check/);
});

test('baseline 豁免验收 → 冲突以 spec 为准（记录但不降低验收）', (t) => {
  const { store: s } = store(t);
  const frozen = s.submitProject(input({ projectId: 'project-b', planBaseline: [{ stepId: 'build', description: 'Build', waives: ['perf'] }] }));
  assert.equal(frozen.status, 'frozen_spec_precedence');
  assert.equal(frozen.requiresHumanArbitration, true);
  assert.equal(frozen.conflicts[0]!.clauseId, 'perf');
  assert.deepEqual(frozen.acceptance.map((c) => c.id), ['goal', 'perf']);
});

test('plan_runtime 不得降低 spec 验收（提交或修订时均拒绝）', (t) => {
  const { store: s } = store(t);
  assert.throws(() => s.submitProject(input({ projectId: 'project-c', planRuntime: [{ stepId: 'build', description: 'Build', waives: ['goal'] }] })), /plan_runtime_lowers_spec/);
  s.submitProject(input({ projectId: 'project-c' }));
  assert.throws(() => s.revisePlanRuntime({ projectId: 'project-c', planRuntime: [{ stepId: 'build', description: 'x', waives: ['goal'] }], note: '尝试降级' }), /plan_runtime_lowers_spec/);
});

test('Agent 与用户沟通后修订 plan_runtime，保留历史且基于最新 spec 校验', (t) => {
  const { store: s } = store(t);
  s.submitProject(input({ projectId: 'project-r' }));
  const first = s.revisePlanRuntime({ projectId: 'project-r', planRuntime: [{ stepId: 'build', description: '细化构建' }, { stepId: 'verify', description: '细化验证', dependsOn: ['build'] }], note: '与用户确认细节' });
  assert.equal(first.runtimeRevision, 2);
  const second = s.revisePlanRuntime({ projectId: 'project-r', planRuntime: [{ stepId: 'build2', description: '再调整' }], note: '再次沟通' });
  assert.equal(second.runtimeRevision, 3);
  assert.equal(s.runtimeHistory('project-r').length, 3); // 1=初始,2,3
  assert.deepEqual(s.latest('project-r')!.planRuntime.map((x) => x.stepId), ['build2']);
  assert.throws(() => s.revisePlanRuntime({ projectId: 'project-r', planRuntime: [{ stepId: 'x', description: 'd' }], note: 'stale', expectedRuntimeRevision: 2 }), /runtime_revision_conflict/);
  assert.throws(() => s.revisePlanRuntime({ projectId: 'project-r', planRuntime: [{ stepId: 'x', description: 'd' }], note: '   ' }), /missing_note/);
});

test('progress 由 Agent 写入，阶段验收后清空再填下一阶段', (t) => {
  const { store: s } = store(t);
  s.submitProject(input({ projectId: 'project-p' }));
  const doing = s.writeProgress({ projectId: 'project-p', stage: 'S1', status: 'doing', record: '冻结完成，开始执行' });
  assert.equal(doing.stage, 'S1');
  assert.deepEqual(s.getProgress('project-p'), { ...doing });
  s.writeProgress({ projectId: 'project-p', stage: 'S1', status: 'done', record: 'S1 验收通过' });
  assert.equal(s.getProgress('project-p')!.status, 'done');
  s.clearProgress('project-p'); // 阶段验收通过后清空
  assert.equal(s.getProgress('project-p'), undefined);
  const next = s.writeProgress({ projectId: 'project-p', stage: 'S2', status: 'doing', record: '进入下一阶段' });
  assert.equal(next.stage, 'S2');
  assert.equal(s.pieces('project-p').progress!.stage, 'S2');
  assert.throws(() => s.writeProgress({ projectId: 'nope', stage: 'S1', status: 'doing', record: 'x' }), ProjectInputError);
});

test('旧 spec 版本保留可追溯、不被静默覆盖；expectedRevision 防并发覆盖；重启保留', (t) => {
  const { dir, store: s } = store(t);
  const v1 = s.submitProject(input({ projectId: 'project-h' }));
  assert.throws(() => s.submitProject(input({ projectId: 'project-h', expectedRevision: 0 })), /revision_conflict/);
  const v2 = s.submitProject(input({ projectId: 'project-h', expectedRevision: 1, naturalLanguage: '第二轮缩小范围' }));
  assert.equal(v2.revision, 2);
  const history = s.history('project-h');
  assert.equal(history.length, 2);
  assert.equal(history[0]!.naturalLanguage, '本轮只做核心功能');
  assert.equal(history[0]!.supersededBy, 2);
  s.close();
  const reopened = new ProjectInputStore(dir);
  try {
    assert.equal(reopened.latest('project-h')!.revision, 2);
    assert.equal(reopened.get('project-h', 1)!.supersededBy, 2);
  } finally { reopened.close(); }
  void v1;
});

test('非法提交不得写库', (t) => {
  const { store: s } = store(t);
  assert.throws(() => s.submitProject(input({ projectId: 'project-d', planBaseline: [{ stepId: 'a', description: 'd', waives: ['ghost'] }] })), ProjectInputError);
  assert.equal(s.latest('project-d'), undefined);
  assert.equal(s.history('project-d').length, 0);
});

test('project directory intake registry: one row per project, survives store reopen', (t) => {
  const { dir, store: s } = store(t);
  const frozen = s.submitProject(input({ projectId: 'intake-project' }));
  s.registerDirectory('intake-project', 'C:\\Projects\\intake-project', 'owner');
  const listed = s.listProjects();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].projectId, 'intake-project');
  assert.equal(listed[0].directory, 'C:\\Projects\\intake-project');
  assert.equal(listed[0].revision, frozen.revision);
  assert.equal(listed[0].specCount, 2);
  assert.equal(listed[0].planCount, 2);
  s.close();
  const reopened = new ProjectInputStore(dir);
  try {
    const again = reopened.listProjects();
    assert.equal(again.length, 1);
    assert.equal(again[0].directory, 'C:\\Projects\\intake-project');
  } finally { reopened.close(); }
});
