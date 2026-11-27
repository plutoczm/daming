import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ExecutionGraphView, ExecutionNodeView } from '@daming/contracts';
import { createLightLayer } from './light-ui/index.ts';
import { notifyRefresh, useAdaptiveResource } from './live-refresh.ts';
import { STATUS_LABELS } from './format.ts';
import {
  EXECUTION_COLUMNS, NODE_STATE_LABEL, animatableEvents, edgePath, groupNodes, modelLabel, takeNewEventIds
} from './execution-graph-view.ts';

const EVIDENCE_LABEL: Record<string, string> = {
  persisted: '已持久化',
  partial: '部分记录',
  not_recorded: '未接入'
};

const EVENT_SCOPE_LABEL: Record<string, string> = {
  task: '任务',
  crew: '编队',
  assignment: '派工',
  review: '评审'
};

const STATE_COLOR: Record<string, string> = {
  done: '#157f43',
  running: '#4f46e5',
  queued: '#b45309',
  pending: '#8b919d',
  blocked: '#c23a3a',
  failed: '#c23a3a',
  skipped: '#8b919d',
  unknown: '#b45309'
};

async function request<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, credentials: 'same-origin' });
  if (!response.ok) {
    let reason = `HTTP ${response.status}`;
    try {
      const body = await response.json() as { reason?: string };
      reason = body.reason ?? reason;
    } catch { /* keep status */ }
    throw new Error(reason);
  }
  return await response.json() as T;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function timeLabel(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString();
}

/** Live token line for a node; only real persisted numbers are rendered. */
function usageLine(node: ExecutionNodeView): string | null {
  if (node.tokens) return `token 输入 ${node.tokens.input} · 输出 ${node.tokens.output}`;
  return null;
}

function NodeCard({ node, active, onFocus }: {
  node: ExecutionNodeView;
  active: boolean;
  onFocus: (nodeId: string) => void;
}) {
  const usage = usageLine(node);
  return (
    <article
      className={`exec-node exec-node--${node.kind} exec-node--state-${node.state}${active ? ' is-active' : ''}`}
      data-node-id={node.nodeId}
      onMouseEnter={() => onFocus(node.nodeId)}
    >
      <header className="exec-node__head">
        <strong title={node.label}>{node.label}</strong>
        <span className={`exec-state exec-state--${node.state}`}>
          <i style={{ background: STATE_COLOR[node.state] ?? '#8b919d' }} aria-hidden="true" />
          {NODE_STATE_LABEL[node.state]}
        </span>
      </header>
      {node.detail && <p className="exec-node__detail" title={node.detail}>{node.detail}</p>}
      <dl className="exec-node__meta">
        {node.runtime && <div><dt>Runtime</dt><dd>{node.runtime}</dd></div>}
        {node.kind === 'agent' && (
          <div><dt>模型</dt><dd title={modelLabel(node)}>{modelLabel(node)}</dd></div>
        )}
        {node.stepId && <div><dt>步骤</dt><dd>{node.stepId}{node.attempt ? ` · 第 ${node.attempt} 次` : ''}</dd></div>}
        {usage && <div><dt>用量</dt><dd>{usage}</dd></div>}
        {!usage && node.kind === 'agent' && <div><dt>用量</dt><dd className="exec-unknown">token / 费用未接入</dd></div>}
        {node.costMinor !== null && <div><dt>已花费</dt><dd>¥{(node.costMinor / 100).toFixed(2)}</dd></div>}
        {node.lastEventType && <div><dt>最近动作</dt><dd title={node.lastEventType}>{node.lastEventType}{node.lastEventAt ? ` · ${timeLabel(node.lastEventAt)}` : ''}</dd></div>}
      </dl>
      {node.error && <p className="exec-node__error" role="status">{node.error}</p>}
      {node.unknown.length > 0 && (
        <p className="exec-node__unknown">未接入：{node.unknown.join(' / ')}</p>
      )}
    </article>
  );
}

/**
 * Unified multi-agent execution graph for a task.
 *
 * Every card comes from `GET /api/tasks/:id/execution-graph`, which is a projection of
 * persisted records. Motion is driven by persisted event IDs: the first snapshot only
 * marks history as "already played", and only genuinely new events emit a flight.
 */
