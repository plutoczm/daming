import { randomUUID } from 'node:crypto';
import type { JsonValue } from '@daming/core';
import type { CreateTaskInput, CreateTaskResult, TaskDeliveryView, ProjectPreviewView, TaskDetailView, TaskSummaryView } from '@daming/contracts';
import type { SqliteStore } from '@daming/store-sqlite';
import { createBoardPlan, createRealCodexPlan, createRealDshPlan, createRealClaudePlan } from '../board-fixture.ts';
import type { TaskCoordinator } from '../task-coordinator.ts';
import { toTaskDetail, toTaskSummary } from '../task-board.ts';
import { createLocalDeliveryPlan, LOCAL_DELIVERY_CATEGORY, readLocalDelivery } from '../local-delivery.ts';
import { createProjectPreviewPlan, PROJECT_PREVIEW_CATEGORY } from '../project-agents.ts';
import type { ProjectWorkspace } from '../project-workspace.ts';

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${name} must be text`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) throw new Error(`${name} length invalid`);
  return trimmed;
}

export class TaskRouteService {
  private readonly store: SqliteStore;
  private readonly coordinator: TaskCoordinator;
  private readonly realCoordinator?: TaskCoordinator;
  private readonly dshCoordinator?: TaskCoordinator;
  private readonly claudeCoordinator?: TaskCoordinator;
  private readonly localCoordinator?: TaskCoordinator;
  private readonly localWorkspaceRoot?: string;
  private readonly projectCoordinator?: TaskCoordinator;
  private readonly projectWorkspace?: ProjectWorkspace;
  private readonly active = new Set<Promise<unknown>>();
  private readonly onChanged: () => void;

  constructor(store: SqliteStore, coordinator: TaskCoordinator, realCoordinator?: TaskCoordinator, dshCoordinator?: TaskCoordinator, onChanged: () => void = () => undefined, localCoordinator?: TaskCoordinator, localWorkspaceRoot?: string, projectCoordinator?: TaskCoordinator, projectWorkspace?: ProjectWorkspace, claudeCoordinator?: TaskCoordinator) {
    this.store = store;
    this.coordinator = coordinator;
    this.realCoordinator = realCoordinator;
    this.dshCoordinator = dshCoordinator;
    this.claudeCoordinator = claudeCoordinator;
    this.localCoordinator = localCoordinator;
    this.localWorkspaceRoot = localWorkspaceRoot;
    this.projectCoordinator = projectCoordinator;
    this.projectWorkspace = projectWorkspace;
    this.onChanged = onChanged;
  }

  private coordinatorFor(taskId: string): TaskCoordinator | undefined {
    const task = this.store.getTask(taskId);
    if (!task) return undefined;
    const category = task.workflow?.plan.category;
    if (category === 'task5-real-codex') return this.realCoordinator;
    if (category === 'task5-real-dsh') return this.dshCoordinator;
    if (category === 'task5-real-claude') return this.claudeCoordinator;
    if (category === LOCAL_DELIVERY_CATEGORY) return this.localCoordinator;
    if (category === PROJECT_PREVIEW_CATEGORY) return this.projectCoordinator;
    return this.coordinator;
  }

  list(): TaskSummaryView[] {
    return this.store.workflowHistory()
      .map((task) => toTaskSummary(this.store, task))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  detail(taskId: string): TaskDetailView | undefined {
    const task = this.store.getTask(taskId);
    return task ? toTaskDetail(this.store, task) : undefined;
  }

  delivery(taskId: string): TaskDeliveryView | undefined {
    const task = this.store.getTask(taskId);
    if (!task || task.workflow?.plan.category !== LOCAL_DELIVERY_CATEGORY) return undefined;
    if (task.status !== 'completed') throw new Error('local_delivery_not_completed');
    if (!this.localWorkspaceRoot) throw new Error('local_delivery_not_configured');
    return readLocalDelivery(this.localWorkspaceRoot, taskId, task.goal);
  }

  projectPreview(taskId: string): ProjectPreviewView | undefined {
    const task = this.store.getTask(taskId);
    if (!task || task.workflow?.plan.category !== PROJECT_PREVIEW_CATEGORY) return undefined;
    if (task.status !== 'completed') throw new Error('project_preview_not_completed');
    if (!this.projectWorkspace) throw new Error('project_preview_not_configured');
    const snapshot = task.workflow.plan.steps.find((step) => step.stepId === 'snapshot');
    if (!snapshot) throw new Error('project_preview_plan_invalid');
    const input = JSON.parse(snapshot.input) as { files: readonly string[]; sourceRoot: string };
    if (input.sourceRoot !== this.projectWorkspace.sourceRoot) throw new Error('project_preview_source_changed');
    return this.projectWorkspace.preview(taskId, input.files);
  }

  create(input: CreateTaskInput): CreateTaskResult {
    if (!input || typeof input !== 'object') throw new Error('Request body must be an object');
    const title = text(input.title, 'title', 200);
    const goal = text(input.goal, 'goal', 2000);
    const limitMinor = input.limitMinor ?? 100;
    if (!Number.isSafeInteger(limitMinor) || limitMinor < 1 || limitMinor > 100000) throw new Error('limitMinor invalid');
    const mode = input.mode ?? 'fixture';
    if (!['fixture','local','project','real','dsh','claude'].includes(mode)) throw new Error('invalid_task_mode');
    const coordinator = mode === 'real' ? this.realCoordinator : mode === 'dsh' ? this.dshCoordinator : mode === 'claude' ? this.claudeCoordinator : mode === 'local' ? this.localCoordinator : mode === 'project' ? this.projectCoordinator : this.coordinator;
    if (!coordinator) throw new Error(mode === 'dsh' ? 'real_dsh_not_configured' : mode === 'claude' ? 'real_claude_not_configured' : mode === 'local' ? 'local_delivery_not_configured' : mode === 'project' ? 'project_preview_not_configured' : 'real_codex_not_configured');
    if (mode === 'project') this.projectWorkspace!.preflight(input.filePaths);
    const taskId = randomUUID();
    const plan = mode === 'real' ? createRealCodexPlan(taskId, goal) : mode === 'dsh' ? createRealDshPlan(taskId, goal) : mode === 'claude' ? createRealClaudePlan(taskId, goal) : mode === 'local' ? createLocalDeliveryPlan(taskId, goal) : mode === 'project' ? createProjectPreviewPlan(taskId, goal, input.filePaths, this.projectWorkspace!) : createBoardPlan(taskId);
    coordinator.createTask({ taskId, title, goal, plan, limitMinor });
    if (coordinator.approvalMode !== 'manual') this.startRun(coordinator, taskId);
    this.onChanged();
    return { taskId };
  }

  private startRun(coordinator: TaskCoordinator, taskId: string): void {
    const run = coordinator.run(taskId).catch(() => {
      // The task remains in its persisted state; the UI can show the blocked/audit state.
    });
    this.active.add(run);
    this.onChanged();
    void run.then(() => { this.active.delete(run); this.onChanged(); });
  }

  reconcile(taskId: string, input: { operationId?: unknown; resolution?: unknown; actualCashMinor?: unknown; evidence?: unknown; result?: unknown }): TaskSummaryView {
    if (!input || typeof input !== 'object') throw new Error('Request body must be an object');
    const operationId = text(input.operationId, 'operationId', 200);
    const evidence = text(input.evidence, 'evidence', 2000);
    const resolution = input.resolution === 'not_executed' ? 'not_executed' : input.resolution === 'succeeded' ? 'succeeded' : undefined;
    if (!resolution) throw new Error('resolution invalid');
    let actualCashMinor: number | undefined;
    if (resolution === 'succeeded') {
      if (!Number.isSafeInteger(input.actualCashMinor) || (input.actualCashMinor as number) < 0) throw new Error('actualCashMinor invalid');
      actualCashMinor = input.actualCashMinor as number;
    }
    const task = this.store.getTask(taskId);
    if (!task) throw new Error('Unknown task');
    const coordinator = this.coordinatorFor(taskId);
    if (!coordinator) throw new Error('Task coordinator not configured');
    coordinator.reconcile(taskId, operationId, {
      resolution, evidence, ...(actualCashMinor === undefined ? {} : { actualCashMinor }),
      ...(input.result === undefined ? {} : { result: input.result as JsonValue })
    });
    this.onChanged();
    return toTaskSummary(this.store, this.store.getTask(taskId)!);
  }

  approve(taskId: string): TaskSummaryView {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error('Unknown task');
    const coordinator = this.coordinatorFor(taskId);
    if (!coordinator) throw new Error('Task coordinator not configured');
    coordinator.approve(taskId);
    this.startRun(coordinator, taskId);
    this.onChanged();
    return toTaskSummary(this.store, this.store.getTask(taskId)!);
  }

  cancel(taskId: string): TaskSummaryView | undefined {
    const task = this.store.getTask(taskId);
    if (!task) return undefined;
    if (['completed', 'failed', 'cancelled'].includes(task.status)) throw new Error('Task is already terminal');
    const coordinator = this.coordinatorFor(taskId) ?? this.coordinator;
    coordinator.cancel(taskId);
    this.onChanged();
    return toTaskSummary(this.store, this.store.getTask(taskId)!);
  }

  cancelAll(): void {
    for (const task of this.store.workflowHistory()) {
      if (['queued', 'running', 'reviewing'].includes(task.status)) {
        try { (this.coordinatorFor(task.taskId) ?? this.coordinator).cancel(task.taskId); } catch { /* terminal task */ }
      }
    }
  }

  async drain(timeoutMs = 5000): Promise<void> {
    if (!this.active.size) return;
    await Promise.race([
      Promise.allSettled([...this.active]),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
    ]);
  }
}
