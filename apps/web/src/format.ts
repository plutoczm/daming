import type { TaskStatus } from '@daming/contracts';

/** Shared display helpers (kept in one place so panels agree on formatting). */
export const STATUS_LABELS: Record<TaskStatus, string> = {
  draft: '草稿',
  planned: '已规划',
  awaiting_approval: '待审批',
  queued: '排队中',
  running: '执行中',
  reviewing: '验收中',
  completed: '已完成',
  blocked: '已阻塞',
  failed: '失败',
  cancelled: '已取消'
};

export const WORKER_LABELS: Record<string, string> = {
  'fixture-dsh': 'DSH',
  'fixture-codex': 'Codex',
  'fixture-claude-code': 'Claude Code',
  'fixture-unknown': 'Unknown',
  'codex-real': 'Codex Real',
  'dsh-real': 'DSH Real',
  'local-analyst': '本地分析 Worker',
  'local-risk-reviewer': '本地约束 Worker',
  'local-writer': '本地写作 Worker',
  'local-independent-reviewer': '独立验证 Worker',
  'project-snapshot-host': '项目副本导入 Host',
  'project-codex-readonly': 'Codex 只读建议',
  'project-patch-host': '受控变更 Host',
  'project-dsh-readonly': 'DSH 只读复核',
  'project-verifier-host': '副本完整性验证 Host'
};

export function workerLabel(workerId: string): string {
  return WORKER_LABELS[workerId] ?? workerId;
}

export function money(minor: number | null | undefined): string {
  if (minor === null || minor === undefined) return '—';
  return `¥${(minor / 100).toFixed(2)}`;
}

export function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}

export function timeOf(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString();
}