export function ExecutionGraphPanel({ taskId }: { taskId: string }) {
  const [graph, setGraph] = useState<ExecutionGraphView | null>(null);
  const [error, setError] = useState('');
  const [activeNode, setActiveNode] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const lightRef = useRef<ReturnType<typeof createLightLayer> | null>(null);
  const nodeRefs = useRef(new Map<string, HTMLElement>());
  const seenRef = useRef(new Set<string>());
  const primedRef = useRef(false);
  const [paths, setPaths] = useState<{ id: string; d: string; kind: string; state: string }[]>([]);

  useAdaptiveResource({
    enabled: true,
    identity: 'execution-graph:' + taskId,
    scope: 'tasks',
    intervalMs: () => (graph && ['queued', 'running', 'reviewing'].includes(graph.status) ? 3000 : 20000),
    fetcher: (signal) => request<ExecutionGraphView>(`/api/tasks/${encodeURIComponent(taskId)}/execution-graph`, signal),
    onData: (value) => {
      setGraph(value);
      setError('');
    },
    onError: (cause) => {
      setGraph(null);
      setError(cause instanceof Error ? cause.message : '执行图读取失败');
    }
  });

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const light = createLightLayer(stage);
    lightRef.current = light;
    const pause = () => { if (document.visibilityState === 'hidden') light.pause(); };
    const resume = () => { if (document.visibilityState === 'visible') light.resume(); };
    document.addEventListener('visibilitychange', pause);
    document.addEventListener('visibilitychange', resume);
    return () => {
      document.removeEventListener('visibilitychange', pause);
      document.removeEventListener('visibilitychange', resume);
      light.destroy();
      lightRef.current = null;
    };
  }, []);

  // Reset the "already played" marker when switching tasks.
  useEffect(() => {
    seenRef.current = new Set();
    primedRef.current = false;
    setActiveNode(null);
  }, [taskId]);

  useEffect(() => {
    if (!graph) return;
    const fresh = takeNewEventIds(graph.events, seenRef.current);
    if (!primedRef.current) {
      primedRef.current = true;
      return;
    }
    const light = lightRef.current;
    if (!light || prefersReducedMotion() || document.visibilityState === 'hidden') return;
    const nodeIds = new Set(graph.nodes.map((node) => node.nodeId));
    const allowed = new Set(animatableEvents(graph.events, nodeIds).map((event) => event.eventId));
    for (const eventId of fresh) {
      if (!allowed.has(eventId)) continue;
      const event = graph.events.find((item) => item.eventId === eventId);
      if (!event?.nodeId) continue;
      const target = nodeRefs.current.get(event.nodeId);
      if (!target) continue;
      const source = nodeRefs.current.get('crew:handoff') ?? nodeRefs.current.get('planner') ?? nodeRefs.current.get('goal');
      if (!source || source === target) continue;
      try {
        void light.emit({ id: event.eventId, source, target, color: STATE_COLOR[event.state] ?? '#4f46e5', duration: 760 }).finished;
      } catch { /* an emitter failure must never break the graph */ }
    }
    setActiveNode((current) => current ?? graph.events.at(-1)?.nodeId ?? null);
  }, [graph]);

  useLayoutEffect(() => {
    const update = () => {
      const stage = stageRef.current;
      if (!stage || !graph) return;
      const bounds = stage.getBoundingClientRect();
      const next: { id: string; d: string; kind: string; state: string }[] = [];
      for (const edge of graph.edges) {
        const from = nodeRefs.current.get(edge.from);
        const to = nodeRefs.current.get(edge.to);
        if (!from || !to) continue;
        const a = from.getBoundingClientRect();
        const b = to.getBoundingClientRect();
        next.push({
          id: edge.edgeId,
          kind: edge.kind,
          state: edge.state,
          d: edgePath(
            { x: a.right - bounds.left, y: a.top + a.height / 2 - bounds.top },
            { x: b.left - bounds.left, y: b.top + b.height / 2 - bounds.top }
          )
        });
      }
      setPaths(next);
    };
    update();
    const observer = new ResizeObserver(update);
    if (stageRef.current) observer.observe(stageRef.current);
    for (const element of nodeRefs.current.values()) observer.observe(element);
    window.addEventListener('resize', update);
    return () => { observer.disconnect(); window.removeEventListener('resize', update); };
  }, [graph]);

  const grouped = useMemo(() => groupNodes(graph?.nodes ?? []), [graph]);
  const tone = graph?.coverage;

  if (!graph && error) {
    return (
      <section className="exec-graph" aria-label="多 Agent 执行图">
        <div className="exec-graph__fallback">
          <p><strong>执行图暂时读不到</strong>（{error}）。数据来自 Host 的持久化记录，不是浏览器本地推算。</p>
          <button type="button" className="ghost-btn" onClick={() => notifyRefresh('tasks')}>重试</button>
        </div>
      </section>
    );
  }
  if (!graph) {
    return (
      <section className="exec-graph" aria-label="多 Agent 执行图" aria-busy="true">
        <p className="exec-graph__loading">正在读取执行记录…</p>
      </section>
    );
  }

  return (
    <section className="exec-graph" aria-label="多 Agent 执行图">
      <header className="exec-graph__head">
        <div>
          <p className="eyebrow">EXECUTION GRAPH</p>
          <h3>多 Agent 执行图</h3>
          <p className="hint">节点来自 Host 已持久化的计划、派工、评审与编队记录；没有记录的字段标为“未接入”。</p>
        </div>
        <div className="exec-graph__actions">
          <span className={`status-pill status-${graph.status}`}>{STATUS_LABELS[graph.status]}</span>
          <button type="button" className="ghost-btn" onClick={() => notifyRefresh('tasks')}>刷新</button>
        </div>
      </header>

      <div className="exec-coverage" aria-label="证据覆盖">
        <span className={`exec-chip exec-chip--${tone?.runtimeBinding ?? 'not_recorded'}`}>运行时绑定 {EVIDENCE_LABEL[tone?.runtimeBinding ?? 'not_recorded']}</span>
        <span className={`exec-chip exec-chip--${tone?.modelRequests ?? 'not_recorded'}`}>模型请求 {EVIDENCE_LABEL[tone?.modelRequests ?? 'not_recorded']}</span>
        <span className={`exec-chip exec-chip--${tone?.toolCalls ?? 'not_recorded'}`}>工具调用 {EVIDENCE_LABEL[tone?.toolCalls ?? 'not_recorded']}</span>
        <span className={`exec-chip exec-chip--${tone?.usage ?? 'not_recorded'}`}>Token / 费用 {EVIDENCE_LABEL[tone?.usage ?? 'not_recorded']}</span>
      </div>

      <div className="exec-stage" ref={stageRef}>
        <svg className="exec-links" aria-hidden="true">
          {paths.map((path) => (
            <path
              key={path.id}
              d={path.d}
              fill="none"
              stroke={STATE_COLOR[path.state] ?? '#b9bec9'}
              strokeWidth={path.kind === 'handoff' ? 1.8 : 1.2}
              strokeDasharray={path.kind === 'dispatch' ? '4 6' : path.kind === 'handoff' ? '1 5' : undefined}
              opacity={0.45}
            />
          ))}
        </svg>
        {EXECUTION_COLUMNS.map((column) => (
          <div className="exec-col" key={column.id}>
            <div className="exec-col__head"><strong>{column.title}</strong><small>{column.hint}</small></div>
            {grouped[column.id].map((node) => (
              <div
                key={node.nodeId}
                ref={(element) => {
                  if (element) nodeRefs.current.set(node.nodeId, element);
                  else nodeRefs.current.delete(node.nodeId);
                }}
              >
                <NodeCard node={node} active={activeNode === node.nodeId} onFocus={setActiveNode} />
              </div>
            ))}
            {!grouped[column.id].length && <p className="exec-col__empty">等待执行记录</p>}
          </div>
        ))}
      </div>

      <div className="exec-timeline">
        <div className="card-title"><h3>事件时间线</h3><span className="hint">只播放新事件，历史不重播</span></div>
        <ol>
          {graph.events.slice(-12).reverse().map((event) => (
            <li key={event.eventId}>
              <button
                type="button"
                className={`exec-event${activeNode && event.nodeId === activeNode ? ' is-active' : ''}`}
                onClick={() => setActiveNode(event.nodeId)}
                disabled={!event.nodeId}
                title={event.nodeId ? '在图中定位该节点' : '该事件未持久化步骤归属，无法定位节点'}
              >
                <span className={`exec-event__dot exec-state--${event.state}`} aria-hidden="true" />
                <span className="exec-event__label">{event.label}</span>
                <span className="exec-event__time">{timeLabel(event.at)}</span>
                <span className="exec-event__scope">{EVENT_SCOPE_LABEL[event.source] ?? event.source}</span>
              </button>
            </li>
          ))}
          {!graph.events.length && <li className="hint">还没有事件。</li>}
        </ol>
        {tone?.notes.length ? (
          <details className="exec-notes">
            <summary>为什么有些字段显示“未接入”</summary>
            <ul>{tone.notes.map((note) => <li key={note}>{note}</li>)}</ul>
          </details>
        ) : null}
      </div>
    </section>
  );
}