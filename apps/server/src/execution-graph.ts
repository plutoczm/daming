import type {
  AgentProfileView, ExecutionCoverageView, ExecutionEdgeView, ExecutionEventView, ExecutionGraphView,
  ExecutionNodeState, ExecutionNodeView, GatewayRequestView, ModelBindingView, TaskAssignmentView, TaskDetailView, TaskStatus
} from '@daming/contracts';
import type { CrewPlan } from './crew-planner.ts';

/**
 * Execution graph projection (UI v4).
 *
 * Every node is derived from a record the Host already persisted:
 * - `TaskDetailView` (plan steps, assignments, reviews, events, budget, approvals)
 * - the crew plan + its dispatch receipts (parent ↔ child task)
 * - `AgentProfileView` / `ModelBindingView` (runtime, provider, model)
 *
 * Fields with no persisted source are reported as `unknown` instead of being filled in,
 * and `coverage` says which facets are not recorded yet (e.g. per-task gateway usage).
 * This module is pure: no I/O, no clock, no randomness.
 */
export interface ExecutionGraphInput {
  readonly detail: TaskDetailView;
  readonly crew: {
    readonly plan: CrewPlan;
    readonly assignmentId: string;
    readonly siblings: readonly { readonly assignmentId: string; readonly taskId: string; readonly status: TaskStatus | null }[];
  } | null;
  readonly agents: readonly AgentProfileView[];
  readonly bindings: readonly ModelBindingView[];
  /** Only rows the gateway attributed to this task; unattributed rows stay out. */
  readonly gatewayRequests?: readonly GatewayRequestView[];
  readonly generatedAt: string;
}

const TASK_STATE: Record<TaskStatus, ExecutionNodeState> = {
  draft: 'pending',
  planned: 'pending',
  awaiting_approval: 'queued',
  queued: 'queued',
  running: 'running',
  reviewing: 'running',
  completed: 'done',
  blocked: 'blocked',
  failed: 'failed',
  cancelled: 'skipped'
};

export const EXECUTION_EVENT_LABELS: Record<string, string> = {
  task_created: '任务创建',
  task_transitioned: '状态变更',
  workflow_install: '计划冻结',
  workflow_assign: 'Agent 接单',
  workflow_receive: '接收 Agent 回执',
  workflow_review: '独立评审',
  workflow_supervise: '监督决策',
  effect_settled: '执行结果结算',
  effect_unknown: '执行结果未知',
  budget_set: '预算设置',
  budget_reserved: '预算预留',
  budget_settled: '预算结算',
  quote_issued: '报价生成',
  approval_issued: '授权发放',
  tool_started: '工具开始',
  tool_settled: '工具完成',
  tool_unknown: '工具未知'
};

const AGENT_FOR_WORKER: readonly { readonly match: RegExp; readonly agent: 'dsh' | 'codex' | 'claude-code' }[] = [
  { match: /dsh/i, agent: 'dsh' },
  { match: /codex/i, agent: 'codex' },
  { match: /claude/i, agent: 'claude-code' }
];

/** Worker ids are persisted runtime identities; the Harness target is a derived label. */
export function agentTargetForWorker(workerId: string): 'dsh' | 'codex' | 'claude-code' | null {
  for (const entry of AGENT_FOR_WORKER) if (entry.match.test(workerId)) return entry.agent;
  return null;
}

function latestAssignment(detail: TaskDetailView, stepId: string): TaskAssignmentView | undefined {
  return detail.assignments.filter((assignment) => assignment.stepId === stepId).at(-1);
}

function reviewVerdict(detail: TaskDetailView, assignmentId: string): string | null {
  return detail.reviews.find((review) => review.assignmentId === assignmentId)?.verdict ?? null;
}

