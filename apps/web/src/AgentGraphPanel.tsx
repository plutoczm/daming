import { useCallback, useEffect, useState } from 'react';

type GraphNode = {
  nodeId: string; kind: 'root_turn' | 'subagent'; role: 'root' | 'research' | 'analysis';
  status: string; plannedMagpieTarget: string | null;
  actualDriver: string | null; summary: string | null;
  runId: string; parentNodeId: string | null; providerThreadId: null;
};
type Graph = {
  graphVersion: 1; rootRunId: string; status: string;
  nodes: GraphNode[];
  runs: { runId: string; role: string; status: string; countsForConversation: boolean }[];
  threads: { threadId: string; parentThreadId: string | null; kind: string; role: string }[];
  transfers: { transferId: string; summary: string; kind: 'subagent_result' }[];
  events: { sequence: number; event: string; summary: string; at: string }[];
  parentRequiresExplicitCompletion: true;
  paidDispatchPermitted: false; plannedRoutesNotExecuted: true;
};

const TITLES: Record<string, string> = {
  root: '父任务 / Orchestrator', research: '研究子 Agent', analysis: '分析子 Agent'
};
const STATUSES: Record<string, string> = {
  queued: '等待执行', running: '执行中', completed: '已完成',
  waiting_approval: '等待人工决策', cancelled: '已取消',
  blocked: '已阻断', interrupted: '结果不确定', failed: '执行失败'
};

export function AgentGraphPanel({ missionId, csrfToken, canWrite }: {
  missionId: string; csrfToken: string; canWrite: boolean;
}) {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const endpoint = '/api/command/missions/' + encodeURIComponent(missionId) + '/agent-graph';
  const reload = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(endpoint, { credentials: 'same-origin', signal });
    if (!response.ok) throw new Error('无法读取本任务执行图');
    const data = await response.json() as { graph: Graph | null };
    if (!signal?.aborted) setGraph(data.graph);
  }, [endpoint]);
  useEffect(() => {
    const controller = new AbortController();
    setGraph(null); setMessage('');
    void reload(controller.signal).catch(() => {
      if (!controller.signal.aborted) setMessage('执行图暂不可用');
    });
    const poll = setInterval(() => {
      if (!controller.signal.aborted) void reload(controller.signal).catch(() => undefined);
    }, 2500);
    return () => { controller.abort(); clearInterval(poll); };
  }, [reload]);

  const action = (mode: 'launch' | 'approve' | 'cancel') => {
    if (busy || !canWrite) return;
    setBusy(true); setMessage('');
    void (async () => {
      try {
        const body = mode === 'launch' ? {
          requestId: crypto.randomUUID()
        } : {
          runId: graph?.rootRunId, requestId: crypto.randomUUID(),
          action: mode
        };
        const url = endpoint + (mode === 'launch' ? '/launch' : '/decide');
        const response = await fetch(url, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json',
            'X-Daming-CSRF': csrfToken },
          body: JSON.stringify(body)
        });
        const result = await response.json() as {
          graph?: Graph; reason?: string;
        };
        if (!response.ok) throw new Error(result.reason ?? '编排操作被拒绝');
        if (result.graph) setGraph(result.graph);
        setMessage(mode === 'launch'
          ? '已创建持久执行图：两个无网络子 Worker 正在并行运行'
          : mode === 'approve' ? '已确认父任务完成' : '已取消执行图');
        await reload();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : '执行图操作失败');
      } finally {
        setBusy(false);
      }
    })();
  };
  const active = graph && ['running', 'waiting_approval'].includes(graph.status);
  return (
    <section className="command-channel" aria-label="多 Agent 持久执行图">
      <strong>多 Agent 执行图 / T3 V2 风格</strong>
      <p className="hint">父任务、子会话、执行节点和结果交接分别持久化。当前由隔离的 WSL2 离线 Worker 真正并行执行，Magpie 路由只作为未来模型目标，不会访问已登录 Agent 或产生费用。</p>
      {(!graph || !active) && canWrite && <button type="button" disabled={busy}
        onClick={() => action('launch')}>启动一轮隔离并行子 Agent</button>}
      {graph && <>
        <p><strong>父任务：{STATUSES[graph.status] ?? graph.status}</strong>
          {' · '}{graph.threads.length} 条应用线程 · {graph.runs.length} 次运行记录
        </p>
        <div className="mission-parallel">
          {graph.nodes.filter(node => node.kind === 'subagent').map(node =>
            <div className="mission-node" key={node.nodeId}>
              <strong>{TITLES[node.role] ?? node.role}</strong>
              <small>{STATUSES[node.status] ?? node.status}</small>
              <span className="mission-node__route">
                Magpie 计划：{node.plannedMagpieTarget ?? '未指定'}
              </span>
              <small>实际执行：{node.actualDriver ?? '无'}</small>
              {node.summary && <p className="hint">{node.summary}</p>}
            </div>
          )}
        </div>
        <p className="hint">子任务结果移交：{graph.transfers.length} 项；只有人工确认才能将父任务置为完成。</p>
        {graph.status === 'waiting_approval' && canWrite && <div className="command-decision-buttons">
          <button type="button" disabled={busy} onClick={() => action('approve')}>确认父任务完成</button>
          <button type="button" disabled={busy} onClick={() => action('cancel')}>拒绝并取消</button>
        </div>}
        {['running','blocked','interrupted'].includes(graph.status) && canWrite &&
          <button type="button" disabled={busy} onClick={() => action('cancel')}>
            取消未完成的编排
          </button>}
        <details>
          <summary>执行事件与结果移交（{graph.events.length}）</summary>
          <ol className="mission-event-list">
            {graph.events.slice(-18).reverse().map(event =>
              <li key={event.sequence}>
                {event.summary} <small>{event.event} · {new Date(event.at).toLocaleTimeString()}</small>
              </li>)}
          </ol>
        </details>
      </>}
      {message && <p role="status" className="hint">{message}</p>}
      <p className="hint">执行模式：offline-wsl-sandbox · 付费派工：关闭 · Magpie 账号：未调用</p>
    </section>
  );
}
