import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Engine, WorkflowPlan } from '@daming/core';
import type { SqliteStore } from '@daming/store-sqlite';
import type { WorkerDescriptor, WorkerResult, WorkerSession, SessionContext } from '@daming/workers';
import type { TaskDeliveryView } from '@daming/contracts';
import { TaskCoordinator } from './task-coordinator.ts';

export const LOCAL_DELIVERY_CATEGORY = 'task7-local-delivery';
const TASK_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
type Stage = 'outline' | 'constraints' | 'draft' | 'verify';

const stages: readonly Stage[] = ['outline', 'constraints', 'draft', 'verify'];
const names: Record<Stage, string> = {
  outline: 'local-analyst', constraints: 'local-risk-reviewer',
  draft: 'local-writer', verify: 'local-independent-reviewer'
};

export class LocalDeliveryError extends Error {}

function safeDir(root: string, taskId: string, create = true): string {
  if (!TASK_ID.test(taskId)) throw new LocalDeliveryError('invalid_local_task_id');
  const parent = resolve(root);
  if (!existsSync(parent)) {
    if (!create) throw new LocalDeliveryError('local_root_missing');
    mkdirSync(parent, { recursive: true, mode: 0o700 });
  }
  if (lstatSync(parent).isSymbolicLink()) throw new LocalDeliveryError('local_root_is_link');
  const dir = join(parent, taskId);
  if (!existsSync(dir)) {
    if (!create) throw new LocalDeliveryError('local_task_missing');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const stats = lstatSync(dir);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new LocalDeliveryError('local_task_path_not_private');
  return dir;
}

function readFixed(dir: string, filename: 'brief.json' | 'constraints.json' | 'report.md' | 'review.json'): string {
  const path = join(dir, filename);
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size > 24_000) {
    throw new LocalDeliveryError('local_artifact_integrity_failed');
  }
  return readFileSync(path, 'utf8');
}

function writeFixed(dir: string, filename: 'brief.json' | 'constraints.json' | 'report.md' | 'review.json', content: string): void {
  if (Buffer.byteLength(content, 'utf8') > 24_000) throw new LocalDeliveryError('local_artifact_too_large');
  // Exclusive creation: retries, pre-planted links and existing outputs must never be overwritten.
  writeFileSync(join(dir, filename), content, { flag: 'wx', mode: 0o600 });
}

function parseRecord(value: string): Record<string, unknown> {
  const data: unknown = JSON.parse(value);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new LocalDeliveryError('invalid_local_artifact');
  return data as Record<string, unknown>;
}

function cleanGoal(goal: string): string {
  if (typeof goal !== 'string' || !goal.trim() || goal.length > 2000 || goal.includes('\u0000')) {
    throw new LocalDeliveryError('invalid_local_delivery_goal');
  }
  return goal.trim();
}

function reportText(goal: string): string {
  const quoted = goal.split(/\r?\n/).map((line) => '> ' + line).join('\n');
  return [
    '# 大铭本地交付报告', '', '## 任务目标', quoted, '',
    '## 执行摘要',
    '本交付由受控的本地规则型 Worker 生成，不包含外部检索或 AI 模型推理。', '',
    '## 工作步骤',
    '1. 分析 Worker 将任务目标整理为固定结构。',
    '2. 约束 Worker 并行确认权限和成本边界。',
    '3. 写作 Worker 在大铭独立工作区生成本文件。',
    '4. 独立审核 Worker 核对磁盘内容与冻结任务目标。', '',
    '## 权限与成本',
    '- 仅允许写入大铭专用任务目录内的固定四个文件。',
    '- 不运行 Shell，不访问网络，不读取现有项目文件。',
    '- 本地执行的外部模型费用为 ¥0.00；不代表真实模型任务的计费。', '',
    '## 后续工作',
    '本文件是安全交付管线的离线基线，实际研究、编码或模型产出需要单独授权并验证。', ''
  ].join('\n');
}

function inspect(root: string, taskId: string, expectedGoal: string): { content: string; valid: boolean } {
  const dir = safeDir(root, taskId, false);
  const brief = parseRecord(readFixed(dir, 'brief.json'));
  const constraints = parseRecord(readFixed(dir, 'constraints.json'));
  const content = readFixed(dir, 'report.md');
  const valid = brief.taskId === taskId && brief.goal === expectedGoal && brief.stage === 'outline' &&
    constraints.taskId === taskId && constraints.stage === 'constraints' &&
    constraints.network === 'disabled' && constraints.shell === 'disabled' &&
    constraints.allowedFiles === 4 && content === reportText(expectedGoal);
  return { content, valid };
}

/** Verified file is served only after the complete workflow has passed its independent audit. */
export function readLocalDelivery(root: string, taskId: string, expectedGoal: string): TaskDeliveryView {
  const inspection = inspect(root, taskId, expectedGoal);
  const review = parseRecord(readFixed(safeDir(root, taskId, false), 'review.json'));
  if (!inspection.valid || review.taskId !== taskId || review.stage !== 'verify' || review.valid !== true) {
    throw new LocalDeliveryError('local_delivery_integrity_failed');
  }
  return { taskId, filename: 'report.md', content: inspection.content, verified: true };
}

