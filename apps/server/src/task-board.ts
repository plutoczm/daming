import type {
  BudgetView, ReconciliationView, TaskAssignmentView, TaskDetailView, TaskEventView, TaskProgressView, TaskReviewView,
  TaskStatus, TaskStepView, TaskSummaryView, WorkerRouteView
} from '@daming/contracts';
import type { Task } from '@daming/core';
import type { SqliteStore } from '@daming/store-sqlite';
import { routeWorkers } from '@daming/workers';
import type { RoutingRequest, WorkerDescriptor } from '@daming/workers';
import { BOARD_WORKERS } from './board-fixture.ts';
import { LOCAL_DELIVERY_CATEGORY, LOCAL_DELIVERY_WORKERS } from './local-delivery.ts';
import { PROJECT_PREVIEW_CATEGORY, PROJECT_PREVIEW_WORKERS } from './project-agents.ts';

const ROUTING_REQUEST: RoutingRequest = {
  os: 'win32', provider: 'fixture', model: 'fixture', routeMode: 'native',
  capabilities: ['text'], permissions: [], network: 'offline', dataScope: 'synthetic',
  maxCashMinor: 10, allowFixture: true
};

function budgetFor(store: SqliteStore, taskId: string): BudgetView | null {
  const budget = store.governanceGet('budgets', taskId);
  return budget ? {
    currency: budget.currency, limitMinor: budget.limitMinor, spentMinor: budget.spentMinor,
    heldMinor: budget.heldMinor, breached: budget.breached
  } : null;
}

function reconciliationsFor(store: SqliteStore, taskId: string): ReconciliationView[] {
  return store.governanceList('executions', taskId)
    .filter((execution) => execution.status === 'needs_reconciliation')
    .map((execution) => {
      const quote = store.governanceGet('quotes', execution.operation.quoteId);
      const reservation = store.governanceGet('reservations', execution.id);
      return {
        operationId: execution.id,
        billingSource: quote?.billingSource ?? reservation?.billingSource ?? 'unknown',
        heldCashMinor: reservation?.heldCashMinor ?? reservation?.maximumCashMinor ?? 0,
        maximumCashMinor: reservation?.maximumCashMinor ?? 0,
        reason: execution.outcome?.status === 'unknown' ? execution.outcome.reason : null
      };
    });
}

function progressFor(task: Task, store: SqliteStore): TaskProgressView {
  const workflow = task.workflow;
  if (!workflow) return { totalSteps: 0, completedSteps: 0, assignmentCount: 0, reviewCount: 0 };
  let completedSteps = 0;
  for (const step of workflow.plan.steps) {
    const assignment = workflow.assignments.filter((item) => item.stepId === step.stepId).at(-1);
    const review = assignment ? workflow.reviews.find((item) => item.assignmentId === assignment.assignmentId) : undefined;
    if (review?.verdict === 'pass') completedSteps++;
  }
  return {
    totalSteps: workflow.plan.steps.length,
    completedSteps,
    assignmentCount: workflow.assignments.length,
    reviewCount: workflow.reviews.length
  };
}

export function toTaskSummary(store: SqliteStore, task: Task): TaskSummaryView {
  return {
    taskId: task.taskId, title: task.title, goal: task.goal, status: task.status as TaskStatus,
    createdAt: task.createdAt, updatedAt: task.updatedAt, budget: budgetFor(store, task.taskId),
    progress: progressFor(task, store)
  };
}

function workerRoutesFor(task: Task): WorkerRouteView[] {
  const workflow = task.workflow;
  if (!workflow) return [];
  const local = workflow.plan.category === LOCAL_DELIVERY_CATEGORY;
  const project = workflow.plan.category === PROJECT_PREVIEW_CATEGORY;
  const source = project ? PROJECT_PREVIEW_WORKERS : local ? LOCAL_DELIVERY_WORKERS : BOARD_WORKERS;
  const candidates = workflow.plan.candidates
    .map((candidate) => source.find((worker) => worker.id === candidate.id &&
      worker.runtime === candidate.version && worker.provider === candidate.provider &&
      worker.model === candidate.model))
    .filter((worker): worker is WorkerDescriptor => worker !== undefined);
  if (!candidates.length) return [];
  const request: RoutingRequest = local ? {
    ...ROUTING_REQUEST, provider: 'local', model: 'none',
    permissions: ['workspace.read', 'workspace.write'],
    maxCashMinor: 0, allowFixture: false, allowReal: true
  } : ROUTING_REQUEST;
  return workflow.plan.steps.map((step) => {
    // For frozen local roles, never display another role as the candidate for this step.
    const fixed = local || project;
    const assigned = candidates.find((item) => item.id === step.workerId);
    const specific: RoutingRequest = project && assigned ? {
      ...ROUTING_REQUEST,
      provider: assigned.provider, model: assigned.model,
      network: assigned.network, dataScope: 'workspace',
      permissions: assigned.executorKind === 'local' ? ['workspace.read','workspace.write'] : [],
      maxCashMinor: assigned.maxCashMinor ?? 0, allowFixture: false, allowReal: true
    } : request;
    const decision = routeWorkers(fixed ? candidates.filter((item) => item.id === step.workerId) : candidates, specific);
    return {
      stepId: step.stepId,
      assignedWorkerId: step.workerId,
      selectedWorkerId: decision.selected?.id ?? null,
      eligibleWorkerIds: decision.eligible.map((worker) => worker.id),
      excluded: decision.excluded.map((item) => ({ workerId: item.workerId, reasons: [...item.reasons] }))
    };
  });
}

