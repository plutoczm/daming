import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { AgentGraphPanel } from './AgentGraphPanel.tsx';
import { createLightLayer } from './light-ui/index.ts';
import { notifyRefresh, useAdaptiveResource } from './live-refresh.ts';
import type { CreateMissionInput, MagpieRouteCatalogView, MissionRoutePreflightView, MissionRouteScopeProbeView, MissionEventView, MissionNodeView, MissionResourceView, MissionView } from '@daming/contracts';

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const message = await response.json().catch(() => null) as { reason?: string } | null;
    throw new Error(message?.reason ?? 'HTTP ' + response.status);
  }
  return await response.json() as T;
}
const STATUS: Record<MissionView['status'], string> = {
  pending_event: '待 Auto-Loop 派发',
  awaiting_decision: '等待人工决定',
  executing: '离线执行中',
  completed: '演示已交付',
  cancelled: '已拒绝',
  blocked: '流程阻塞'
};
const NODE_STATUS: Record<MissionNodeView['status'], string> = {
  pending: '等待', running: '进行中', completed: '完成', waiting: '待拍板', skipped: '已跳过'
};
const COLORS: Record<MissionEventView['source'], string> = {
  daming: '#64748b', superagent: '#7c3aed', autoloop: '#ea580c', magpie: '#0891b2', worker: '#2563eb'
};

/**
 * Lancer-derived Light UI animation displays actual persisted Daming events.
 * No synthetic status ticks, no provider calls, no capability to modify mission state.
 */