class LocalDeliveryWorker implements WorkerSession {
  private readonly sessions = new Map<string, { context: SessionContext; cancelled: boolean }>();
  private readonly stage: Stage;
  private readonly root: string;
  constructor(stage: Stage, root: string) { this.stage = stage; this.root = root; }

  createSession(context: SessionContext): void {
    if (this.sessions.has(context.sessionId)) throw new LocalDeliveryError('duplicate_local_session');
    if (!TASK_ID.test(context.taskId)) throw new LocalDeliveryError('invalid_local_task_id');
    const input = parseRecord(context.input.text);
    if (input.stage !== this.stage || typeof input.goal !== 'string' ||
        Object.keys(input).some((key) => key !== 'stage' && key !== 'goal')) {
      throw new LocalDeliveryError('local_stage_binding_mismatch');
    }
    cleanGoal(input.goal);
    this.sessions.set(context.sessionId, { context, cancelled: false });
  }

  async run(sessionId: string): Promise<WorkerResult> {
    const state = this.sessions.get(sessionId);
    if (!state) throw new LocalDeliveryError('unknown_local_session');
    this.sessions.delete(sessionId);
    const { context } = state;
    const goal = cleanGoal(parseRecord(context.input.text).goal as string);
    const dir = safeDir(this.root, context.taskId);
    if (state.cancelled) return {
      mode: 'real', sessionId, taskId: context.taskId, runId: context.runId,
      attemptId: context.attemptId, status: 'cancelled', output: '', events: []
    };

    let valid = true;
    if (this.stage === 'outline') {
      writeFixed(dir, 'brief.json', JSON.stringify({ stage: 'outline', taskId: context.taskId, goal }) + '\n');
    } else if (this.stage === 'constraints') {
      writeFixed(dir, 'constraints.json', JSON.stringify({
        stage: 'constraints', taskId: context.taskId, network: 'disabled',
        shell: 'disabled', allowedFiles: 4
      }) + '\n');
    } else if (this.stage === 'draft') {
      if (parseRecord(readFixed(dir, 'brief.json')).goal !== goal ||
          parseRecord(readFixed(dir, 'constraints.json')).network !== 'disabled') {
        throw new LocalDeliveryError('local_inputs_changed');
      }
      writeFixed(dir, 'report.md', reportText(goal));
    } else {
      valid = inspect(this.root, context.taskId, goal).valid;
      if (valid) writeFixed(dir, 'review.json', JSON.stringify({
        stage: 'verify', taskId: context.taskId, valid: true
      }) + '\n');
    }

    return {
      mode: 'real', sessionId, taskId: context.taskId, runId: context.runId,
      attemptId: context.attemptId, status: 'completed',
      output: JSON.stringify({ stage: this.stage, valid }),
      events: [{ type: 'local_artifact_written_or_checked' }]
    };
  }

  cancel(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state) state.cancelled = true;
  }
}

function descriptor(stage: Stage): WorkerDescriptor {
  return {
    id: names[stage], executorKind: 'local', executionMode: 'real',
    runtime: 'local-delivery-v1', provider: 'local', model: 'none', routeMode: 'native',
    os: 'win32', health: 'ready', credentialsReady: true, capabilities: ['text'],
    permissions: ['workspace.read', 'workspace.write'], network: 'offline', dataScopes: ['synthetic'],
    maxCashMinor: 0, priceVerified: true, quotaRemaining: 1000,
    concurrencyLimit: 2, activeCount: 0, isolation: 'supervised', billingSource: 'local'
  };
}

export const LOCAL_DELIVERY_WORKERS: readonly WorkerDescriptor[] = Object.freeze(stages.map((stage) => Object.freeze(descriptor(stage))));

export function createLocalDeliveryPlan(taskId: string, goalInput: string): WorkflowPlan {
  const goal = cleanGoal(goalInput);
  const step = (stage: Stage, dependsOn: string[]) => ({
    stepId: stage, description: {
      outline: '整理任务目标', constraints: '独立核对执行边界',
      draft: '在隔离工作区生成报告', verify: '独立读取并验收交付文件'
    }[stage],
    workerId: names[stage], dependsOn, input: JSON.stringify({ stage, goal }),
    maxReworks: 0, contract: {
      version: 1, checks: [{ id: 'verified-result', version: 1, artifactId: 'result',
        kind: 'json_equals' as const, expected: { stage, valid: true } }]
    }
  });
  return {
    planId: 'local-' + taskId, version: 1, category: LOCAL_DELIVERY_CATEGORY,
    policyVersion: 'supervisor-v1',
    candidates: stages.map((stage) => {
      const d = descriptor(stage);
      return {
        id: d.id, executorKind: d.executorKind, executionMode: 'real' as const,
        version: d.runtime, provider: d.provider, model: d.model,
        routeMode: d.routeMode, concurrencyLimit: d.concurrencyLimit
      };
    }),
    steps: [
      step('outline', []), step('constraints', []),
      step('draft', ['outline', 'constraints']), step('verify', ['draft'])
    ]
  };
}

export function createLocalDeliveryCoordinator(store: SqliteStore, engine: Engine, root: string): TaskCoordinator {
  return new TaskCoordinator({
    store, engine, authorization: 'synthetic-approved',
    executionMode: 'real', approvalMode: 'manual',
    workers: stages.map((stage) => ({
      descriptor: descriptor(stage), worker: new LocalDeliveryWorker(stage, root)
    }))
  });
}