/** Mirrors the persisted workflow semantics used by the task board (no second state machine). */
export function stepState(detail: TaskDetailView, stepId: string): ExecutionNodeState {
  const latest = latestAssignment(detail, stepId);
  if (!latest) {
    const taskState = TASK_STATE[detail.status];
    if (taskState === 'done' || taskState === 'skipped') return 'skipped';
    if (taskState === 'queued' || taskState === 'running') return 'queued';
    return 'pending';
  }
  const verdict = reviewVerdict(detail, latest.assignmentId);
  if (verdict === 'pass') return 'done';
  if (verdict === 'fail') return detail.status === 'completed' ? 'failed' : 'running';
  if (latest.effectStatus === 'needs_reconciliation') return 'blocked';
  if (latest.deliveryStatus === 'failed' || latest.deliveryStatus === 'cancelled') return 'failed';
  if (latest.effectStatus === 'succeeded') return detail.status === 'completed' ? 'done' : 'running';
  if (latest.effectStatus === 'executing' || latest.effectStatus === 'pending') return 'running';
  return 'pending';
}

function resolveModel(detail: TaskDetailView, workerId: string, input: ExecutionGraphInput): {
  providerId: string | null; modelId: string | null; runtime: string | null; evidence: ('model-binding' | 'agent-profile' | 'derived')[]; unknown: string[];
} {
  const target = agentTargetForWorker(workerId);
  const unknown: string[] = [];
  const evidence: ('model-binding' | 'agent-profile' | 'derived')[] = [];
  let providerId: string | null = null;
  let modelId: string | null = null;
  if (target) {
    // Task-scoped binding wins over tenant-scoped, mirroring dispatch injection order.
    const bindings = input.bindings.filter((binding) => binding.agent === target && binding.status === 'active');
    const scoped = bindings.find((binding) => binding.scope.kind === 'task' && binding.scope.taskId === detail.taskId)
      ?? bindings.find((binding) => binding.scope.kind === 'tenant');
    if (scoped) {
      providerId = scoped.providerId;
      modelId = scoped.modelId;
      evidence.push('model-binding', 'derived');
    } else {
      const profile = input.agents.find((agent) => agent.runtime === target && agent.providerId && agent.modelId);
      if (profile?.providerId && profile.modelId) {
        providerId = profile.providerId;
        modelId = profile.modelId;
        evidence.push('agent-profile');
      }
    }
  }
  if (!providerId) unknown.push('provider');
  if (!modelId) unknown.push('model');
  if (!target) unknown.push('runtime');
  return { providerId, modelId, runtime: target ?? workerId, evidence, unknown };
}

function nodeIdFor(kind: string, id: string): string {
  return `${kind}:${id}`;
}

interface AttributedUsage {
  readonly tokens: { readonly input: number; readonly output: number };
  readonly costMinor: number | null;
  readonly requests: number;
}

/** Sum gateway rows that the gateway itself attributed to this task and model. */
function usageForModel(
  providerId: string | null,
  modelId: string | null,
  requests: readonly GatewayRequestView[]
): AttributedUsage | null {
  if (!modelId) return null;
  const matches = requests.filter((request) =>
    request.modelId === modelId ||
    request.modelId.endsWith('/' + modelId) ||
    (providerId !== null && request.modelId === providerId + '/' + modelId));
  if (!matches.length) return null;
  const costs = matches.map((request) => request.costMinor).filter((value): value is number => typeof value === 'number');
  return {
    tokens: {
      input: matches.reduce((sum, request) => sum + request.inputTokens, 0),
      output: matches.reduce((sum, request) => sum + request.outputTokens, 0)
    },
    costMinor: costs.length ? Math.round(costs.reduce((left, right) => left + right, 0) * 100) / 100 : null,
    requests: matches.length
  };
}

