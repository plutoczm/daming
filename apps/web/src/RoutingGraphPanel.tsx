import { useMemo, useState } from 'react';
import type { AvailableModelsView, AgentProfileView, GatewayObservabilityView, GatewayRequestView, PlatformCatalogView, ProviderConfigView, SessionView } from '@daming/contracts';
import { notifyRefresh, useAdaptiveResource } from './live-refresh.ts';
import { agentLogo, providerLogo } from './provider-logos.ts';

interface RoutingGroupView {
  readonly groupId: string; readonly name: string; readonly strategy: 'order' | 'round';
  readonly members: readonly { readonly providerId: string; readonly modelId: string }[];
}
interface RoutingProfileView {
  readonly profileId: string; readonly name: string;
  readonly assignments: readonly { readonly agentId: string; readonly providerId: string; readonly modelId: string }[];
}
interface AccountQuotaWindow { readonly name: string; readonly used: number; readonly remainingPercent: number; readonly resetsAt?: string; readonly display?: string }
interface AccountQuotaCard { readonly provider: string; readonly name: string; readonly plan: string; readonly user: string; readonly checkedAt: string; readonly windows: readonly AccountQuotaWindow[] }
interface Focus { readonly agent?: string; readonly provider?: string; readonly model?: string }

// 无原厂 logo 时的回退徽标
const FALLBACK_BADGE: Record<string, { label: string; color: string }> = {
  workbuddy: { label: 'WB', color: '#12a150' }, deepseek: { label: 'DS', color: '#4d6bfe' },
  codex: { label: 'CX', color: '#111827' }, openai: { label: 'OA', color: '#10a37f' },
  anthropic: { label: 'AN', color: '#d97757' }, kiro: { label: 'KI', color: '#7c5cff' },
  zcode: { label: 'ZC', color: '#0ea5e9' }, qwen: { label: 'QW', color: '#6366f1' },
  ollama: { label: 'OL', color: '#6b7280' }, zai: { label: 'ZA', color: '#2563eb' }
};
function fallbackBadge(id: string): { label: string; color: string } {
  const key = id.toLowerCase();
  for (const name of Object.keys(FALLBACK_BADGE)) if (key.includes(name)) return FALLBACK_BADGE[name]!;
  return { label: id.slice(0, 2).toUpperCase(), color: '#64748b' };
}
function agentFallback(runtime?: string, agentId?: string): { label: string; color: string } {
  const key = (runtime || agentId || '').toLowerCase();
  if (key.includes('dsh')) return { label: 'DSH', color: '#4f46e5' };
  if (key.includes('codex')) return { label: 'CX', color: '#111827' };
  if (key.includes('claude')) return { label: 'CC', color: '#d97757' };
  return { label: (agentId || 'A').slice(0, 2).toUpperCase(), color: '#64748b' };
}
function matchesAgent(requestAgent: string, agent: AgentProfileView): boolean {
  const value = (requestAgent || '').toLowerCase();
  if (!value || value === 'unattributed') return false;
  return value === agent.agentId.toLowerCase() || value === agent.name.toLowerCase() || value.includes(agent.runtime.toLowerCase());
}

const ACCENT = '#4f46e5';
const FLOW_CSS = `
@keyframes rflow-dash { to { stroke-dashoffset: -30; } }
.rflow-base { stroke-dasharray: 5 9; animation: rflow-dash 1.6s linear infinite; }
.rflow-hot-base { stroke-dasharray: 6 7; animation: rflow-dash .9s linear infinite; }
@media (prefers-reduced-motion: reduce) { .rflow-base, .rflow-hot-base { animation: none; } .rflow-dot { display: none; } }
.rflow-node { cursor: pointer; }
.rflow-node:hover rect:first-of-type { stroke: #4f46e5; }
`;

