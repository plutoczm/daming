import type { ExecutionEventView, ExecutionNodeKind, ExecutionNodeState, ExecutionNodeView } from '@daming/contracts';

/**
 * Pure presentation rules for the execution graph: which column a node belongs to,
 * which animation to run for a newly persisted event, and how to label states.
 * Keeping this out of React makes the "never replay history" rule testable.
 */
export type ExecutionColumn = 'origin' | 'agents' | 'actions' | 'outcome';

export const EXECUTION_COLUMNS: readonly { readonly id: ExecutionColumn; readonly title: string; readonly hint: string }[] = [
  { id: 'origin', title: '目标与编排', hint: '用户目标 · TaskCoordinator · 计划' },
  { id: 'agents', title: 'Agent / 执行器', hint: '谁接单 · 用哪个 Runtime' },
  { id: 'actions', title: '动作与产物', hint: '执行器动作 · 交付产物' },
  { id: 'outcome', title: '验收与交付', hint: '独立验收 · 最终交付' }
];

const COLUMN_OF: Record<ExecutionNodeKind, ExecutionColumn> = {
  goal: 'origin',
  orchestrator: 'origin',
  planner: 'origin',
  handoff: 'origin',
  agent: 'agents',
  executor: 'agents',
  model: 'agents',
  tool: 'actions',
  artifact: 'actions',
  review: 'outcome',
  delivery: 'outcome'
};

export function columnOf(kind: ExecutionNodeKind): ExecutionColumn {
  return COLUMN_OF[kind] ?? 'origin';
}

export function groupNodes(nodes: readonly ExecutionNodeView[]): Record<ExecutionColumn, ExecutionNodeView[]> {
  const grouped: Record<ExecutionColumn, ExecutionNodeView[]> = { origin: [], agents: [], actions: [], outcome: [] };
  for (const node of nodes) grouped[columnOf(node.kind)].push(node);
  return grouped;
}

export const NODE_STATE_LABEL: Record<ExecutionNodeState, string> = {
  pending: '等待',
  queued: '排队',
  running: '执行中',
  done: '完成',
  failed: '失败',
  blocked: '阻塞',
  skipped: '跳过',
  unknown: '未知'
};

/** Provider/model text for a node, or the honest gap marker. */
export function modelLabel(node: Pick<ExecutionNodeView, 'providerId' | 'modelId'>): string {
  if (node.providerId && node.modelId) {
    return node.modelId.startsWith(node.providerId + '/') ? node.modelId : `${node.providerId}/${node.modelId}`;
  }
  if (node.modelId) return node.modelId;
  return '未接入供应商模型';
}

/**
 * Event IDs that were not seen before, in arrival order. Mutates `seen`, so the first
 * snapshot of a task marks all persisted history as already played.
 */
export function takeNewEventIds(events: readonly ExecutionEventView[], seen: Set<string>): string[] {
  const fresh: string[] = [];
  for (const event of events) {
    if (seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    fresh.push(event.eventId);
  }
  return fresh;
}

/** Events that can be animated: they must belong to a rendered node. */
export function animatableEvents(
  events: readonly ExecutionEventView[],
  nodeIds: ReadonlySet<string>
): ExecutionEventView[] {
  return events.filter((event) => event.nodeId !== null && nodeIds.has(event.nodeId));
}

export function edgePath(
  from: { x: number; y: number },
  to: { x: number; y: number }
): string {
  // Forward (left→right) edges get a generous horizontal lead; a wrapped column
  // (target left of source) uses a short lead so the curve does not shoot off-stage.
  const horizontal = to.x - from.x;
  const dx = horizontal >= 0
    ? Math.min(160, Math.max(24, horizontal * 0.42))
    : Math.min(48, Math.max(12, Math.abs(horizontal) * 0.2));
  return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
}