import { useEffect, useMemo, useState } from 'react';
import type { TaskStatus, TaskSummaryView } from '@daming/contracts';

const STORAGE_KEY = 'daming.board.columns.v1';

const STATUS_LABELS: Record<TaskStatus, string> = {
  draft: '草稿', planned: '已规划', awaiting_approval: '待审批', queued: '排队中',
  running: '执行中', reviewing: '验收中', completed: '已完成', blocked: '已阻塞',
  failed: '失败', cancelled: '已取消'
};

interface ColumnDef {
  readonly id: string;
  readonly title: string;
  readonly tone: 'idle' | 'warn' | 'run' | 'review' | 'ok' | 'bad';
  readonly statuses: readonly TaskStatus[];
}

const COLUMNS: readonly ColumnDef[] = [
  { id: 'backlog', title: '待规划', tone: 'idle', statuses: ['draft', 'planned'] },
  { id: 'approval', title: '待审批', tone: 'warn', statuses: ['awaiting_approval'] },
  { id: 'running', title: '执行中', tone: 'run', statuses: ['queued', 'running'] },
  { id: 'review', title: '验收中', tone: 'review', statuses: ['reviewing'] },
  { id: 'done', title: '已完成', tone: 'ok', statuses: ['completed'] },
  { id: 'trouble', title: '异常', tone: 'bad', statuses: ['blocked', 'failed', 'cancelled'] }
];

function money(minor: number | null | undefined): string {
  if (minor === null || minor === undefined) return '—';
  return `¥${(minor / 100).toFixed(2)}`;
}
function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}

/** HiFox-style status board. Column order/hiding is a local view setting; task status is never mutated here. */
export function TaskBoard({ tasks, selectedId, onSelect }: {
  tasks: readonly TaskSummaryView[];
  selectedId: string | null;
  onSelect: (taskId: string) => void;
}) {
  const [order, setOrder] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as { order?: unknown; hidden?: unknown } | null;
      const valid = Array.isArray(saved?.order) ? saved.order.filter((id): id is string => typeof id === 'string' && COLUMNS.some((c) => c.id === id)) : [];
      return [...new Set([...valid, ...COLUMNS.map((c) => c.id)])];
    } catch { return COLUMNS.map((c) => c.id); }
  });
  const [hidden, setHidden] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as { hidden?: unknown } | null;
      return Array.isArray(saved?.hidden) ? saved.hidden.filter((id): id is string => typeof id === 'string') : [];
    } catch { return []; }
  });
  const [dragColumn, setDragColumn] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ order, hidden })); } catch { /* view-only preference */ }
  }, [order, hidden]);

  const byColumn = useMemo(() => {
    const map = new Map<string, TaskSummaryView[]>();
    for (const column of COLUMNS) map.set(column.id, []);
    for (const task of tasks) {
      for (const column of COLUMNS) {
        if (column.statuses.includes(task.status)) { map.get(column.id)!.push(task); break; }
      }
    }
    return map;
  }, [tasks]);

  const visible = order.filter((id) => !hidden.includes(id));
  const dropColumn = (targetId: string) => {
    if (!dragColumn || dragColumn === targetId) return;
    setOrder((current) => {
      const next = current.filter((id) => id !== dragColumn);
      const at = next.indexOf(targetId);
      next.splice(at < 0 ? next.length : at, 0, dragColumn);
      return next;
    });
    setDragColumn(null);
    setDragOver(null);
  };

  return (
    <section className="task-board" aria-label="任务看板">
      <div className="board-toolbar">
        <div><strong>任务看板</strong><span className="count">{tasks.length}</span></div>
        {hidden.length > 0 && <button type="button" className="link-btn" onClick={() => setHidden([])}>恢复全部列</button>}
        <span className="board-hint">拖拽列头可排序；列顺序/隐藏只影响本机视图</span>
      </div>
      <div className="board-scroll">
        {visible.map((columnId) => {
          const column = COLUMNS.find((c) => c.id === columnId);
          if (!column) return null;
          const items = byColumn.get(column.id) ?? [];
          return (
            <section className={`board-col tone-${column.tone} ${dragOver === column.id ? 'drag-over' : ''}`} key={column.id}
              draggable onDragStart={() => setDragColumn(column.id)}
              onDragOver={(event) => { event.preventDefault(); setDragOver(column.id); }}
              onDragLeave={() => setDragOver((current) => current === column.id ? null : current)}
              onDrop={() => dropColumn(column.id)}
              onDragEnd={() => { setDragColumn(null); setDragOver(null); }}>
              <header className="board-col-head">
                <span className={`col-dot dot-${column.tone}`} />
                <h3>{column.title}</h3>
                <span className="count">{items.length}</span>
                <button type="button" className="col-hide" title="隐藏此列" aria-label={`隐藏${column.title}列`}
                  onClick={() => setHidden((current) => [...current, column.id])}>×</button>
              </header>
              <div className="board-col-body">
                {items.map((task) => (
                  <button type="button" key={task.taskId}
                    className={`board-card ${selectedId === task.taskId ? 'selected' : ''}`}
                    onClick={() => onSelect(task.taskId)}>
                    <div className="board-card-top">
                      <span className={`status-pill status-${task.status}`}>{STATUS_LABELS[task.status]}</span>
                      <span className="board-id">{shortId(task.taskId)}</span>
                    </div>
                    <div className="board-card-title">{task.title}</div>
                    <div className="progress-track" aria-label={`进度 ${task.progress.completedSteps}/${task.progress.totalSteps}`}>
                      <span style={{ width: `${task.progress.totalSteps ? task.progress.completedSteps / task.progress.totalSteps * 100 : 0}%` }} />
                    </div>
                    <div className="board-card-meta">
                      <span>{task.progress.completedSteps}/{task.progress.totalSteps} 步</span>
                      <span>{money(task.budget?.spentMinor)}</span>
                    </div>
                  </button>
                ))}
                {!items.length && (
                  <div className="board-empty">
                    <svg viewBox="0 0 48 32" width="52" height="34" aria-hidden="true">
                      <path d="M6 16h10l4-6h12l4 6h6" fill="none" stroke="currentColor" strokeWidth="1.2" opacity=".35" />
                      <circle cx="24" cy="16" r="3.2" fill="currentColor" opacity=".35" />
                    </svg>
                    <span>暂无任务</span>
                  </div>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}