/** 动态流向图：Agent → 网关 → 供应商·模型；真原厂 logo、流动光点、点击高亮整条链路。 */
function FlowGraph({ agents, providers, requests, quotas, focus, onFocusAgent, onFocusProvider }: {
  agents: readonly AgentProfileView[];
  providers: readonly ProviderConfigView[];
  requests: readonly GatewayRequestView[];
  quotas: Record<string, number>;
  focus: Focus | null;
  onFocusAgent: (agent: AgentProfileView) => void;
  onFocusProvider: (providerId: string) => void;
}) {
  const W = 940, pad = 26;
  const A = Math.max(agents.length, 1), P = Math.max(providers.length, 1);
  const H = Math.max(A * 96, P * 108, 220) + pad * 2;
  const leftX = pad, nodeW = 232, provW = 248, rightX = W - pad - provW;
  const gx = W / 2 - 72, gw = 144, gcY = H / 2;
  const agentCY = (i: number) => pad + ((i + 0.5) * (H - 2 * pad)) / A;
  const provCY = (j: number) => pad + ((j + 0.5) * (H - 2 * pad)) / P;

  const activeAgents = new Set(agents.filter((agent) => requests.some((r) => matchesAgent(r.agent, agent))).map((agent) => agent.agentId));
  const activeProviders = new Set(providers.filter((provider) => requests.some((r) => r.providerId === provider.id)).map((provider) => provider.id));
  const hasFocus = !!focus;
  const agentHot = (agent: AgentProfileView) => hasFocus ? (focus?.agent ? matchesAgent(focus.agent, agent) : false) : activeAgents.has(agent.agentId);
  const provHot = (provider: ProviderConfigView) => hasFocus ? focus?.provider === provider.id : activeProviders.has(provider.id);
  const edgeOpacity = (hot: boolean) => (hasFocus && !hot ? 0.22 : 1);

  const leftEdges = agents.map((agent, i) => {
    const y = agentCY(i);
    return { key: 'a-' + agent.agentId, d: `M ${leftX + nodeW} ${y} C ${leftX + nodeW + 70} ${y} ${gx - 70} ${gcY} ${gx} ${gcY}`, hot: agentHot(agent) };
  });
  const rightEdges = providers.map((provider, j) => {
    const y = provCY(j);
    return { key: 'p-' + provider.id, d: `M ${gx + gw} ${gcY} C ${gx + gw + 70} ${gcY} ${rightX - 70} ${y} ${rightX} ${y}`, hot: provHot(provider) };
  });

  return (
    <svg className="rflow" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Agent 到供应商模型的路由流向图" style={{ width: '100%', height: 'auto', display: 'block' }}>
      <style>{FLOW_CSS}</style>
      {[...leftEdges, ...rightEdges].map((edge) => (
        <g key={edge.key} opacity={edgeOpacity(edge.hot)}>
          <path d={edge.d} fill="none" stroke={edge.hot ? ACCENT : '#d5dae6'} strokeWidth={edge.hot ? 2.2 : 1.4} className={edge.hot ? 'rflow-hot-base' : 'rflow-base'} />
          <circle r={edge.hot ? 4 : 2.4} fill={edge.hot ? ACCENT : '#9aa4b8'} className="rflow-dot">
            <animateMotion dur={edge.hot ? '1.4s' : '3.2s'} repeatCount="indefinite" path={edge.d} />
          </circle>
        </g>
      ))}

      <g>
        <rect x={gx} y={gcY - 40} width={gw} height={80} rx={16} fill="#eef0ff" stroke={ACCENT} strokeWidth={1.4} />
        <text x={gx + gw / 2} y={gcY - 8} textAnchor="middle" fontSize={15} fontWeight={700} fill="#3730a3">⇄ 网关</text>
        <text x={gx + gw / 2} y={gcY + 14} textAnchor="middle" fontSize={10} fill="#6b7280">Daming Gateway</text>
        <text x={gx + gw / 2} y={gcY + 28} textAnchor="middle" fontSize={10} fill="#6b7280">127.0.0.1</text>
      </g>

      {agents.map((agent, i) => {
        const y = agentCY(i); const logo = agentLogo(agent.runtime, agent.agentId); const badge = agentFallback(agent.runtime, agent.agentId);
        const hot = agentHot(agent);
        const modelLabel = !agent.providerId ? '未绑定模型'
          : !agent.modelId ? agent.providerId
          : agent.modelId.startsWith(agent.providerId + '/') ? agent.modelId
          : agent.providerId + '/' + agent.modelId;
        return (
          <g key={agent.agentId} className="rflow-node" onClick={() => onFocusAgent(agent)} opacity={hasFocus && !hot ? 0.5 : 1}>
            <rect x={leftX} y={y - 32} width={nodeW} height={64} rx={12} fill="#fff" stroke={hot ? ACCENT : '#e2e6f0'} strokeWidth={hot ? 1.8 : 1.2} />
            {logo
              ? <image href={logo} x={leftX + 12} y={y - 15} width={30} height={30} preserveAspectRatio="xMidYMid meet" />
              : <><circle cx={leftX + 27} cy={y} r={15} fill={badge.color} /><text x={leftX + 27} y={y + 4} textAnchor="middle" fontSize={10} fontWeight={700} fill="#fff">{badge.label}</text></>}
            <text x={leftX + 52} y={y - 6} fontSize={13} fontWeight={600} fill="#111827">{agent.name}</text>
            <text x={leftX + 52} y={y + 12} fontSize={10.5} fill="#6b7280">{agent.runtime} · {modelLabel}</text>
          </g>
        );
      })}

      {providers.map((provider, j) => {
        const y = provCY(j); const logo = providerLogo(provider.id); const badge = fallbackBadge(provider.id);
        const hot = provHot(provider); const top = provider.models[0]; const pct = top ? quotas[provider.id + '/' + top] : undefined;
        return (
          <g key={provider.id} className="rflow-node" onClick={() => onFocusProvider(provider.id)} opacity={hasFocus && !hot ? 0.5 : 1}>
            <rect x={rightX} y={y - 34} width={provW} height={68} rx={12} fill="#fff" stroke={hot ? ACCENT : '#e2e6f0'} strokeWidth={hot ? 1.8 : 1.2} />
            {logo
              ? <image href={logo} x={rightX + 12} y={y - 15} width={30} height={30} preserveAspectRatio="xMidYMid meet" />
              : <><circle cx={rightX + 27} cy={y} r={15} fill={badge.color} /><text x={rightX + 27} y={y + 4} textAnchor="middle" fontSize={10} fontWeight={700} fill="#fff">{badge.label}</text></>}
            <text x={rightX + 52} y={y - 6} fontSize={13} fontWeight={600} fill="#111827">{provider.id}</text>
            <text x={rightX + 52} y={y + 12} fontSize={10.5} fill="#6b7280">{provider.models.length} 模型{top ? ' · ' + top.slice(0, 20) : ''}{pct !== undefined ? ' · 剩余 ' + pct + '%' : ''}</text>
          </g>
        );
      })}

      <text x={leftX} y={H - 4} fontSize={10} fill="#9aa4b8">Agent</text>
      <text x={W / 2} y={H - 4} textAnchor="middle" fontSize={10} fill="#9aa4b8">网关</text>
      <text x={rightX} y={H - 4} fontSize={10} fill="#9aa4b8">供应商 · 模型（点节点看额度）</text>
    </svg>
  );
}