export function toTaskDetail(store: SqliteStore, task: Task): TaskDetailView {
  const summary = toTaskSummary(store, task);
  const workflow = task.workflow;
  if (!workflow) {
    return {
      ...summary, blockedReason: task.blockedReason ?? null, plan: null, assignments: [], reviews: [], decisions: [],
      workerRoutes: [], approvals: [], reconciliations: reconciliationsFor(store, task.taskId), events: store.listEvents(task.taskId).map(eventView),
      audit: store.listGovernanceAudit(task.taskId).map((item) => ({
        sequence: item.sequence ?? null, type: item.type, at: new Date(item.atMs).toISOString(),
        amountMinor: item.amountMinor ?? null
      }))
    };
  }
  const effects = new Map(store.effectsForTask(task.taskId).map((effect) => [effect.effectId, effect.status]));
  const reviews = workflow.reviews;
  const assignments: TaskAssignmentView[] = workflow.assignments.map((assignment) => {
    const review = reviews.find((item) => item.assignmentId === assignment.assignmentId);
    const delivery = assignment.delivery;
    return {
      assignmentId: assignment.assignmentId, stepId: assignment.stepId, workerId: assignment.workerId,
      stepAttempt: assignment.stepAttempt, effectStatus: effects.get(assignment.effectId) ?? 'pending',
      effectId: assignment.effectId,
      deliveryStatus: delivery?.status ?? null, reviewVerdict: review?.verdict ?? null,
      artifactKeys: delivery ? Object.keys(delivery.artifacts) : [],
      resultPreview: delivery ? preview(delivery.artifacts) : null,
      startedAt: delivery?.startedAt ?? null,
      endedAt: delivery?.endedAt ?? null
    };
  });
  const reviewViews: TaskReviewView[] = reviews.map((review) => ({
    assignmentId: review.assignmentId, verdict: review.verdict, reasons: [...review.reasons]
  }));
  const steps: TaskStepView[] = workflow.plan.steps.map((step) => ({
    stepId: step.stepId, description: step.description, workerId: step.workerId,
    dependsOn: [...step.dependsOn], maxReworks: step.maxReworks ?? 1
  }));
  return {
    ...summary,
    blockedReason: task.blockedReason ?? null,
    plan: {
      planId: workflow.plan.planId, version: workflow.plan.version, category: workflow.plan.category,
      policyVersion: workflow.plan.policyVersion, steps
    },
    assignments,
    reviews: reviewViews,
    decisions: workflow.decisions.map((decision) => ({
      sequence: decision.sequence, reason: decision.reason, samples: decision.samples.length,
      previousConcurrency: decision.previous.concurrency, nextConcurrency: decision.next.concurrency
    })),
    workerRoutes: workerRoutesFor(task),
    approvals: store.governanceList('approvals', task.taskId)
      .map((approval) => ({ operationId: approval.operationId, status: approval.status, expiresAt: new Date(approval.expiresMs).toISOString() }))
      .sort((a, b) => a.operationId.localeCompare(b.operationId)),
    reconciliations: reconciliationsFor(store, task.taskId),
    events: store.listEvents(task.taskId).map(eventView),
    audit: store.listGovernanceAudit(task.taskId).map((item) => ({
      sequence: item.sequence ?? null, type: item.type, at: new Date(item.atMs).toISOString(),
      amountMinor: item.amountMinor ?? null
    }))
  };
}

function preview(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

function eventView(event: ReturnType<SqliteStore['listEvents']>[number]): TaskEventView {
  return { sequence: event.sequence, type: event.type, occurredAt: event.occurredAt, sourceId: event.sourceId };
}