export function buildExecutionGraph(input: ExecutionGraphInput): ExecutionGraphView {
  const { detail } = input;
  const nodes: ExecutionNodeView[] = [];
  const edges: ExecutionEdgeView[] = [];
  const attributedRequests = (input.gatewayRequests ?? [])
    .filter((request) => request.attribution === 'task' && request.taskId === detail.taskId);
  const modelNodes = new Map<string, { providerId: string; modelId: string; steps: string[] }>();
  const orchestratorState = TASK_STATE[detail.status];
  const latestEvent = detail.events.at(-1);
  const push = (node: ExecutionNodeView): ExecutionNodeView => { nodes.push(node); return node; };
  const link = (edge: ExecutionEdgeView): void => { edges.push(edge); };

  const goalNode = push({
    nodeId: 'goal', kind: 'goal', label: detail.title,
    detail: detail.goal.length > 180 ? detail.goal.slice(0, 180) + '…' : detail.goal,
    state: orchestratorState, stepId: null, assignmentId: null, attempt: null,
    runtime: null, providerId: null, modelId: null, tokens: null, costMinor: null,
    lastEventType: null, lastEventAt: null, error: null,
    evidence: ['task'], unknown: []
  });

  const orchestratorNode = push({
    nodeId: 'orchestrator', kind: 'orchestrator', label: 'TaskCoordinator',
    detail: '路由 · 审批 · 预算 · 独立验收',
    state: orchestratorState, stepId: null, assignmentId: null, attempt: null,
    runtime: 'host', providerId: null, modelId: null,
    tokens: null, costMinor: detail.budget?.spentMinor ?? null,
    lastEventType: latestEvent?.type ?? null, lastEventAt: latestEvent?.occurredAt ?? null,
    error: detail.blockedReason, evidence: ['task'], unknown: ['tokens']
  });
  link({ edgeId: 'goal->orchestrator', from: goalNode.nodeId, to: orchestratorNode.nodeId, kind: 'dispatch', state: orchestratorState, label: '任务目标', evidence: 'task' });

  let plannerNodeId: string | null = null;
  if (detail.plan) {
    const plannerNode = push({
      nodeId: 'planner', kind: 'planner', label: detail.plan.category,
      detail: `计划 v${detail.plan.version} · 策略 ${detail.plan.policyVersion} · ${detail.plan.steps.length} 个步骤`,
      state: orchestratorState === 'skipped' ? 'skipped' : 'done',
      stepId: null, assignmentId: null, attempt: null,
      runtime: null, providerId: null, modelId: null, tokens: null, costMinor: null,
      lastEventType: 'workflow_install', lastEventAt: null, error: null,
      evidence: ['task'], unknown: []
    });
    plannerNodeId = plannerNode.nodeId;
    link({ edgeId: 'orchestrator->planner', from: orchestratorNode.nodeId, to: plannerNode.nodeId, kind: 'dispatch', state: plannerNode.state, label: '计划冻结', evidence: 'task' });
  }

  const deliveryNode = push({
    nodeId: 'delivery', kind: 'delivery', label: '交付与审计',
    detail: `事件 ${detail.events.length} · 评审 ${detail.reviews.length} · 审计 ${detail.audit.length}`,
    state: detail.status === 'completed' ? 'done' : detail.status === 'failed' ? 'failed' : 'pending',
    stepId: null, assignmentId: null, attempt: null,
    runtime: null, providerId: null, modelId: null, tokens: null,
    costMinor: detail.budget?.spentMinor ?? null,
    lastEventType: null, lastEventAt: null, error: null,
    evidence: ['task'], unknown: []
  });

  // Resolve runtime/model for every step first: usage can only be shown on an agent
// node when exactly one step uses that model (otherwise it is a model-level total).
  const stepResolutions = new Map<string, ReturnType<typeof resolveModel>>();
  for (const step of detail.plan?.steps ?? []) {
    const resolved = resolveModel(detail, step.workerId, input);
    stepResolutions.set(step.stepId, resolved);
    if (!resolved.modelId) continue;
    const key = `${resolved.providerId ?? 'unknown'}/${resolved.modelId}`;
    const entry = modelNodes.get(key);
    if (entry) entry.steps.push(step.stepId);
    else modelNodes.set(key, { providerId: resolved.providerId ?? '', modelId: resolved.modelId, steps: [step.stepId] });
  }

  for (const step of detail.plan?.steps ?? []) {
    const agentNodeId = nodeIdFor('agent', step.stepId);
    const assignments = detail.assignments.filter((assignment) => assignment.stepId === step.stepId);
    const latest = assignments.at(-1);
    const verdict = latest ? reviewVerdict(detail, latest.assignmentId) : null;
    const resolved = stepResolutions.get(step.stepId)!;
    const modelKey = resolved.modelId ? `${resolved.providerId ?? 'unknown'}/${resolved.modelId}` : null;
    const soleUserOfModel = modelKey ? (modelNodes.get(modelKey)?.steps.length ?? 0) === 1 : false;
    const usage = soleUserOfModel ? usageForModel(resolved.providerId, resolved.modelId, attributedRequests) : null;
    const state = stepState(detail, step.stepId);
    const agentNode = push({
      nodeId: agentNodeId, kind: 'agent', label: step.workerId, detail: step.description,
      state, stepId: step.stepId, assignmentId: latest?.assignmentId ?? null, attempt: latest?.stepAttempt ?? null,
      runtime: resolved.runtime, providerId: resolved.providerId, modelId: resolved.modelId,
      tokens: usage?.tokens ?? null, costMinor: usage?.costMinor ?? null,
      lastEventType: latest ? (verdict ? 'review:' + verdict : latest.deliveryStatus ?? latest.effectStatus) : null,
      lastEventAt: latest?.endedAt ?? latest?.startedAt ?? null,
      error: latest?.deliveryStatus === 'failed' ? '交付失败' : latest?.effectStatus === 'needs_reconciliation' ? '执行结果未知，需人工核对' : null,
      evidence: ['task', ...resolved.evidence, ...(usage ? ['gateway' as const] : [])],
      unknown: [...resolved.unknown, ...(usage ? [] : ['tokens', 'cost'])]
    });
    link({
      edgeId: `${plannerNodeId ?? orchestratorNode.nodeId}->${agentNodeId}`,
      from: plannerNodeId ?? orchestratorNode.nodeId, to: agentNodeId,
      kind: 'dispatch', state, label: '派工', evidence: 'task'
    });

    if (!latest) continue;

    const toolNodeId = nodeIdFor('tool', latest.assignmentId);
    const toolState: ExecutionNodeState = latest.effectStatus === 'succeeded' ? 'done'
      : latest.effectStatus === 'needs_reconciliation' ? 'unknown'
      : latest.effectStatus === 'executing' ? 'running'
      : latest.deliveryStatus === 'failed' || latest.deliveryStatus === 'cancelled' ? 'failed'
      : 'pending';
    push({
      nodeId: toolNodeId, kind: 'tool', label: '执行器动作',
      detail: `effect ${latest.effectStatus}${latest.effectId ? ' · ' + latest.effectId : ''}${latest.deliveryStatus ? ' · delivery ' + latest.deliveryStatus : ''}`,
      state: toolState, stepId: step.stepId, assignmentId: latest.assignmentId, attempt: latest.stepAttempt,
      runtime: resolved.runtime, providerId: null, modelId: null, tokens: null, costMinor: null,
      lastEventType: latest.deliveryStatus, lastEventAt: latest.endedAt,
      error: latest.effectStatus === 'needs_reconciliation' ? '结果未知，预算保留待核对' : null,
      evidence: ['task'], unknown: ['tool_name', 'tool_input']
    });
    link({ edgeId: `${agentNodeId}->${toolNodeId}`, from: agentNodeId, to: toolNodeId, kind: 'tool', state: toolState, label: '执行', evidence: 'task' });

    const reviewNodeId = nodeIdFor('review', latest.assignmentId);
    const reviewState: ExecutionNodeState = verdict === 'pass' ? 'done' : verdict === 'fail' ? 'failed' : 'pending';
    push({
      nodeId: reviewNodeId, kind: 'review', label: '独立验收',
      detail: verdict ? `评审结论 ${verdict}` : '等待独立评审',
      state: reviewState, stepId: step.stepId, assignmentId: latest.assignmentId, attempt: latest.stepAttempt,
      runtime: 'auditor', providerId: null, modelId: null, tokens: null, costMinor: null,
      lastEventType: verdict ? 'review:' + verdict : null, lastEventAt: latest.endedAt,
      error: verdict === 'fail' ? (detail.reviews.find((item) => item.assignmentId === latest.assignmentId)?.reasons.join('；') || '评审未通过') : null,
      evidence: ['task'], unknown: []
    });
    link({ edgeId: `${toolNodeId}->${reviewNodeId}`, from: toolNodeId, to: reviewNodeId, kind: 'review', state: reviewState, label: '验收', evidence: 'task' });

    for (const key of latest.artifactKeys) {
      const artifactNodeId = nodeIdFor('artifact', key);
      if (nodes.some((node) => node.nodeId === artifactNodeId)) continue;
      push({
        nodeId: artifactNodeId, kind: 'artifact', label: key, detail: '交付产物',
        state: 'done', stepId: step.stepId, assignmentId: latest.assignmentId, attempt: latest.stepAttempt,
        runtime: null, providerId: null, modelId: null, tokens: null, costMinor: null,
        lastEventType: null, lastEventAt: latest.endedAt, error: null,
        evidence: ['task'], unknown: []
      });
      link({ edgeId: `${reviewNodeId}->${artifactNodeId}`, from: reviewNodeId, to: artifactNodeId, kind: 'return', state: 'done', label: '结果回传', evidence: 'task' });
      link({ edgeId: `${artifactNodeId}->delivery`, from: artifactNodeId, to: deliveryNode.nodeId, kind: 'delivery', state: deliveryNode.state, label: '交付', evidence: 'task' });
    }
  }

  // Model-request nodes: built only from the provider/model resolved above and from
// gateway rows the gateway attributed to this task via X-Daming-Task-Id.
  for (const [key, entry] of modelNodes) {
    const usage = usageForModel(entry.providerId || null, entry.modelId, attributedRequests);
    const modelNodeId = nodeIdFor('model', key);
    push({
      nodeId: modelNodeId, kind: 'model', label: key,
      detail: usage
        ? `模型请求 ${usage.requests} 条（按任务归属合计${entry.steps.length > 1 ? ` · ${entry.steps.length} 个步骤共用` : ''}）`
        : '尚无已归属本任务的模型请求',
      state: usage ? 'done' : 'unknown', stepId: null, assignmentId: null, attempt: null,
      runtime: null, providerId: entry.providerId || null, modelId: entry.modelId,
      tokens: usage?.tokens ?? null, costMinor: usage?.costMinor ?? null,
      lastEventType: null, lastEventAt: null, error: null,
      evidence: usage ? ['model-binding', 'gateway'] : ['model-binding'],
      unknown: usage ? [] : ['tokens', 'cost', 'requests']
    });
    for (const stepId of entry.steps) {
      link({
        edgeId: `agent:${stepId}->${modelNodeId}`, from: `agent:${stepId}`, to: modelNodeId,
        kind: 'tool', state: usage ? 'done' : 'unknown', label: '模型请求', evidence: 'gateway'
      });
    }
  }

  // Crew context: parent plan → this child task. Only persisted dispatch receipts are used.
  let crewView: ExecutionGraphView['crew'] = null;
  if (input.crew) {
    const { plan, assignmentId, siblings } = input.crew;
    const assignment = plan.assignments.find((item) => item.id === assignmentId);
    const planNodeId = 'crew:plan';
    const siblingStates = siblings.map((sibling) => TASK_STATE[sibling.status ?? 'draft']);
    const crewState: ExecutionNodeState = siblingStates.length && siblingStates.every((state) => state === 'done')
      ? 'done'
      : siblingStates.some((state) => state === 'blocked') ? 'blocked'
      : siblingStates.some((state) => state === 'failed') ? 'failed'
      : siblingStates.some((state) => state === 'running') ? 'running'
      : 'queued';
    push({
      nodeId: planNodeId, kind: 'planner', label: `编队 · ${plan.title}`,
      detail: `${plan.planner === 'main-agent' ? '主 Agent 分派' : '平台规则分派'} · ${plan.assignments.length} 个子目标`,
      state: crewState, stepId: null, assignmentId, attempt: null,
      runtime: null, providerId: assignment?.providerId ?? null, modelId: assignment?.modelId ?? null,
      tokens: null, costMinor: null, lastEventType: 'crew_dispatched', lastEventAt: plan.dispatchedAt ?? null,
      error: null, evidence: ['crew'], unknown: ['tokens', 'cost']
    });
    const handoffNodeId = 'crew:handoff';
    const plannedDependencies = assignment?.dependsOn ?? [];
    const waitingOn = plannedDependencies.filter((dependencyId) => {
      const sibling = siblings.find((item) => item.assignmentId === dependencyId);
      return sibling?.status !== 'completed';
    });
    push({
      nodeId: handoffNodeId, kind: 'handoff', label: '子目标派发',
      detail: assignment
        ? assignment.title + (waitingOn.length ? ` · 等待前置 ${waitingOn.join('、')} 交付（计划依赖，引擎不强制串行）` : '')
        : assignmentId,
      state: orchestratorState, stepId: null, assignmentId, attempt: null,
      runtime: null, providerId: assignment?.providerId ?? null, modelId: assignment?.modelId ?? null,
      tokens: null, costMinor: null, lastEventType: null, lastEventAt: plan.dispatchedAt ?? null,
      error: null, evidence: ['crew'], unknown: []
    });
    link({ edgeId: `${planNodeId}->${handoffNodeId}`, from: planNodeId, to: handoffNodeId, kind: 'dispatch', state: crewState, label: '派发回执', evidence: 'crew' });
    link({ edgeId: `${handoffNodeId}->${orchestratorNode.nodeId}`, from: handoffNodeId, to: orchestratorNode.nodeId, kind: 'handoff', state: orchestratorState, label: '交给子任务执行', evidence: 'crew' });
    crewView = {
      planId: plan.planId, title: plan.title, planner: plan.planner, assignmentId,
      siblings: siblings.map((sibling) => ({ assignmentId: sibling.assignmentId, taskId: sibling.taskId, status: sibling.status }))
    };
  }

  // Timeline: persisted task events + the crew dispatch receipt. Node attribution is
  // limited to what the Host actually stores (events carry no stepId).
  const events: ExecutionEventView[] = detail.events.map((event) => ({
    eventId: `task:${detail.taskId}:${event.sequence}`,
    at: event.occurredAt,
    type: event.type,
    label: EXECUTION_EVENT_LABELS[event.type] ?? event.type,
    nodeId: attributeEvent(event.type, plannerNodeId),
    state: eventState(event.type, detail.status),
    source: 'task' as const
  }));
  // Assignment/review timeline: derived from persisted assignment timestamps and
  // verdicts, so each entry has a stable ID and a real node to highlight.
  for (const assignment of detail.assignments) {
    const agentNodeId = nodeIdFor('agent', assignment.stepId);
    if (assignment.startedAt) {
      events.push({
        eventId: `assignment:${assignment.assignmentId}:started`, at: assignment.startedAt,
        type: 'assignment_started', label: '派工开始', nodeId: agentNodeId, state: 'running', source: 'assignment'
      });
    }
    if (assignment.endedAt) {
      const ended: ExecutionNodeState = assignment.effectStatus === 'needs_reconciliation' ? 'unknown'
        : assignment.deliveryStatus === 'failed' || assignment.deliveryStatus === 'cancelled' ? 'failed'
        : assignment.effectStatus === 'succeeded' ? 'done' : 'pending';
      events.push({
        eventId: `assignment:${assignment.assignmentId}:ended`, at: assignment.endedAt,
        type: 'assignment_ended', label: '执行结束', nodeId: agentNodeId, state: ended, source: 'assignment'
      });
    }
    const verdict = reviewVerdict(detail, assignment.assignmentId);
    if (verdict && assignment.endedAt) {
      events.push({
        eventId: `review:${assignment.assignmentId}`, at: assignment.endedAt,
        type: 'review_verdict', label: `独立验收 ${verdict}`,
        nodeId: nodeIdFor('review', assignment.assignmentId),
        state: verdict === 'pass' ? 'done' : 'failed', source: 'review'
      });
    }
  }
  if (input.crew?.plan.dispatchedAt) {
    events.push({
      eventId: `crew:${input.crew.plan.planId}:${input.crew.assignmentId}`,
      at: input.crew.plan.dispatchedAt,
      type: 'crew_dispatched',
      label: '编队派发',
      nodeId: 'crew:handoff',
      state: orchestratorState,
      source: 'crew'
    });
  }
  events.sort((left, right) => {
    if (left.at !== right.at) return left.at < right.at ? -1 : 1;
    // Same timestamp: keep the Host's own event stream first, then crew, then derived rows.
    const rank = (source: ExecutionEventView['source']) => source === 'task' ? 0 : source === 'crew' ? 1 : source === 'assignment' ? 2 : 3;
    const byRank = rank(left.source) - rank(right.source);
    return byRank !== 0 ? byRank : left.eventId.localeCompare(right.eventId);
  });

  const agentNodes = nodes.filter((node) => node.kind === 'agent');
  const attributedCount = attributedRequests.length;
  const attributionNote = attributedCount
    ? `网关已按 X-Daming-Task-Id 把 ${attributedCount} 条请求归属到本任务；未带该请求头（或来自其他任务）的请求不计入。`
    : '网关逐请求记录支持 X-Daming-Task-Id 归属，但当前没有带该请求头的记录，因此模型请求/token/费用显示为未接入。';
  const coverage: ExecutionCoverageView = {
    modelRequests: attributedCount ? 'persisted' : 'not_recorded',
    toolCalls: detail.assignments.length ? 'partial' : 'not_recorded',
    runtimeBinding: !detail.plan?.steps.length ? 'not_recorded'
      : agentNodes.some((node) => node.providerId && node.modelId) ? 'persisted'
      : agentNodes.some((node) => node.runtime) ? 'partial'
      : 'not_recorded',
    usage: attributedCount ? 'persisted' : 'not_recorded',
    notes: [
      attributionNote,
      detail.assignments.length ? '执行器动作只有 effect/delivery 状态与 effect id，工具名与入参未持久化。' : '尚无执行记录。',
      '任务事件不含 stepId，治理事件定位到协调器；派工/评审条目来自已持久化的 assignment 时间与评审结论。'
    ]
  };

  return {
    taskId: detail.taskId,
    generatedAt: input.generatedAt,
    title: detail.title,
    goal: detail.goal,
    status: detail.status,
    nodes,
    edges,
    events,
    coverage,
    crew: crewView
  };
}

function attributeEvent(type: string, plannerNodeId: string | null): string | null {
  if (type === 'workflow_install') return plannerNodeId ?? 'orchestrator';
  if (['workflow_assign', 'workflow_receive', 'workflow_review', 'workflow_supervise'].includes(type)) return null;
  if (type.startsWith('task_') || type.startsWith('budget_') || type.startsWith('approval_') ||
      type.startsWith('quote_') || type.startsWith('effect_') || type.startsWith('tool_')) {
    return 'orchestrator';
  }
  return null;
}

function eventState(type: string, status: TaskStatus): ExecutionNodeState {
  if (type === 'effect_unknown' || type === 'tool_unknown') return 'unknown';
  if (type === 'tool_settled' || type === 'effect_settled') return 'done';
  if (type === 'task_transitioned') return TASK_STATE[status];
  if (type === 'tool_started') return 'running';
  return 'done';
}