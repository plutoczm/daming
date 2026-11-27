import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '@daming/core';
import { SqliteStore } from '@daming/store-sqlite';
import { createLocalDeliveryCoordinator, createLocalDeliveryPlan, readLocalDelivery } from '../src/local-delivery.ts';
import { toTaskDetail } from '../src/task-board.ts';

function setup(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'daming local delivery '));
  const store = new SqliteStore(join(dir, 'test.sqlite'));
  const root = join(dir, 'sealed-workspace');
  const engine = new Engine(store);
  const coordinator = createLocalDeliveryCoordinator(store, engine, root);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
  });
  return { dir, store, root, engine, coordinator };
}

test('four distinct local Workers use governed real effects, manual approval, files and independent audit', async (t) => {
  const h = setup(t);
  const taskId = randomUUID();
  const goal = '整理本周研究要点，生成可核验的报告。';
  h.coordinator.createTask({
    taskId, title: '本地交付', goal,
    plan: createLocalDeliveryPlan(taskId, goal), limitMinor: 1
  });
  assert.equal(h.engine.getTask(taskId)?.status, 'awaiting_approval');
  assert.equal(existsSync(join(h.root, taskId)), false, 'creating a task cannot write deliverables');
  assert.equal(h.store.effectsForTask(taskId).length, 0, 'there are no preapproved writes');
  h.coordinator.approve(taskId);
  await h.coordinator.run(taskId);
  const task = h.engine.getTask(taskId)!;
  assert.equal(task.status, 'completed');
  assert.equal(task.workflow?.assignments.length, 4);
  assert.equal(new Set(task.workflow?.assignments.map((a) => a.workerId)).size, 4);
  assert.equal(task.workflow?.reviews.length, 4);
  assert.ok(task.workflow?.reviews.every((review) => review.verdict === 'pass'));
  const routes = toTaskDetail(h.store, task).workerRoutes;
  assert.equal(routes.length, 4);
  assert.ok(routes.every((route) => route.selectedWorkerId === route.assignedWorkerId));
  assert.ok(task.workflow?.assignments.every((assignment) => h.store.getEffect(assignment.effectId)?.status === 'succeeded'));
  assert.deepEqual(readdirSync(join(h.root, taskId)).sort(), ['brief.json', 'constraints.json', 'report.md', 'review.json']);
  const report = readLocalDelivery(h.root, taskId, goal);
  assert.equal(report.verified, true);
  assert.match(report.content, /整理本周研究要点/);
  assert.match(report.content, /不运行 Shell，不访问网络/);
  assert.ok(h.coordinator.observations.every((item) => item.approvalConsumed));
  const cash = h.store.governanceGet('budgets', taskId)!;
  assert.equal(cash.spentMinor, 0, 'offline local workers never claim provider charges');
  assert.equal(cash.heldMinor, 0);
  assert.equal(h.coordinator.externalModelRequests, 0);
  const reopened = new SqliteStore(join(h.dir, 'test.sqlite'));
  try {
    assert.equal(reopened.getTask(taskId)?.status, 'completed');
    assert.equal(reopened.governanceList('executions', taskId).length, 4);
  } finally { reopened.close(); }
});

test('modified report is rejected by independent verification, blocking downstream completion', async (t) => {
  const h = setup(t);
  const taskId = randomUUID();
  const goal = '验证最终报告必须与冻结目标完全一致';
  h.coordinator.createTask({ taskId, title: '篡改测试', goal, plan: createLocalDeliveryPlan(taskId, goal), limitMinor: 1 });
  h.coordinator.approve(taskId);
  const reportPath = join(h.root, taskId, 'report.md');
  for (let i = 0; i < 8 && !existsSync(reportPath); i++) await h.coordinator.advance(taskId);
  assert.equal(existsSync(reportPath), true, 'draft stage should have written a real file');
  assert.equal(existsSync(join(h.root, taskId, 'review.json')), false);
  writeFileSync(reportPath, 'tampered by independent test\n');
  await h.coordinator.run(taskId);
  const task = h.engine.getTask(taskId)!;
  assert.equal(task.status, 'blocked');
  assert.ok(task.workflow?.reviews.some((review) => review.verdict === 'fail'));
  assert.equal(existsSync(join(h.root, taskId, 'review.json')), false);
  assert.throws(() => readLocalDelivery(h.root, taskId, goal));
});

test('user input is content only, not a filesystem path or a shell command', async (t) => {
  const h = setup(t);
  const taskId = randomUUID();
  const goal = '..\\..\\Windows\\secret.txt\n; Remove-Item -Recurse C:\\Users\\*\n写入报告';
  h.coordinator.createTask({ taskId, title: '权限边界', goal, plan: createLocalDeliveryPlan(taskId, goal), limitMinor: 1 });
  h.coordinator.approve(taskId);
  await h.coordinator.run(taskId);
  assert.equal(h.engine.getTask(taskId)?.status, 'completed');
  assert.deepEqual(readdirSync(h.root), [taskId]);
  assert.match(readFileSync(join(h.root, taskId, 'report.md'), 'utf8'), /Remove-Item/);
  assert.equal(readLocalDelivery(h.root, taskId, goal).verified, true);
});

test('recovery never replays a claimed local file operation after process interruption', (t) => {
  const h = setup(t);
  const taskId = randomUUID();
  const goal = '模拟领取后断电';
  h.coordinator.createTask({ taskId, title: '中断任务', goal, plan: createLocalDeliveryPlan(taskId, goal), limitMinor: 1 });
  h.coordinator.approve(taskId);
  assert.equal(h.coordinator.queueReady(taskId), 2);
  const claimed = h.store.claimNext(new Date().toISOString(), taskId);
  assert.equal(claimed?.status, 'executing');
  assert.throws(() => h.coordinator.recover(taskId, false), /Confirm old executors stopped/);
  h.coordinator.recover(taskId, true);
  assert.equal(h.store.getEffect(claimed!.effectId)?.status, 'needs_reconciliation');
  assert.equal(h.engine.getTask(taskId)?.status, 'blocked');
  assert.equal(existsSync(join(h.root, taskId)), false, 'restart must not retry a previously claimed operation');
  assert.ok(h.store.governanceList('reservations', taskId).every((reservation) => reservation.actualCashMinor === undefined));
});

test('pre-planted non-directory task path fails closed without touching other files', async (t) => {
  const h = setup(t);
  const taskId = randomUUID();
  mkdirSync(h.root, { recursive: true });
  const blocked = join(h.root, taskId);
  writeFileSync(blocked, 'outside-owned-sentinel');
  h.coordinator.createTask({
    taskId, title: '拒绝预置文件', goal: '不得覆盖路径',
    plan: createLocalDeliveryPlan(taskId, '不得覆盖路径'), limitMinor: 1
  });
  h.coordinator.approve(taskId);
  await h.coordinator.run(taskId);
  assert.equal(h.engine.getTask(taskId)?.status, 'blocked');
  assert.equal(readFileSync(blocked, 'utf8'), 'outside-owned-sentinel');
  assert.deepEqual(readdirSync(h.root), [taskId]);
});
