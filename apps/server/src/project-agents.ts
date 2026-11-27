import type { Engine, WorkflowPlan } from '@daming/core';
import type { SqliteStore } from '@daming/store-sqlite';
import type { WorkerDescriptor, WorkerResult, WorkerSession, SessionContext } from '@daming/workers';
import { CodexExecRun, DshExecRun } from '@daming/worker-process';
import { TaskCoordinator } from './task-coordinator.ts';
import { ProjectWorkspace, validateProjectFiles } from './project-workspace.ts';

export const PROJECT_PREVIEW_CATEGORY = 'task8-project-agent-preview';
type Stage = 'snapshot' | 'codex' | 'apply' | 'dsh' | 'verify';
const ORDER: readonly Stage[] = ['snapshot', 'codex', 'apply', 'dsh', 'verify'];
const WORKERS: Readonly<Record<Stage, string>> = {
  snapshot: 'project-snapshot-host', codex: 'project-codex-readonly',
  apply: 'project-patch-host', dsh: 'project-dsh-readonly',
  verify: 'project-verifier-host'
};

export interface ProjectAgentOptions {
  readonly workspace: ProjectWorkspace;
  readonly engine: Engine;
  readonly store: SqliteStore;
  readonly codex?: { executable: string; model?: string; ignoreUserConfig?: boolean; commandArgs?: readonly string[] };
  readonly dsh?: { executable: string; entry: string; commandArgs?: readonly string[] };
  /** Offline test doubles only. Never exposed through a browser or a production API. */
  readonly mockWorkers?: { codex: WorkerSession; dsh: WorkerSession };
  readonly cashSnapshot?: () => Promise<{ currency: string; totalMinor: number } | undefined>;
}

function descriptor(stage: Stage): WorkerDescriptor {
  const external = stage === 'codex' || stage === 'dsh';
  return {
    id: WORKERS[stage],
    executorKind: external ? stage : 'local',
    executionMode: 'real', runtime: 'project-preview-v1',
    provider: stage === 'codex' ? 'codex' : stage === 'dsh' ? 'deepseek' : 'local',
    model: stage === 'codex' ? 'codex-default' : stage === 'dsh' ? 'deepseek-default' : 'none',
    routeMode: 'native', os: 'win32',
    health: 'ready', credentialsReady: true,
    capabilities: ['text'],
    permissions: external ? [] : ['workspace.read', 'workspace.write'],
    network: external ? 'internet' : 'offline',
    dataScopes: ['workspace'], maxCashMinor: stage === 'dsh' ? 100 : stage === 'codex' ? 1 : 0,
    priceVerified: true, quotaRemaining: 100, concurrencyLimit: 1, activeCount: 0,
    isolation: 'supervised',
    billingSource: stage === 'dsh' ? 'official_api' : stage === 'codex' ? 'subscription' : 'local'
  };
}

export const PROJECT_PREVIEW_WORKERS: readonly WorkerDescriptor[] = Object.freeze(ORDER.map((stage) => Object.freeze(descriptor(stage))));

export function createProjectPreviewPlan(taskId: string, goal: string, filePaths: unknown, workspace: ProjectWorkspace): WorkflowPlan {
  const files = validateProjectFiles(filePaths);
  const input = (stage: Stage) => JSON.stringify({ stage, goal, files, sourceRoot: workspace.sourceRoot });
  const step = (stage: Stage, dependsOn: string[]) => ({
    stepId: stage, description: {
      snapshot: '从指定项目导入所选代码文件到独立副本',
      codex: '真实 Codex 只读提出结构化修改建议',
      apply: 'Host 白名单校验并只写副本',
      dsh: '真实 DSH 只读复核修改内容',
      verify: 'Host 再核对全部文件与冻结源版本'
    }[stage], workerId: WORKERS[stage], dependsOn,
    input: input(stage), maxReworks: 0,
    contract: {
      version: 1, checks: [
        stage === 'codex' || stage === 'dsh'
          ? { id: 'model-response-present', version: 1, artifactId: 'result', kind: 'present' as const }
          : { id: 'host-review-pass', version: 1, artifactId: 'result',
            kind: 'json_equals' as const, expected: { stage, valid: true } }
      ]
    }
  });
  return {
    planId: 'project-' + taskId, version: 1, category: PROJECT_PREVIEW_CATEGORY,
    policyVersion: 'supervisor-v1',
    candidates: ORDER.map((stage) => {
      const d = descriptor(stage);
      return {
        id: d.id, executorKind: d.executorKind,
        executionMode: 'real' as const, version: d.runtime,
        provider: d.provider, model: d.model, routeMode: d.routeMode,
        concurrencyLimit: d.concurrencyLimit
      };
    }),
    steps: [
      step('snapshot', []), step('codex', ['snapshot']), step('apply', ['codex']),
      step('dsh', ['apply']), step('verify', ['dsh'])
    ]
  };
}



