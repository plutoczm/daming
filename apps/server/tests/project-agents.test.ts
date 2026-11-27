import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Engine } from '@daming/core';
import { SqliteStore } from '@daming/store-sqlite';
import type { SessionContext, WorkerResult, WorkerSession } from '@daming/workers';
import { ProjectWorkspace } from '../src/project-workspace.ts';
import { createProjectPreviewCoordinator, createProjectPreviewPlan } from '../src/project-agents.ts';
import { toTaskDetail } from '../src/task-board.ts';

export class FakeReviewModel implements WorkerSession {
  readonly sessions = new Map<string, SessionContext>();
  calls = 0;
  private readonly output: string;
  private readonly unknown: boolean;
  constructor(output: string, unknown = false) { this.output = output; this.unknown = unknown; }

  createSession(context: SessionContext): void {
    if (this.sessions.has(context.sessionId)) throw new Error('same session called twice');
    this.sessions.set(context.sessionId, context);
  }
  async run(sessionId: string): Promise<WorkerResult> {
    const ctx = this.sessions.get(sessionId);
    if (!ctx) throw new Error('session absent');
    this.calls++;
    return {
      mode: 'real', sessionId, taskId: ctx.taskId, runId: ctx.runId,
      attemptId: ctx.attemptId, status: 'completed',
      output: this.output, events: [{ type: 'offline_mock_model' }],
      usage: this.unknown ? undefined : { inputTokens: 0, outputTokens: 0 }
    };
  }
  cancel(): void {}
}

function setup(t: { after(fn: () => void): void }, modelOutput?: string, reviewerOutput?: string) {
  const temp = mkdtempSync(join(tmpdir(), 'daming agents governed-'));
  const root = join(temp, 'user-project');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'sample.ts'), 'const answer = 1;\n');
  writeFileSync(join(root, '.env'), 'SECRET_SHOULD_NOT_COPY=1\n');
  const source = join(root, 'src', 'sample.ts');
  const dir = join(temp, 'host');
  mkdirSync(dir);
  const workspace = new ProjectWorkspace(root, join(dir, 'agent-previews'));
  const store = new SqliteStore(join(dir, 'governance.sqlite'));
  const engine = new Engine(store);
  const codex = new FakeReviewModel(modelOutput ?? JSON.stringify({
    path: 'src/sample.ts', find: 'answer = 1', replace: 'answer = 2'
  }));
  const dsh = new FakeReviewModel(reviewerOutput ?? JSON.stringify({
    approved: true, reason: 'Independent offline simulated review'
  }));
  const coordinator = createProjectPreviewCoordinator({
    workspace, engine, store, mockWorkers: { codex, dsh }
  });
  t.after(() => { store.close(); rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 70 }); });
  return { temp, root, source, workspace, store, engine, codex, dsh, coordinator };
}

function create(h: ReturnType<typeof setup>): string {
  const taskId = randomUUID();
  h.coordinator.createTask({
    taskId, title: 'Edit a copied source', goal: 'Change the sample variable in a temporary copy',
    plan: createProjectPreviewPlan(taskId, 'Change the sample variable in a temporary copy',
      ['src/sample.ts'], h.workspace),
    limitMinor: 200
  });
  return taskId;
}

