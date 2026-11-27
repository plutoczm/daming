import { useMemo, useState } from 'react';
import type { AgentProfileView, AgentTarget, AvailableModelView, AvailableModelsView, ModelBindingView, SessionView } from '@daming/contracts';
import { notifyRefresh, useAdaptiveResource } from './live-refresh.ts';

const HARNESSES: readonly { id: AgentTarget; name: string; harness: string }[] = [
  { id: 'dsh', name: 'DeepSeek Harness', harness: 'DSH · ACP' },
  { id: 'codex', name: 'Codex', harness: 'Codex CLI' },
  { id: 'claude-code', name: 'Claude Code', harness: 'Claude Code CLI' }
];

export function AgentsPanel({ session }: { session: SessionView }) {
  const [catalog, setCatalog] = useState<AvailableModelsView | null>(null);
  const [bindings, setBindings] = useState<ModelBindingView[]>([]);
  const [provider, setProvider] = useState('');
  const [modelId, setModelId] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [customAgents, setCustomAgents] = useState<AgentProfileView[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [addMsg, setAddMsg] = useState('');
  const [agentForm, setAgentForm] = useState({ agentId: '', name: '', runtime: 'dsh' as AgentTarget, modelRef: '' });

  const request = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch('/api/model-binding' + path, {
      method, credentials: 'same-origin',
      headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-daming-csrf': session.csrfToken },
      ...(method === 'GET' || method === 'DELETE' ? {} : { body: JSON.stringify(body ?? {}) })
    });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(String(data.reason ?? 'model_binding_action_rejected'));
    return data;
  };

  // `agents` re-fetches after a profile/binding write; `providers`/`routing` cover
  // catalog and batch-switch changes.
  useAdaptiveResource({
    enabled: !!session,
    identity: 'agents:' + (session.identity?.tenantId ?? 'local'),
    scope: 'agents',
    scopes: ['providers', 'routing'],
    intervalMs: 60000,
    fetcher: async (signal) => {
      const [bindingResponse, platformResponse] = await Promise.all([
        fetch('/api/model-binding', { signal, credentials: 'same-origin' }),
        fetch('/api/platform/catalog', { signal, credentials: 'same-origin' })
      ]);
      if (!bindingResponse.ok) throw new Error('model_binding_catalog_unavailable');
      const bindingData = await bindingResponse.json() as { catalog?: AvailableModelsView; bindings?: ModelBindingView[] };
      const platform = platformResponse.ok
        ? await platformResponse.json() as { agents?: AgentProfileView[] } : { agents: [] };
      return {
        catalog: bindingData.catalog ?? null,
        bindings: bindingData.bindings ?? [],
        customAgents: platform.agents ?? []
      };
    },
    onData: (value) => {
      setCatalog(value.catalog);
      setBindings(value.bindings);
      setCustomAgents(value.customAgents);
      setMessage('');
    },
    onError: () => setMessage('暂时读不到供应商目录')
  });

  const models = catalog?.models ?? [];
  const providerIds = useMemo(() => [...new Set(models.map((model) => model.providerId))], [models]);
  const providerModels = useMemo(() => models.filter((model) => model.providerId === provider && model.dispatchable), [models, provider]);
  const modelRefs = useMemo(() => models.filter((model) => model.dispatchable).map((model) => `${model.providerId}|||${model.modelId}`), [models]);

  const activeBinding = (agent: AgentTarget) => bindings.find((binding) => binding.agent === agent && binding.status === 'active' && binding.scope.kind === 'tenant');
  const bind = async (agent: AgentTarget) => {
    if (!modelId) { setMessage('先在上方选择供应商提供的模型'); return; }
    setBusy(agent); setMessage('');
    try { await request('/bind', 'POST', { agent, modelId, scope: { kind: 'tenant' } }); notifyRefresh('agents'); notifyRefresh('routing'); setMessage('已绑定：' + agent + ' → ' + modelId); }
    catch (error) { setMessage(error instanceof Error ? error.message : '绑定失败'); } finally { setBusy(''); }
  };
  const revoke = async (bindingId: string) => {
    setBusy(bindingId); setMessage('');
    try { await request('/' + bindingId, 'DELETE'); notifyRefresh('agents'); notifyRefresh('routing'); setMessage('已撤销绑定'); }
    catch (error) { setMessage(error instanceof Error ? error.message : '撤销失败'); } finally { setBusy(''); }
  };
  const addAgent = async () => {
    setAddMsg('');
    const [providerId, mid] = agentForm.modelRef ? agentForm.modelRef.split('|||') : ['', ''];
    try {
      const response = await fetch('/api/platform/agents', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-daming-csrf': session.csrfToken },
        body: JSON.stringify({ agentId: agentForm.agentId.trim(), name: agentForm.name.trim(), runtime: agentForm.runtime, ...(providerId ? { providerId, modelId: mid } : {}) }) });
      const data = await response.json().catch(() => ({})) as { reason?: string };
      if (!response.ok) throw new Error(String(data.reason ?? 'agent_add_failed'));
      setAddMsg('已添加 ' + agentForm.agentId.trim());
      setAgentForm({ agentId: '', name: '', runtime: 'dsh', modelRef: '' }); setShowAdd(false);
      notifyRefresh('agents'); notifyRefresh('routing');
    } catch (cause) { setAddMsg(cause instanceof Error ? cause.message : '添加失败'); }
  };
  const switchModel = async (agentId: string, modelRef: string) => {
    if (!modelRef) return;
    const [providerId, mid] = modelRef.split('|||');
    setAddMsg('');
    try {
      const response = await fetch('/api/platform/agents/model', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-daming-csrf': session.csrfToken }, body: JSON.stringify({ agentId, providerId, modelId: mid }) });
      if (!response.ok) { const data = await response.json().catch(() => ({})) as { reason?: string }; throw new Error(String(data.reason ?? 'switch_failed')); }
      notifyRefresh('agents'); notifyRefresh('routing'); setAddMsg('已切换 ' + agentId + ' → ' + mid);
    } catch (cause) { setAddMsg(cause instanceof Error ? cause.message : '切换失败'); }
  };
  const removeAgent = async (agentId: string) => {
    setAddMsg('');
    try { await fetch('/api/platform/agents?id=' + encodeURIComponent(agentId), { method: 'DELETE', credentials: 'same-origin', headers: { 'x-daming-csrf': session.csrfToken } }); notifyRefresh('agents'); notifyRefresh('routing'); }
    catch (cause) { setAddMsg(cause instanceof Error ? cause.message : '删除失败'); }
  };

  const canWrite = session.role === 'readwrite';

  return (
    <section className="page-stack agents-page" aria-label="Agent">
      <header className="page-head">
        <div>
          <h2>Agent</h2>
          <p className="hint">供应商提供模型；在下方任一 Agent 选择模型即可派工，模型随时可换。</p>
        </div>
      </header>

      <div className="status-card" style={{ padding: 14 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>供应商
            <select value={provider} onChange={(event) => { setProvider(event.target.value); setModelId(''); }}>
              <option value="">选择供应商</option>{providerIds.map((id) => <option key={id} value={id}>{id}</option>)}
            </select>
          </label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>模型
            <select value={modelId} onChange={(event) => setModelId(event.target.value)} disabled={!provider}>
              <option value="">{provider ? '选择模型' : '先选供应商'}</option>
              {providerModels.map((model: AvailableModelView) => <option key={model.modelId} value={model.modelId}>{model.modelId}{model.quota.remainingPercent !== undefined ? ` · 剩余 ${model.quota.remainingPercent}%` : ''}</option>)}
            </select>
          </label>
          <span className="hint" style={{ marginLeft: 'auto' }}>{provider ? providerModels.length + ' 个可派工模型' : providerIds.length + ' 个供应商'}</span>
        </div>
      </div>

      {(message || addMsg) && <p className="hint" role="status">{message || addMsg}</p>}

      <div className="status-card" style={{ padding: 16 }}>
        <div className="card-title"><h3>内置 Harness</h3></div>
        {HARNESSES.map((agent) => {
          const binding = activeBinding(agent.id);
          return (
            <div className="detected-row" key={agent.id}>
              <span className="dm-dot" style={{ background: binding ? 'var(--ok)' : '#c9c5bc' }} />
              <strong>{agent.name}</strong>
              <span>{agent.harness}</span>
              <b style={{ marginLeft: 'auto', fontSize: 11.5 }}>{binding ? (binding.modelId.startsWith(binding.providerId + '/') ? binding.modelId : binding.providerId + '/' + binding.modelId) : '未绑定'}</b>
              <button type="button" className="ghost-btn" disabled={!modelId || busy === agent.id} onClick={() => void bind(agent.id)}>{busy === agent.id ? '绑定中…' : binding ? '改用所选模型' : '绑定所选模型'}</button>
              {binding && <button type="button" className="link-btn" disabled={busy === binding.bindingId} onClick={() => void revoke(binding.bindingId)}>撤销</button>}
            </div>
          );
        })}
      </div>

      <div className="status-card" style={{ padding: 16 }}>
        <div className="card-title"><h3>自定义 Agent <span className="count">{customAgents.length}</span></h3>
          {canWrite && <button type="button" className="ghost-btn" onClick={() => { setAddMsg(''); setShowAdd((open) => !open); }}>＋ 添加</button>}
        </div>
        {customAgents.map((agent) => (
          <div className="detected-row" key={agent.agentId}>
            <span className="dm-dot" style={{ background: 'var(--brand)' }} />
            <strong>{agent.name}</strong>
            <span>{agent.agentId} · {agent.runtime}</span>
            <select value={agent.providerId && agent.modelId ? `${agent.providerId}|||${agent.modelId}` : ''} onChange={(event) => void switchModel(agent.agentId, event.target.value)} style={{ marginLeft: 'auto' }}>
              <option value="">{agent.modelId ? `当前 ${agent.modelId.startsWith((agent.providerId ?? '') + '/') ? agent.modelId : agent.providerId + '/' + agent.modelId}` : '选择模型'}</option>
              {modelRefs.map((ref) => <option key={ref} value={ref}>{ref.replace('|||', '/')}</option>)}
            </select>
            {canWrite && <button type="button" className="link-btn" onClick={() => void removeAgent(agent.agentId)}>删除</button>}
          </div>
        ))}
        {!customAgents.length && !showAdd && <p className="hint">还没有自定义 Agent。点「＋ 添加」创建可复用的命名 Agent（如评审员、架构师）。</p>}
        {showAdd && (
          <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 8 }}>
              <label>Agent ID<input value={agentForm.agentId} onChange={(event) => setAgentForm({ ...agentForm, agentId: event.target.value })} placeholder="如 reviewer" /></label>
              <label>名称<input value={agentForm.name} onChange={(event) => setAgentForm({ ...agentForm, name: event.target.value })} placeholder="如 代码评审" /></label>
              <label>Runtime
                <select value={agentForm.runtime} onChange={(event) => setAgentForm({ ...agentForm, runtime: event.target.value as AgentTarget })}>
                  <option value="dsh">DeepSeek Harness (ACP)</option><option value="codex">Codex CLI</option><option value="claude-code">Claude Code CLI</option>
                </select>
              </label>
              <label>模型（可选）
                <select value={agentForm.modelRef} onChange={(event) => setAgentForm({ ...agentForm, modelRef: event.target.value })}>
                  <option value="">先不绑定</option>{modelRefs.map((ref) => <option key={ref} value={ref}>{ref.replace('|||', '/')}</option>)}
                </select>
              </label>
            </div>
            <div><button type="button" className="primary-btn" onClick={() => void addAgent()} disabled={!agentForm.agentId.trim() || !agentForm.name.trim()}>保存 Agent</button></div>
          </div>
        )}
      </div>
    </section>
  );
}
