import type { CrewChildView, CrewPlanView, CrewOverviewView, TaskSummaryView } from '@daming/contracts';
import type { CrewPlan } from './crew-planner.ts';

/**
 * Pure projection from persisted crew plans + persisted task summaries to the
 * read model the crew page renders. Nothing here invents state: a child task that
 * has no dispatch receipt stays "未派发"; a task that no longer exists stays null.
 */
export interface CrewOverviewInput {
  readonly plans: readonly CrewPlan[];
  readonly tasks: readonly TaskSummaryView[];
  readonly blockedReasons?: Readonly<Record<string, string | null>>;
  readonly generatedAt: string;
}

export function buildCrewOverview(input: CrewOverviewInput): CrewOverviewView {
  const tasks = new Map(input.tasks.map((task) => [task.taskId, task]));
  const plans: CrewPlanView[] = input.plans.map((plan) => {
    const dispatches = plan.dispatches ?? [];
    const children: CrewChildView[] = dispatches.map((record) => {
      const task = tasks.get(record.taskId);
      const assignment = plan.assignments.find((item) => item.id === record.assignmentId);
      // Advisory readiness: predecessors from the plan, resolved against persisted statuses.
      const waitingOn = (assignment?.dependsOn ?? []).filter((dependencyId) => {
        const dependencyChild = dispatches.find((item) => item.assignmentId === dependencyId);
        const dependencyStatus = dependencyChild ? tasks.get(dependencyChild.taskId)?.status : undefined;
        return dependencyStatus !== 'completed';
      });
      return {
        assignmentId: record.assignmentId,
        taskId: record.taskId,
        title: task?.title ?? assignment?.title ?? record.taskId,
        status: task?.status ?? null,
        completedSteps: task?.progress.completedSteps ?? 0,
        totalSteps: task?.progress.totalSteps ?? 0,
        agent: record.agent,
        modelId: record.modelId,
        binding: record.bound ? 'bound' : 'unbound',
        dispatchedAt: record.at,
        updatedAt: task?.updatedAt ?? null,
        blockedReason: input.blockedReasons?.[record.taskId] ?? null,
        waitingOn
      };
    });
    const statuses = children.map((child) => child.status);
    const skipped = (plan.skipped ?? []).map((entry) => ({ assignmentId: entry.assignmentId, reason: entry.reason, at: entry.at }));
    const dispatchedAssignments = new Set(dispatches.map((record) => record.assignmentId));
    const skippedAssignments = new Set(skipped.map((entry) => entry.assignmentId));
    const pending = plan.assignments.filter((item) =>
      !dispatchedAssignments.has(item.id) && !skippedAssignments.has(item.id)).length;
    return {
      planId: plan.planId,
      title: plan.title,
      goal: plan.goal,
      planner: plan.planner,
      createdAt: plan.createdAt,
      dispatchedAt: plan.dispatchedAt ?? null,
      assignments: plan.assignments.map((assignment) => ({
        id: assignment.id, title: assignment.title, description: assignment.description,
        agent: assignment.agent, providerId: assignment.providerId, modelId: assignment.modelId,
        mode: assignment.mode, rationale: assignment.rationale, ready: assignment.ready,
        ...(assignment.costTier ? { costTier: assignment.costTier } : {}),
        dependsOn: [...(assignment.dependsOn ?? [])]
      })),
      notes: [...plan.notes],
      children,
      skipped,
      progress: {
        dispatched: children.length,
        running: statuses.filter((status) => status === 'running' || status === 'queued' || status === 'reviewing' || status === 'awaiting_approval').length,
        completed: statuses.filter((status) => status === 'completed').length,
        blocked: statuses.filter((status) => status === 'blocked').length,
        failed: statuses.filter((status) => status === 'failed' || status === 'cancelled').length,
        pending
      }
    };
  });
  return { generatedAt: input.generatedAt, plans };
}

/**
 * Find the crew plan + assignment a task was dispatched from, using only persisted
 * dispatch receipts. Returns null when the task was created outside a crew plan.
 */
export function findCrewContext(
  plans: readonly CrewPlan[],
  taskId: string,
  statusOf: (taskId: string) => TaskSummaryView['status'] | null
): {
  plan: CrewPlan;
  assignmentId: string;
  siblings: { assignmentId: string; taskId: string; status: TaskSummaryView['status'] | null }[];
} | null {
  for (const plan of plans) {
    const records = plan.dispatches ?? [];
    const record = records.find((item) => item.taskId === taskId);
    if (!record) continue;
    return {
      plan,
      assignmentId: record.assignmentId,
      siblings: records.map((item) => ({
        assignmentId: item.assignmentId,
        taskId: item.taskId,
        status: statusOf(item.taskId)
      }))
    };
  }
  return null;
}