test('two model roles and three Host steps produce a reviewed change only in the temporary copy', async (t) => {
  const h = setup(t);
  const taskId = create(h);
  assert.equal(h.engine.getTask(taskId)?.status, 'awaiting_approval');
  assert.equal(existsSync(h.workspace.folder(taskId)), false);
  assert.equal(h.codex.calls, 0);
  assert.equal(h.dsh.calls, 0);
  h.coordinator.approve(taskId);
  await h.coordinator.run(taskId);
  const task = h.engine.getTask(taskId)!;
  assert.equal(task.status, 'completed');
  assert.equal(task.workflow?.assignments.length, 5);
  assert.equal(task.workflow?.reviews.filter((review) => review.verdict === 'pass').length, 5);
  assert.equal(new Set(task.workflow?.assignments.map((assignment) => assignment.workerId)).size, 5);
  assert.equal(h.codex.calls, 1);
  assert.equal(h.dsh.calls, 1);
  assert.equal(readFileSync(h.source, 'utf8'), 'const answer = 1;\n');
  assert.equal(readFileSync(join(h.workspace.folder(taskId), 'staged', 'src', 'sample.ts'), 'utf8'),
    'const answer = 2;\n');
  const preview = h.workspace.preview(taskId, ['src/sample.ts']);
  assert.equal(preview.mergeEnabled, false);
  assert.equal(preview.originalUnchanged, true);
  assert.ok(preview.reviewerNote.includes('Independent'));
  assert.deepEqual(toTaskDetail(h.store, task).workerRoutes.map((route) => route.selectedWorkerId),
    task.workflow!.plan.steps.map((step) => step.workerId));
  const budget = h.store.governanceGet('budgets', taskId)!;
  assert.equal(budget.spentMinor, 0);
  assert.equal(budget.heldMinor, 0);
  assert.equal(h.store.governanceList('executions', taskId).length, 5);
});

test('untrusted model proposals cannot escape selected path and are not retried after failure', async (t) => {
  const h = setup(t, JSON.stringify({ path: '../../outside.ts', find: 'answer = 1', replace: 'hacked' }));
  const taskId = create(h);
  h.coordinator.approve(taskId);
  await h.coordinator.run(taskId);
  assert.equal(h.engine.getTask(taskId)?.status, 'blocked');
  assert.equal(h.codex.calls, 1);
  assert.equal(h.dsh.calls, 0);
  assert.equal(readFileSync(h.source, 'utf8'), 'const answer = 1;\n');
  const before = h.store.effectsForTask(taskId).length;
  await h.coordinator.run(taskId);
  assert.equal(h.codex.calls, 1);
  assert.equal(h.store.effectsForTask(taskId).length, before);
});

test('DSH reviewer rejection blocks completion and cannot mutate the original project', async (t) => {
  const h = setup(t, undefined, JSON.stringify({ approved: false, reason: 'Needs human attention' }));
  const taskId = create(h);
  h.coordinator.approve(taskId);
  await h.coordinator.run(taskId);
  assert.equal(h.engine.getTask(taskId)?.status, 'blocked');
  assert.equal(h.dsh.calls, 1);
  assert.equal(readFileSync(h.source, 'utf8'), 'const answer = 1;\n');
  assert.throws(() => h.workspace.preview(taskId, ['src/sample.ts']));
});

test('actual CodexExecRun/DSHExecRun subprocess protocols work with offline mock CLIs', async (t) => {
  const h = setup(t);
  const taskId = randomUUID();
  const codexFile = fileURLToPath(new URL('./fixtures/mock-project-codex.mjs', import.meta.url));
  const dshFile = fileURLToPath(new URL('./fixtures/mock-project-dsh.mjs', import.meta.url));
  const real = createProjectPreviewCoordinator({
    workspace: h.workspace, engine: h.engine, store: h.store,
    codex: { executable: process.execPath, commandArgs: [codexFile] },
    dsh: { executable: process.execPath, entry: dshFile, commandArgs: [dshFile] }
  });
  real.createTask({
    taskId, title: 'Offline actual-process contract', goal: 'Change the variable in the copied file',
    plan: createProjectPreviewPlan(taskId, 'Change the variable in the copied file', ['src/sample.ts'], h.workspace),
    limitMinor: 200
  });
  real.approve(taskId);
  await real.run(taskId);
  const task = h.engine.getTask(taskId)!;
  assert.equal(task.status, 'completed');
  assert.equal(h.workspace.preview(taskId, ['src/sample.ts']).verified, true);
  assert.equal(readFileSync(h.source, 'utf8'), 'const answer = 1;\n');
  assert.equal(real.externalModelRequests, 0);
});