export function RoutingGraphPanel({ session }: { session: SessionView }) {
  const [catalog, setCatalog] = useState<PlatformCatalogView | null>(null);
  const [quotas, setQuotas] = useState<Record<string, number>>({});
  const [groups, setGroups] = useState<RoutingGroupView[]>([]);
  const [profiles, setProfiles] = useState<RoutingProfileView[]>([]);
  const [requests, setRequests] = useState<GatewayRequestView[]>([]);
  const [accountCards, setAccountCards] = useState<AccountQuotaCard[]>([]);
  const [invProviders, setInvProviders] = useState<{ id: string; models: string[]; accountCount: number }[]>([]);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [groupForm, setGroupForm] = useState({ groupId: '', name: '', strategy: 'order' as 'order' | 'round' });
  const [selectedMembers, setSelectedMembers] = useState<Record<string, boolean>>({});
  const [profileForm, setProfileForm] = useState({ profileId: '', name: '' });
  const [profileAssign, setProfileAssign] = useState<Record<string, string>>({});

  const csrf = session.csrfToken;
  useAdaptiveResource({
    enabled: !!session,
    identity: 'routing:' + (session.identity?.tenantId ?? 'local'),
    scope: 'routing',
    scopes: ['providers', 'agents', 'platform', 'gateway'],
    intervalMs: () => (requests.length ? 6000 : 20000),
    fetcher: async (signal) => {
      const [cat, grp, prof, mb, obs, lq, inv] = await Promise.all([
        fetch('/api/platform/catalog', { signal, credentials: 'same-origin' }),
        fetch('/api/platform/groups', { signal, credentials: 'same-origin' }),
        fetch('/api/platform/profiles', { signal, credentials: 'same-origin' }),
        fetch('/api/model-binding', { signal, credentials: 'same-origin' }),
        fetch('/api/gateway/observability', { signal, credentials: 'same-origin' }),
        fetch('/api/magpie/local-quotas', { signal, credentials: 'same-origin' }),
        fetch('/api/magpie/inventory', { signal, credentials: 'same-origin' })
      ]);
      const catalog = cat.ok ? await cat.json() as PlatformCatalogView : null;
      const groups = grp.ok ? (await grp.json() as { groups?: RoutingGroupView[] }).groups ?? [] : [];
      const profiles = prof.ok ? (await prof.json() as { profiles?: RoutingProfileView[] }).profiles ?? [] : [];
      const quotas: Record<string, number> = {};
      if (mb.ok) {
        const data = await mb.json() as { catalog?: AvailableModelsView };
        for (const model of data.catalog?.models ?? []) {
          if (typeof model.quota.remainingPercent === 'number') quotas[model.providerId + '/' + model.modelId] = model.quota.remainingPercent;
        }
      }
      const observability = obs.ok ? await obs.json() as GatewayObservabilityView : null;
      const localQuota = lq.ok ? await lq.json() as { cards?: AccountQuotaCard[] } : null;
      const inventory = inv.ok ? await inv.json() as { providers?: { id: string; models?: string[]; accountCount?: number }[] } : null;
      const invProviders = (inventory?.providers ?? []).map((p) => ({ id: p.id, models: p.models ?? [], accountCount: p.accountCount ?? 0 }));
      return { catalog, groups, profiles, quotas, requests: (observability?.requests ?? []).slice(0, 12), accountCards: localQuota?.cards ?? [], invProviders };
    },
    onData: (value) => {
      if (value.catalog) setCatalog(value.catalog);
      setGroups(value.groups); setProfiles(value.profiles); setQuotas(value.quotas);
      setRequests(value.requests); setAccountCards(value.accountCards); setInvProviders(value.invProviders);
      setBusy(false); setError('');
    },
    onError: (cause) => { setError(cause instanceof Error ? cause.message : '读取失败'); setBusy(false); }
  });

  const providers = useMemo(() => {
    const map = new Map<string, { id: string; models: Set<string>; accountCount: number }>();
    for (const p of invProviders) map.set(p.id, { id: p.id, models: new Set(p.models), accountCount: p.accountCount });
    for (const p of catalog?.providers ?? []) {
      const cur = map.get(p.id) ?? { id: p.id, models: new Set<string>(), accountCount: 0 };
      for (const m of p.models) cur.models.add(m);
      map.set(p.id, cur);
    }
    return [...map.values()]
      .filter((p) => p.models.size > 0 || p.accountCount > 0)
      .map((p) => ({ id: p.id, models: [...p.models] } as unknown as ProviderConfigView));
  }, [invProviders, catalog]);
  const agents = catalog?.agents ?? [];
  const modelRefs = useMemo(() => providers.flatMap((provider) => provider.models.map((model) => ({ providerId: provider.id, modelId: model, ref: provider.id + '|||' + model }))), [providers]);
  const cardsByProvider = useMemo(() => {
    const map = new Map<string, AccountQuotaCard[]>();
    for (const card of accountCards) {
      const key = (card.provider || 'unknown').trim();
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(card);
    }
    return [...map.entries()];
  }, [accountCards]);
  const visibleCards = focus?.provider
    ? cardsByProvider.filter(([pid]) => pid.toLowerCase().includes(focus.provider!.toLowerCase()) || focus.provider!.toLowerCase().includes(pid.toLowerCase()))
    : cardsByProvider;

  const post = async (path: string, body: unknown) => {
    const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-daming-csrf': csrf }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({})) as { reason?: string };
    if (!response.ok) throw new Error(String(data.reason ?? 'request_failed'));
    return data;
  };
  const del = async (path: string) => {
    const response = await fetch(path, { method: 'DELETE', credentials: 'same-origin', headers: { 'x-daming-csrf': csrf } });
    if (!response.ok) { const data = await response.json().catch(() => ({})) as { reason?: string }; throw new Error(String(data.reason ?? 'delete_failed')); }
  };

  const createGroup = async () => {
    setMsg('');
    const members = Object.entries(selectedMembers).filter(([, on]) => on).map(([ref]) => { const [providerId, modelId] = ref.split('|||'); return { providerId, modelId }; });
    try { await post('/api/platform/groups', { groupId: groupForm.groupId.trim(), name: groupForm.name.trim() || groupForm.groupId.trim(), strategy: groupForm.strategy, members }); setMsg('已保存路由组 ' + groupForm.groupId.trim()); setGroupForm({ groupId: '', name: '', strategy: 'order' }); setSelectedMembers({}); notifyRefresh('routing'); }
    catch (cause) { setMsg(cause instanceof Error ? cause.message : '保存失败'); }
  };
  const removeGroup = async (groupId: string) => { setMsg(''); try { await del('/api/platform/groups?id=' + encodeURIComponent(groupId)); notifyRefresh('routing'); } catch (cause) { setMsg(cause instanceof Error ? cause.message : '删除失败'); } };
  const saveProfile = async () => {
    setMsg('');
    const assignments = Object.entries(profileAssign).filter(([, ref]) => ref).map(([agentId, ref]) => { const [providerId, modelId] = ref.split('|||'); return { agentId, providerId, modelId }; });
    try { await post('/api/platform/profiles', { profileId: profileForm.profileId.trim(), name: profileForm.name.trim() || profileForm.profileId.trim(), assignments }); setMsg('已保存 Profile ' + profileForm.profileId.trim()); setProfileForm({ profileId: '', name: '' }); setProfileAssign({}); notifyRefresh('routing'); }
    catch (cause) { setMsg(cause instanceof Error ? cause.message : '保存失败'); }
  };
  const applyProfile = async (profileId: string) => { setMsg(''); try { const result = await post('/api/platform/profiles/apply', { profileId }) as { applied?: string[] }; setMsg('已应用 ' + profileId + '：切换 ' + (result.applied?.length ?? 0) + ' 个 Agent'); notifyRefresh('routing'); notifyRefresh('agents'); } catch (cause) { setMsg(cause instanceof Error ? cause.message : '应用失败'); } };
  const removeProfile = async (profileId: string) => { setMsg(''); try { await del('/api/platform/profiles?id=' + encodeURIComponent(profileId)); notifyRefresh('routing'); } catch (cause) { setMsg(cause instanceof Error ? cause.message : '删除失败'); } };

  const canWrite = session.role === 'readwrite';
  const latest = requests[0];

  return (
    <section className="page-stack" id="routing" data-reveal>
      <header className="page-head">
        <div>
          <p className="eyebrow">ROUTING / AGENT → GATEWAY → PROVIDER · MODEL</p>
          <h2>路由</h2>
          <p className="hint">模型请求怎么走：Agent 用哪个供应商的哪个 LLM。下方「账号与额度」按 magpie 的额度优先排序，余额多的账号排前、快重置的额度优先用掉；点链路节点或请求行可高亮整条链路。</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {focus && <button type="button" className="ghost-btn" onClick={() => setFocus(null)}>清除高亮</button>}
          <button type="button" className="ghost-btn" onClick={() => notifyRefresh('routing')} disabled={busy}>{busy ? '刷新中…' : '刷新'}</button>
        </div>
      </header>
      {error && <div className="error-banner" role="alert">{error}</div>}
      {msg && <p className="hint" role="status">{msg}</p>}
      <div className="kpi-grid">
        <div className="kpi"><span className="label">供应商</span><div className="value">{providers.length}</div></div>
        <div className="kpi"><span className="label">Agent</span><div className="value">{agents.length}</div></div>
        <div className="kpi"><span className="label">路由组</span><div className="value">{groups.length}</div></div>
        <div className="kpi accent"><span className="label">最近请求</span><div className="value">{requests.length}</div></div>
      </div>

      <div className="status-card" style={{ padding: 12 }}>
        {providers.length || agents.length ? (
          <FlowGraph agents={agents} providers={providers} requests={requests} quotas={quotas} focus={focus}
            onFocusAgent={(agent) => setFocus({ agent: agent.agentId, provider: agent.providerId, model: agent.modelId })}
            onFocusProvider={(providerId) => setFocus({ provider: providerId })} />
        ) : (
          <div className="empty-card"><h3>还没有可路由的供应商或 Agent</h3><p>去「供应商」页接入模型、到「Agent」页给 Harness 绑定模型。</p></div>
        )}
        {focus && <p className="hint" style={{ marginTop: 6 }}>已高亮：{focus.agent ? 'Agent ' + focus.agent : ''}{focus.provider ? ' · 供应商 ' + focus.provider : ''}{focus.model ? ' · 模型 ' + focus.model : ''}</p>}
      </div>

      <div className="status-card quota-board" style={{ padding: 16 }}>
        <div className="card-title"><h3>账号与额度 · 额度优先</h3><span className="hint">有余额的账号排前；即将重置的额度优先用掉；一个额度用完自动换下一个</span></div>
        {visibleCards.length ? visibleCards.map(([pid, cards]) => (
          <div className="quota-provider" key={pid}>
            <div className="quota-head">
              {providerLogo(pid) ? <img src={providerLogo(pid)} alt="" width={20} height={20} /> : <span className="quota-badge">{pid.slice(0, 2).toUpperCase()}</span>}
              <strong>{pid}</strong>
              <span className="hint">{cards.length} 个账号</span>
              <span className="chip chip-ok" style={{ marginLeft: 'auto' }}>额度优先</span>
            </div>
            {cards.map((card, ci) => (
              <div className="quota-acct" key={ci}>
                <div className="quota-acct-head">
                  <strong>{card.name || card.provider}</strong>
                  <span className="hint">{[card.plan, card.user].filter(Boolean).join(' · ')}</span>
                </div>
                {card.windows.length ? card.windows.map((w, i) => {
                  const pct = Math.round(w.remainingPercent);
                  return (
                    <div className="qbar" key={i}>
                      <div className="qbar-top">
                        <span className="qbar-name">{w.name}{w.display ? ' · ' + w.display : ''}</span>
                        <span className={pct < 20 ? 'qbar-pct warn' : 'qbar-pct'}>{pct}%</span>
                      </div>
                      <div className="qbar-track"><span className={pct < 20 ? 'qbar-fill warn' : 'qbar-fill'} style={{ width: Math.max(2, Math.min(100, pct)) + '%' }} /></div>
                      {w.resetsAt && <span className="qbar-reset">重置：{new Date(w.resetsAt).toLocaleString()}</span>}
                    </div>
                  );
                }) : <span className="hint">无窗口数据</span>}
              </div>
            ))}
          </div>
        )) : <p className="hint">暂无账号额度数据。</p>}
      </div>

      <div className="status-card" style={{ padding: 14 }}>
        <div className="card-title"><h3>最近请求 · 怎么路由的</h3><span className="hint">点一行高亮该链路</span></div>
        {latest ? (
          <p className="hint" style={{ marginBottom: 8 }}>
            最近一次：<b>{latest.agent || '未署名'}</b> 请求 <b>{latest.providerId}/{latest.modelId}</b> · 经网关路由到 <b>{latest.providerId}</b> · {latest.status === 'ok' ? '成功' : '失败'}{latest.latencyMs ? ' · ' + latest.latencyMs + 'ms' : ''}{latest.outputTokens ? ' · 输出 ' + latest.outputTokens + ' tok' : ''}
          </p>
        ) : <p className="hint">暂无网关请求记录；跑一次 Agent 或离线推演后这里会出现流向。</p>}
        {requests.map((request) => {
          const actor = agents.find((agent) => matchesAgent(request.agent, agent));
          const logo = providerLogo(request.providerId, request.modelId);
          return (
            <div className="detected-row" key={request.requestId} style={{ cursor: 'pointer' }} onClick={() => setFocus({ agent: request.agent, provider: request.providerId, model: request.modelId })}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {agentLogo(actor?.runtime, actor?.agentId) ? <img src={agentLogo(actor?.runtime, actor?.agentId)} alt="" width={14} height={14} /> : null}
                {request.agent || '未署名'}
              </span>
              <span className="hint">→</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {logo ? <img src={logo} alt="" width={14} height={14} /> : null}
                {request.providerId}/{request.modelId}
              </span>
              <span className={request.status === 'ok' ? 'dm-okpill' : 'dm-idlepill'} style={{ marginLeft: 'auto' }}>{request.status === 'ok' ? 'ok' : 'error'}{request.latencyMs ? ' · ' + request.latencyMs + 'ms' : ''}</span>
              <span className="hint">{request.at ? new Date(request.at).toLocaleTimeString() : ''}</span>
            </div>
          );
        })}
      </div>

      <div className="status-card" style={{ padding: 16 }}>
        <div className="card-title"><h3>路由组 / 多模型故障切换 <span className="count">{groups.length}</span></h3><span className="hint">一个额度用完自动换下一个</span></div>
        {groups.length ? groups.map((group) => (
          <div className="detected-row" key={group.groupId}>
            <span className="dm-okpill">{group.strategy}</span><strong>{group.name}</strong>
            <span className="hint">{group.groupId} · {group.members.length} 成员</span>
            <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{group.members.map((member, index) => <span className="chip" key={index}>{member.providerId}/{member.modelId}</span>)}</span>
            {canWrite && <button type="button" className="link-btn" onClick={() => void removeGroup(group.groupId)}>删除</button>}
          </div>
        )) : <p className="hint">还没有路由组。</p>}
        {canWrite && (
          <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input placeholder="group id" value={groupForm.groupId} onChange={(event) => setGroupForm({ ...groupForm, groupId: event.target.value })} />
              <input placeholder="名称(可选)" value={groupForm.name} onChange={(event) => setGroupForm({ ...groupForm, name: event.target.value })} />
              <select value={groupForm.strategy} onChange={(event) => setGroupForm({ ...groupForm, strategy: event.target.value as 'order' | 'round' })}>
                <option value="order">order</option><option value="round">round</option>
              </select>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {modelRefs.map((ref) => (
                <label key={ref.ref} style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 12 }}>
                  <input type="checkbox" checked={!!selectedMembers[ref.ref]} onChange={(event) => setSelectedMembers({ ...selectedMembers, [ref.ref]: event.target.checked })} />
                  {ref.providerId}/{ref.modelId}
                </label>
              ))}
              {!modelRefs.length && <span className="hint">先在「供应商」页添加供应商模型</span>}
            </div>
            <div><button type="button" className="primary-btn" onClick={() => void createGroup()} disabled={!groupForm.groupId.trim()}>保存路由组</button></div>
          </div>
        )}
      </div>

      <div className="status-card" style={{ padding: 16 }}>
        <div className="card-title"><h3>Profile · 批量切换 LLM <span className="count">{profiles.length}</span></h3><span className="hint">一组 Agent→模型，一键整体切换</span></div>
        {profiles.length ? profiles.map((profile) => (
          <div className="detected-row" key={profile.profileId}>
            <span className="dm-idlepill">profile</span><strong>{profile.name}</strong>
            <span className="hint">{profile.profileId} · {profile.assignments.length} 条</span>
            <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{profile.assignments.map((assignment) => <span className="chip" key={assignment.agentId}>{assignment.agentId}→{assignment.providerId}/{assignment.modelId}</span>)}</span>
            {canWrite && <><button type="button" className="link-btn" onClick={() => void applyProfile(profile.profileId)}>应用</button><button type="button" className="link-btn" onClick={() => void removeProfile(profile.profileId)}>删除</button></>}
          </div>
        )) : <p className="hint">还没有 Profile。</p>}
        {canWrite && (
          <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input placeholder="profile id" value={profileForm.profileId} onChange={(event) => setProfileForm({ ...profileForm, profileId: event.target.value })} />
              <input placeholder="名称(可选)" value={profileForm.name} onChange={(event) => setProfileForm({ ...profileForm, name: event.target.value })} />
            </div>
            {agents.length ? agents.map((agent) => (
              <label key={agent.agentId} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
                <span style={{ minWidth: 130 }}>{agent.name}（{agent.agentId}）</span>
                <select value={profileAssign[agent.agentId] ?? ''} onChange={(event) => setProfileAssign({ ...profileAssign, [agent.agentId]: event.target.value })}>
                  <option value="">不改</option>
                  {modelRefs.map((ref) => <option key={ref.ref} value={ref.ref}>{ref.providerId}/{ref.modelId}</option>)}
                </select>
              </label>
            )) : <span className="hint">先添加 Agent 档案</span>}
            <div><button type="button" className="primary-btn" onClick={() => void saveProfile()} disabled={!profileForm.profileId.trim()}>保存 Profile</button></div>
          </div>
        )}
      </div>
    </section>
  );
}