type State = { context: SessionContext; stage: Stage; cancelled: boolean };
function readFrozen(context: SessionContext, expected: Stage, workspace: ProjectWorkspace): {
  readonly goal: string; readonly files: string[];
} {
  const value: unknown = JSON.parse(context.input.text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('project_frozen_input_missing');
  const row = value as Record<string, unknown>;
  if (row.stage !== expected || row.sourceRoot !== workspace.sourceRoot ||
    typeof row.goal !== 'string' || row.goal.length > 2000 ||
    Object.keys(row).some((key) => !['stage', 'sourceRoot', 'files', 'goal'].includes(key))) {
    throw new Error('project_frozen_input_changed');
  }
  return { goal: row.goal, files: validateProjectFiles(row.files) };
}
function lastResponse(engine: Engine, taskId: string, step: string): string {
  const task = engine.getTask(taskId);
  const workflow = task?.workflow;
  if (!workflow || task?.status !== 'running') throw new Error('project_not_active');
  const delivery = workflow.assignments.filter((assignment) => assignment.stepId === step).at(-1)?.delivery;
  const result = delivery?.artifacts.result;
  if (delivery?.status !== 'completed' || typeof result !== 'string' || !result.trim()) {
    throw new Error('project_missing_model_receipt');
  }
  return result;
}

class ProjectHostWorker implements WorkerSession {
  private readonly sessions = new Map<string, State>();
  private readonly stage: 'snapshot' | 'apply' | 'verify';
  private readonly workspace: ProjectWorkspace;
  private readonly engine: Engine;
  constructor(stage: 'snapshot' | 'apply' | 'verify', workspace: ProjectWorkspace, engine: Engine) {
    this.stage = stage; this.workspace = workspace; this.engine = engine;
  }

  createSession(context: SessionContext): void {
    if (this.sessions.has(context.sessionId)) throw new Error('duplicate_project_session');
    readFrozen(context, this.stage, this.workspace);
    this.sessions.set(context.sessionId, { context, stage: this.stage, cancelled: false });
  }
  async run(sessionId: string): Promise<WorkerResult> {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error('unknown_project_session');
    this.sessions.delete(sessionId);
    const { context } = state;
    const { files } = readFrozen(context, this.stage, this.workspace);
    if (state.cancelled) return {
      mode: 'real', sessionId, taskId: context.taskId, runId: context.runId,
      attemptId: context.attemptId, status: 'cancelled', output: '', events: []
    };
    if (this.stage === 'snapshot') {
      this.workspace.import(context.taskId, files);
    } else if (this.stage === 'apply') {
      this.workspace.apply(context.taskId, lastResponse(this.engine, context.taskId, 'codex'), files);
    } else {
      this.workspace.verify(context.taskId, lastResponse(this.engine, context.taskId, 'dsh'), files);
    }
    return {
      mode: 'real', sessionId, taskId: context.taskId, runId: context.runId,
      attemptId: context.attemptId, status: 'completed',
      output: JSON.stringify({ stage: this.stage, valid: true }),
      events: [{ type: 'host_checked_project_copy' }]
    };
  }
  cancel(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state) state.cancelled = true;
  }
}

class ProjectReadOnlyModelWorker implements WorkerSession {
  private readonly sessions = new Map<string, State & { abort?: AbortController }>();
  private readonly stage: 'codex' | 'dsh';
  private readonly workspace: ProjectWorkspace;
  private readonly options: ProjectAgentOptions;
  constructor(stage: 'codex' | 'dsh', workspace: ProjectWorkspace, options: ProjectAgentOptions) {
    this.stage = stage; this.workspace = workspace; this.options = options;
  }