function MissionTrace({ mission }: { mission: MissionView }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<ReturnType<typeof createLightLayer> | null>(null);
  const nodesRef = useRef(new Map<string, HTMLDivElement>());
  const emitted = useRef(new Set<string>());
  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const layer = createLightLayer(element);
    layerRef.current = layer;
    emitted.current.clear();
    return () => { layer.destroy(); layerRef.current = null; };
  }, [mission.missionId]);
  const lastEvent = mission.events.at(-1);
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    // Animate only events observed AFTER mount, not a forged replay of the whole history.
    const recent = mission.events.slice(-8);
    if (!emitted.current.size) {
      for (const event of recent) emitted.current.add(String(event.sequence));
      return;
    }
    for (const event of recent) {
      const key = String(event.sequence);
      if (emitted.current.has(key)) continue;
      emitted.current.add(key);
      if (!event.nodeId) continue;
      const target = nodesRef.current.get(event.nodeId);
      const source = nodesRef.current.get(event.nodeId === 'delivery' ? 'decision'
        : event.nodeId === 'decision' ? 'research' : 'router');
      if (!source || !target || source === target || document.visibilityState === 'hidden') continue;
      layer.emit({ id: mission.missionId + ':' + key, source, target, color: COLORS[event.source], sourceKind: 'model' });
    }
  }, [mission.missionId, mission.events]);

  const node = (item: MissionNodeView) => (
    <div
      className={'mission-node mission-node--' + item.status}
      key={item.id}
      ref={(element) => { if (element) nodesRef.current.set(item.id, element); else nodesRef.current.delete(item.id); }}
    >
      <span className="mission-node__state">{NODE_STATUS[item.status]}</span>
      <strong>{item.name}</strong>
      <small>{item.role}</small>
      <span className="mission-node__route">{item.owner} · 未绑定真实模型</span>
    </div>
  );
  const byId = new Map(mission.nodes.map((item) => [item.id, item]));
  return (
    <section className="mission-visual" aria-label="Lancer 风格任务事件图" ref={rootRef}>
      <div className="mission-visual__caption">
        <strong>Lancer Light UI / 真实事件映射</strong>
        <span>事件版本 v1 · {mission.events.length} 条 · {lastEvent ? new Date(lastEvent.occurredAt).toLocaleTimeString() : '无事件'}</span>
      </div>
      <div className="mission-graph">
        {byId.get('router') && node(byId.get('router')!)}
        <span className="mission-link" aria-hidden="true">↓</span>
        <div className="mission-parallel">
          {byId.get('research') && node(byId.get('research')!)}
          {byId.get('analysis') && node(byId.get('analysis')!)}
        </div>
        <span className="mission-link" aria-hidden="true">↓</span>
        {byId.get('decision') && node(byId.get('decision')!)}
        <span className="mission-link" aria-hidden="true">↓</span>
        {byId.get('delivery') && node(byId.get('delivery')!)}
      </div>
      <details className="mission-event-details" open>
        <summary>事件审计 · 最近 {Math.min(mission.events.length, 12)} 条</summary>
        <ol className="mission-event-list">
          {mission.events.slice(-12).reverse().map((event) => (
            <li key={event.sequence}>
              <span className="mission-event-dot" style={{ background: COLORS[event.source] }} />
              <span><strong>{event.summary}</strong><small>{event.source} · {event.type} · {new Date(event.occurredAt).toLocaleTimeString()}</small></span>
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}

type UnifiedMagpieTarget = { targetId: string; label: string;
  kind: 'llm' | 'agent-backed' | 'route-group'; providerId: string | null;
  members: number; ready: true };
type UnifiedMagpieCatalog = { source: 'magpie-native-routing';
  targets: UnifiedMagpieTarget[]; dispatchEnabled: false; managesCredentialsInMagpie: true };
const MAGPIE_TASK_ROLES = [
  { id: 'router', label: '任务拆解 / Router' },
  { id: 'research', label: '研究 / Agent A' },
  { id: 'analysis', label: '分析 / Agent B' },
  { id: 'delivery', label: '报告 / Synthesizer' }
] as const;
export function CommandCenter({ canWrite, csrfToken }: { canWrite: boolean; csrfToken: string }) {
  const [title, setTitle] = useState('比较两种产品方案');
  const [goal, setGoal] = useState('展示多角色规划、人工决策和最终报告的完整流程。');
  const [missions, setMissions] = useState<MissionView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [resources, setResources] = useState<MissionResourceView | null>(null);
  const [routeCatalog, setRouteCatalog] = useState<MagpieRouteCatalogView | null>(null);
  const [unifiedCatalog, setUnifiedCatalog] = useState<UnifiedMagpieCatalog | null>(null);
  const [magpieSelections, setMagpieSelections] = useState<Record<string, string>>({});
  const [routeCandidate, setRouteCandidate] = useState('');
  const [preflight, setPreflight] = useState<MissionRoutePreflightView | null>(null);
  const [scopeProbe, setScopeProbe] = useState<MissionRouteScopeProbeView | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const mission = missions.find((item) => item.missionId === selected) ?? missions[0] ?? null;

  useAdaptiveResource({
    enabled: true, identity: 'mission-list', scope: 'missions', intervalMs: 15000,
    fetcher: (signal) => api<{ missions: MissionView[] }>('/api/command/missions', { signal }),
    onData: (data) => {
      setMissions(data.missions);
      setSelected((current) => current ?? data.missions[0]?.missionId ?? null);
    },
    onError: () => setMessage((text) => text || '无法加载指挥中心事件')
  });
  useAdaptiveResource({
    enabled: true, identity: 'mission-catalog', scope: 'magpie', intervalMs: 90000,
    fetcher: (signal) => api<MissionResourceView>('/api/command/resources', { signal }),
    onData: setResources,
    onError: () => setResources(null)
  });

  useAdaptiveResource({
    enabled: true, identity: 'mission-route-catalog', scope: 'magpie', intervalMs: 90000,
    fetcher: (signal) => api<MagpieRouteCatalogView>('/api/command/routes', { signal }),
    onData: (data) => {
      setRouteCatalog(data);
      setRouteCandidate((current) => data.candidates.some((c) => c.candidateId === current)
        ? current : data.candidates[0]?.candidateId ?? '');
    },
    onError: () => setRouteCatalog(null)
  });
  useAdaptiveResource({
    enabled: canWrite, identity: 'magpie-native-targets', scope: 'magpie', intervalMs: 90000,
    fetcher: (signal) => api<UnifiedMagpieCatalog>('/api/command/targets', { signal }),
    onData: setUnifiedCatalog,
    onError: () => setUnifiedCatalog(null)
  });
  useEffect(() => {
    setPreflight(null); setScopeProbe(null); setMagpieSelections({});
  }, [mission?.missionId, mission?.routeAuthorization?.state]);
  const saveMagpieRoles = async () => {
    if (!mission || !canWrite || busy || !unifiedCatalog) return;
    const assignments = MAGPIE_TASK_ROLES
      .filter(role => magpieSelections[role.id])
      .map(role => ({ role: role.id, targetId: magpieSelections[role.id] }));
    if (!assignments.length) { setMessage('至少为一个任务角色选择 Magpie 模型、Agent 或路由组'); return; }
    setBusy(true); setMessage('');
    try {
      const updated = await api<MissionView>('/api/command/missions/' + mission.missionId + '/role-plan', {
        method: 'POST', headers: { 'content-type': 'application/json',
          'X-Daming-CSRF': csrfToken },
        body: JSON.stringify({ requestId: crypto.randomUUID(), assignments })
      });
      setMissions(before => before.map(item => item.missionId === updated.missionId ? updated : item));
      setMessage('Magpie 多模型与 Agent 的任务角色已绑定；真实模型调用仍由独立执行授权控制');
      notifyRefresh('missions');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Magpie 任务分配失败'); }
    finally { setBusy(false); }
  };

  const routeAction = async (kind: 'authorize' | 'revoke' | 'preflight' | 'scope' | 'prepare' | 'cancel-attempt', attemptId?: string) => {
    if (!mission || busy) return;
    setBusy(true);
    setMessage('');
    try {
      const base = '/api/command/missions/' + mission.missionId;
      if (kind === 'preflight') {
        setPreflight(await api<MissionRoutePreflightView>(base + '/route-preflight'));
      } else if (kind === 'scope') {
        setScopeProbe(await api<MissionRouteScopeProbeView>(base + '/route-scope-probe', {
          method: 'POST', headers: { 'content-type': 'application/json', 'X-Daming-CSRF': csrfToken },
          body: '{}'
        }));
        notifyRefresh('missions');
      } else if (kind === 'prepare' || kind === 'cancel-attempt') {
        await api(base + '/route-attempts' + (kind === 'cancel-attempt' ? '/' + attemptId : ''), {
          method: kind === 'prepare' ? 'POST' : 'DELETE',
          headers: { 'content-type': 'application/json', 'X-Daming-CSRF': csrfToken },
          ...(kind === 'prepare' ? { body: JSON.stringify({
            requestId: crypto.randomUUID(), outputTokenCeiling: 512, budgetEnvelopeMinor: 100
          }) } : {})
        });
        const updated = await api<MissionView>(base);
        setMissions((before) => before.map((m) => m.missionId === updated.missionId ? updated : m));
        notifyRefresh('missions');
      } else {
        const response = await api(base + '/route-authorization', {
          method: kind === 'revoke' ? 'DELETE' : 'POST',
          headers: { 'content-type': 'application/json', 'X-Daming-CSRF': csrfToken },
          ...(kind === 'authorize' ? { body: JSON.stringify({
            requestId: crypto.randomUUID(), candidateId: routeCandidate, ttlMinutes: 15,
            maxRequests: 1, maxOutputTokens: 512, maxCashMinor: 100
          }) } : {})
        });
        void response;
        const updated = await api<MissionView>(base);
        setMissions((before) => before.map((m) => m.missionId === updated.missionId ? updated : m));
        setPreflight(null);
        notifyRefresh('missions');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '路由授权失败');
    } finally { setBusy(false); }
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!canWrite || busy) return;
    setBusy(true);
    setMessage('');
    try {
      const input: CreateMissionInput = { title, goal, requestId: crypto.randomUUID(), mode: 'offline-demo' };
      const created = await api<MissionView>('/api/command/missions', {
        method: 'POST', headers: { 'content-type': 'application/json', 'X-Daming-CSRF': csrfToken },
        body: JSON.stringify(input)
      });
      setSelected(created.missionId);
      setMissions((before) => [created, ...before.filter((item) => item.missionId !== created.missionId)]);
      notifyRefresh('missions');
      notifyRefresh('autoloop');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '任务创建失败');
    } finally {
      setBusy(false);
    }
  };
  const answer = async (choice: 0 | 1) => {
    if (!canWrite || busy || !mission?.cardId || mission.status !== 'awaiting_decision') return;
    setBusy(true);
    setMessage('');
    try {
      const decided = await api<MissionView>('/api/command/missions/' + mission.missionId + '/decision', {
        method: 'POST', headers: { 'content-type': 'application/json', 'X-Daming-CSRF': csrfToken },
        body: JSON.stringify({ cardId: mission.cardId, choice })
      });
      setMissions((before) => before.map((item) => item.missionId === decided.missionId ? decided : item));
      notifyRefresh('missions');
      notifyRefresh('autoloop');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '决策提交失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="command-center" aria-label="大铭多 Agent 指挥中心">
      <header className="command-center__head">
        <div><p className="eyebrow">DAMING · MULTI-AGENT COMMAND ROOM</p><h2>多 Agent 指挥中心</h2>
          <p className="hint">Magpie 资源发现 → Super-Agent 式任务分工 → Auto-Loop 人工决策 → Lancer 过程可视化</p></div>
        <span className="command-demo-badge">离线演示 / 不调用 LLM</span>
      </header>

      <div className="command-resource-strip">
        <div><small>MAGPIE 模型</small><strong>{resources?.models.count ?? '—'}</strong></div>
        <div><small>供应商</small><strong>{resources?.providers.count ?? '—'}</strong></div>
        <div><small>Agent 清单</small><strong>{resources?.agents.count ?? '—'}</strong></div>
        <div><small>可用供应商</small><strong>{resources?.providers.ready ?? '—'}</strong></div>
        <span>{resources?.configured ? '已读取安全资源摘要 · 尚未授权派工' : 'Magpie 未连接 · 可离线演示'}</span>
      </div>

      <div className="command-center__columns">
        <div className="command-center__controls">
          <form onSubmit={create} className="command-mission-form">
            <h3>创建协作任务</h3>
            <label htmlFor="mission-title">任务标题</label>
            <input id="mission-title" maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} disabled={!canWrite || busy} />
            <label htmlFor="mission-goal">任务目标</label>
            <textarea id="mission-goal" rows={3} maxLength={1500} value={goal} onChange={(event) => setGoal(event.target.value)} disabled={!canWrite || busy} />
            <button type="submit" disabled={!canWrite || busy || !title.trim() || !goal.trim()}>{busy ? '处理中…' : '启动离线多 Agent 流程'}</button>
          </form>
          <div className="command-mission-list">
            <h3>最近任务</h3>
            {missions.slice(0, 8).map((item) => (
              <button type="button" key={item.missionId}
                className={'command-mission-choice' + (mission?.missionId === item.missionId ? ' selected' : '')}
                onClick={() => setSelected(item.missionId)}>
                <span>{item.title}</span><small>{STATUS[item.status]}</small>
              </button>
            ))}
            {!missions.length && <p className="hint">暂无协作任务</p>}
          </div>
          <div className="command-channel">
            <strong>跨端指挥通道</strong>
            <p>飞书：卡片预览（未发送）</p>
            <p>企业微信 / QQ：适配待接入；个人微信需单独验证官方接口。</p>
            <small>目前仅在本机认证任务板提交决策。没有公开互联网回调或自动发送。</small>
          </div>
        </div>
        <div className="command-center__activity">
          {mission ? (
            <>
              <div className="command-mission-head"><h3>{mission.title}</h3>
                <span className={'command-state command-state--' + mission.status}>{STATUS[mission.status]}</span>
              </div>
              <p className="hint">任务 {mission.missionId.slice(0, 8)} · 规则型演示，所有真实模型路由均未绑定</p>
              {mission.status === 'awaiting_decision' && mission.cardId !== null && (
                <div className="command-decision" role="group" aria-label="Auto-Loop 决策卡">
                  <strong>Auto-Loop 需要你的决定</strong>
                  <p>两个离线 Worker 的演示步骤已留痕。是否允许生成不涉及外部账号的最终报告？</p>
                  <div className="command-decision-buttons">
                    <button type="button" disabled={!canWrite || busy} onClick={() => void answer(0)}>批准继续</button>
                    <button type="button" disabled={!canWrite || busy} onClick={() => void answer(1)}>拒绝任务</button>
                  </div>
                </div>
              )}
              <div className="command-channel">
                <strong>Magpie 任务级路由授权（预检阶段）</strong>
                <p className="hint">为每个 API Key 单独授权，禁止跨账号回退。授权默认 15 分钟、1 次请求、512 输出 tokens、¥1 费用上限；真实派工仍关闭。</p>
                {mission.routeAuthorization ? (
                  <>
                    <p>{mission.routeAuthorization.providerId} / {mission.routeAuthorization.modelId} · {mission.routeAuthorization.state}</p>
                    <p>有效期：{new Date(mission.routeAuthorization.expiresAt).toLocaleString()}</p>
                    <button type="button" disabled={busy} onClick={() => void routeAction('preflight')}>复核账号绑定</button>
                    {' '}
                    <button type="button" disabled={!canWrite || busy || !!scopeProbe || mission.routeAuthorization.state !== 'authorized'} onClick={() => void routeAction('scope')}>验证网关账号隔离（需本机确认，不推理，每任务仅一次）</button>
                    {' '}
                    <button type="button" disabled={!canWrite || busy || mission.routeAuthorization.state !== 'authorized'} onClick={() => void routeAction('prepare')}>本机预留一次请求（不推理）</button>
                    {' '}
                    <button type="button" disabled={!canWrite || busy || mission.routeAuthorization.state !== 'authorized'} onClick={() => void routeAction('revoke')}>撤销授权</button>
                    {mission.routeAttempts.length > 0 && <ul>
                      {mission.routeAttempts.map((item) => (
                        <li key={item.attemptId}>
                          请求 {item.attemptId.slice(0, 8)} · {item.state === 'prepared' ? '已预留，未发送' : item.state === 'cancelled' ? '已取消' : item.state === 'unknown_after_send' ? '发送结果未知，额度冻结' : item.state === 'breached_synthetic' ? '模拟超额，禁止续用' : '模拟结算，信封仍保留'} · {item.outputTokenCeiling} tokens · ¥{(item.budgetEnvelopeMinor / 100).toFixed(2)}
                          {item.state === 'prepared' && <button type="button" disabled={!canWrite || busy} onClick={() => void routeAction('cancel-attempt', item.attemptId)}>取消预留</button>}
                        </li>
                      ))}
                    </ul>}
                    {mission.routeReceipts.length > 0 && (
                      <div className="hint">
                        <strong>持久化用量与费用状态（仅模拟，不代表供应商账单）</strong>
                        <ul>{mission.routeReceipts.map((receipt) => (
                          <li key={receipt.attemptId}>
                            {receipt.attemptId.slice(0, 8)} · {receipt.state === 'unknown_after_send' ? '未知待对账' : receipt.state === 'breached_synthetic' ? '模拟超额争议' : '合成用量已核对'} ·
                            价格估算上限 ¥{(receipt.priceCeilingMinor / 100).toFixed(2)} ·
                            冻结信封 ¥{(receipt.reservedEnvelopeMinor / 100).toFixed(2)} ·
                            {receipt.observedCashMinor === null ? '实际费用未知' : '模拟费用 ¥' + (receipt.observedCashMinor / 100).toFixed(2)} ·
                            供应商账单未认证
                          </li>
                        ))}</ul>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <label htmlFor="mission-route-candidate">可授权 Provider / 模型</label>
                    <select id="mission-route-candidate" value={routeCandidate} onChange={(e) => setRouteCandidate(e.target.value)} disabled={busy}>
                      {!routeCatalog?.candidates.length && <option value="">暂无满足单账号条件的路由</option>}
                      {routeCatalog?.candidates.map((c) => <option key={c.candidateId} value={c.candidateId}>{c.providerId} · {c.modelId} · {c.accountLabel}</option>)}
                    </select>
                    <button type="button" disabled={!canWrite || busy || !routeCandidate || mission.status !== 'awaiting_decision'} onClick={() => void routeAction('authorize')}>授权本任务使用该路由（不执行）</button>
                  </>
                )}
                {preflight && <p role="status">{preflight.accountBindingValid ? '账号绑定一致' : '账号绑定不可用'} · {preflight.reason} · 实际派工仍关闭；生产准入尚缺持久租户身份、真实账号所有权、可信实时价格、网关现金硬限额及供应商账单核对。</p>}
                {scopeProbe && <p role="status">{scopeProbe.verified ? '短期受限密钥已验证并撤销' : '网关范围验证未通过'} · {scopeProbe.reason} · 真实派工仍关闭</p>}
              </div>
              <div className="command-channel">
                <strong>复用 Magpie：多 LLM / Agent / 路由组</strong>
                <p className="hint">供应商、Agent 账号、路由规则和回退策略继续由 Magpie 管理。这里只为大铭的任务角色选择目标，不复制密钥，也不修改 Magpie 配置。</p>
                {unifiedCatalog?.targets.length ? <>
                  <p className="hint">已发现 {unifiedCatalog.targets.filter(t => t.kind === 'llm').length} 个 LLM、
                    {unifiedCatalog.targets.filter(t => t.kind === 'agent-backed').length} 个订阅或 Agent 模型、
                    {unifiedCatalog.targets.filter(t => t.kind === 'route-group').length} 个路由组。</p>
                  {MAGPIE_TASK_ROLES.map(role => <label key={role.id}>
                    {role.label}
                    <select value={magpieSelections[role.id] ?? ''}
                      disabled={!canWrite || busy}
                      onChange={event => setMagpieSelections(s => ({
                        ...s, [role.id]: event.target.value
                      }))}>
                      <option value="">保持当前节点配置</option>
                      <optgroup label="Magpie 路由组（包含自动选择与回退）">
                        {unifiedCatalog.targets.filter(t => t.kind === 'route-group').map(target =>
                          <option key={target.targetId} value={target.targetId}>
                            {target.label} · {target.targetId} · {target.members} 个成员
                          </option>)}
                      </optgroup>
                      <optgroup label="由 Magpie 管理的 Agent 订阅模型">
                        {unifiedCatalog.targets.filter(t => t.kind === 'agent-backed').map(target =>
                          <option key={target.targetId} value={target.targetId}>
                            {target.label} · {target.targetId}
                          </option>)}
                      </optgroup>
                      <optgroup label="其他模型目标（由 Magpie 使用 API 或 Agent 账号）">
                        {unifiedCatalog.targets.filter(t => t.kind === 'llm').map(target =>
                          <option key={target.targetId} value={target.targetId}>
                            {target.label} · {target.targetId}
                          </option>)}
                      </optgroup>
                    </select>
                  </label>)}
                  <button type="button" disabled={!canWrite || busy ||
                    !MAGPIE_TASK_ROLES.some(r => magpieSelections[r.id])}
                    onClick={() => void saveMagpieRoles()}>
                    保存多 Agent / LLM 任务角色分配
                  </button>
                  <p className="hint">任务节点已绑定：
                    {mission.nodes.filter(n => n.modelRoute !== 'unbound').map(n =>
                      ' ' + n.id + ' → ' + n.modelRoute).join('；') || '尚未绑定'}
                  </p>
                </> : <p className="hint">未发现可用的 Magpie 原生路由目录。请保持 Magpie 运行并确认大铭连接的是已配置账号的实例；当前不会自动迁移或修改你的账号。</p>}
                <p className="hint">路由目录与角色分配已接入；真实付费模型派工仍受现有安全准入约束，不会因为保存任务目标自动调用供应商。</p>
              </div>
              <AgentGraphPanel missionId={mission.missionId} canWrite={canWrite} csrfToken={csrfToken} />
              <MissionTrace mission={mission} />
              {mission.delivery && <div className="command-delivery"><h3>交付内容 · 离线规则型报告</h3><pre>{mission.delivery}</pre></div>}
              {mission.blockedReason && <p className="error-banner" role="alert">{mission.blockedReason}</p>}
            </>
          ) : <div className="command-center__empty">创建任务后，这里将显示基于持久化事件的真实流程图和审批卡。</div>}
        </div>
      </div>
      {message && <p className="error-banner" role="alert">{message}</p>}
    </section>
  );
}
