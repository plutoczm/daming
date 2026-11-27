import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  AgentTarget, AvailableModelView, AvailableModelsView, ModelBindingScopeView, ModelBindingView, SessionView
} from '@daming/contracts';

const AGENTS: readonly { id: AgentTarget; label: string }[] = [
  { id: 'dsh', label: 'DSH（DeepSeek Harness）' },
  { id: 'codex', label: 'Codex' },
  { id: 'claude-code', label: 'Claude Code' }
];

export function ModelBindingPanel({ session }: { session: SessionView }) {
  const [catalog, setCatalog] = useState<AvailableModelsView | null>(null);
  const [bindings, setBindings] = useState<ModelBindingView[]>([]);
  const [agent, setAgent] = useState<AgentTarget>('dsh');
  const [modelId, setModelId] = useState('');
  const [scopeKind, setScopeKind] = useState<'tenant' | 'task'>('tenant');
  const [taskId, setTaskId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const tenantId = session.identity?.tenantId;

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
  const reload = async () => {
    const data = await request('');
    setCatalog((data.catalog ?? null) as AvailableModelsView | null);
    setBindings((data.bindings ?? []) as ModelBindingView[]);
  };
  useEffect(() => {
    setCatalog(null); setBindings([]); setMessage('');
    void reload().catch(() => setMessage('无法读取本租户模型目录'));
  }, [tenantId]);

  const dispatchable = (catalog?.models ?? []).filter((model: AvailableModelView) => model.dispatchable);
  const doAction = (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setMessage('');
    void fn().catch((error) => setMessage(error instanceof Error ? error.message : '操作被拒绝'))
      .finally(() => setBusy(false));
  };
  const bind = (event: FormEvent) => {
    event.preventDefault();
    doAction(async () => {
      const scope: ModelBindingScopeView = scopeKind === 'task' ? { kind: 'task', taskId } : { kind: 'tenant' };
      await request('/bind', 'POST', { agent, modelId, scope });
      await reload();
    });
  };
  const revoke = (bindingId: string) => {
    doAction(async () => { await request('/' + bindingId, 'DELETE'); await reload(); });
  };

  return (
    <section className="lulu-card" aria-label="模型自选与 Agent 绑定">
      <h3>选模型 → 选 Agent（只读目录 / 脱敏）</h3>
      <p className="hint">目录来自 Magpie 统一路由投影，只显示脱敏的来源类型、模型 id、额度窗口与计费方式。绑定按租户隔离、可撤销、重启保留；跨租户不可见。此处不展示任何令牌、账号登录名或供应商 URL。</p>
      <form onSubmit={bind}>
        <label>执行器
          <select value={agent} onChange={(e) => setAgent(e.target.value as AgentTarget)}>
            {AGENTS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
        <label>可用模型
          <select value={modelId} onChange={(e) => setModelId(e.target.value)} required>
            <option value="">请选择可派工模型</option>
            {dispatchable.map((model) => (
              <option key={model.modelId} value={model.modelId}>
                {model.modelId} · {model.sourceKind} · {model.billing === 'cash' ? '现金' : '额度'}
                {model.quota.remainingPercent === undefined ? '' : ` · 剩余 ${model.quota.remainingPercent}%`}
              </option>
            ))}
          </select>
        </label>
        <label>作用域
          <select value={scopeKind} onChange={(e) => setScopeKind(e.target.value as 'tenant' | 'task')}>
            <option value="tenant">整租户</option>
            <option value="task">指定任务</option>
          </select>
        </label>
        {scopeKind === 'task' && <label>任务 ID
          <input value={taskId} onChange={(e) => setTaskId(e.target.value)} placeholder="task-id" required />
        </label>}
        <button type="submit" disabled={busy || !modelId}>绑定模型到该 Agent</button>
      </form>
      <ul>
        {bindings.map((binding) => (
          <li key={binding.bindingId}>
            {binding.agent} · {binding.modelId} · {binding.scope.kind === 'task' ? `任务 ${binding.scope.taskId}` : '整租户'} ·{' '}
            {binding.status === 'active' ? '生效中' : '已撤销'}
            {binding.status === 'active' && <button type="button" disabled={busy} onClick={() => revoke(binding.bindingId)}>撤销绑定</button>}
          </li>
        ))}
        {bindings.length === 0 && <li className="hint">本租户暂无绑定。</li>}
      </ul>
      {message && <p role="status" className="hint">{message}</p>}
    </section>
  );
}