  createSession(context: SessionContext): void {
    if (this.sessions.has(context.sessionId)) throw new Error('duplicate_project_model_session');
    readFrozen(context, this.stage, this.workspace);
    this.sessions.set(context.sessionId, { context, stage: this.stage, cancelled: false });
  }
  async run(sessionId: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<WorkerResult> {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error('unknown_project_model_session');
    const { context } = state;
    if (state.abort) throw new Error('project_model_already_running');
    state.abort = new AbortController();
    const signal = state.abort.signal;
    if (options.signal) options.signal.addEventListener('abort', () => state.abort?.abort(), { once: true });
    if (state.cancelled) state.abort.abort();

    const frozen = readFrozen(context, this.stage, this.workspace);
    const bundle = this.workspace.promptBundle(context.taskId, frozen.files);
    const originals = this.stage === 'dsh' ? this.workspace.promptBundle(context.taskId, frozen.files, 'source') : '';
    const prompt = this.stage === 'codex'
      ? [
          'You are reviewing a deliberately copied, selected-file-only project workspace.',
          'Do not invoke write tools, commands, network tools, or attempt to access files outside this copy.',
          'Return ONLY one JSON object: {"path":"one of the listed paths","find":"exact unique source text","replace":"replacement text"}.',
          'Use the provided file texts. Make one small and sensible improvement. No markdown fences.',
          'The Host will reject unlisted paths, non-unique matches, and extra fields.',
          'Goal: ' + readFrozen(context, this.stage, this.workspace).goal,
          'Selected file contents (JSONL):', bundle
        ].join('\n')
      : [
          'You are an independent read-only reviewer of a staged project change.',
          'Do not invoke tools, commands, network tools, or try to edit the project.',
          'Return ONLY JSON: {"approved":true|false,"reason":"concise explanation"}.',
          'Reject if the change violates the goal or appears unsafe.',
          'Goal: ' + readFrozen(context, this.stage, this.workspace).goal,
          'Original source file contents (JSONL):', originals,
          'Staged file contents (JSONL):', bundle
        ].join('\n');
    if (Buffer.byteLength(prompt, 'utf8') > 59000) throw new Error('project_model_prompt_too_large');
    const timeoutMs = options.timeoutMs ?? 180000;
    const result = this.stage === 'codex'
      ? await new CodexExecRun({
          executable: this.options.codex!.executable,
          ...(this.options.codex!.model ? { model: this.options.codex!.model } : {}),
          ...(this.options.codex!.ignoreUserConfig ? { ignoreUserConfig: true } : {}),
          ...(this.options.codex!.commandArgs ? { commandArgs: this.options.codex!.commandArgs } : {}),
          cwd: this.workspace.folder(context.taskId) + '/staged',
          prompt, timeoutMs, signal
        }).run()
      : await new DshExecRun({
          executable: this.options.dsh!.executable,
          entry: this.options.dsh!.entry,
          ...(this.options.dsh!.commandArgs ? { commandArgs: this.options.dsh!.commandArgs } : {}),
          cwd: this.workspace.folder(context.taskId) + '/staged',
          prompt, timeoutMs, signal
        }).run();
    return {
      mode: 'real', sessionId, taskId: context.taskId, runId: context.runId,
      attemptId: context.attemptId, status: result.status, output: result.output,
      events: result.events.map((event) => ({ type: event.type })),
      ...(result.usage ? { usage: result.usage } : {})
    };
  }
  cancel(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state) { state.cancelled = true; state.abort?.abort(); }
  }
}

export function createProjectPreviewCoordinator(options: ProjectAgentOptions): TaskCoordinator {
  if (!options.mockWorkers && (!options.codex || !options.dsh)) {
    throw new Error('project_models_not_configured');
  }
  const registration = (stage: Stage) => ({
    descriptor: descriptor(stage),
    worker: stage === 'snapshot' || stage === 'apply' || stage === 'verify'
      ? new ProjectHostWorker(stage, options.workspace, options.engine)
      : options.mockWorkers?.[stage] ?? new ProjectReadOnlyModelWorker(stage, options.workspace, options)
  });
  return new TaskCoordinator({
    store: options.store, engine: options.engine,
    authorization: 'synthetic-approved', approvalMode: 'manual', executionMode: 'real',
    workers: ORDER.map(registration),
    ...(options.cashSnapshot ? { cashSnapshot: options.cashSnapshot } : {})
  });
}
