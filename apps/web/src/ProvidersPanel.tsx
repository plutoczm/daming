import { useMemo, useState } from 'react';
import type { AvailableModelView, AvailableModelsView, SessionView } from '@daming/contracts';
import { notifyRefresh, useAdaptiveResource } from './live-refresh.ts';

interface ProviderGroup {
  readonly providerId: string;
  readonly models: readonly AvailableModelView[];
  readonly kinds: readonly string[];
  readonly dispatchable: number;
  readonly accountCount: number;
  readonly accountLabels: readonly string[];
  readonly extraModels: readonly string[];
}
interface InventoryProvider { id: string; name: string; models: string[]; accountCount: number; accountLabels: string[]; kind: string }
interface InventoryAccount { provider: string; id: string; accountId?: string; type?: string; expiresAt?: number; hasAccess: boolean; hasRefresh: boolean; detail?: string }
interface Inventory { providers: InventoryProvider[]; accounts: InventoryAccount[]; agents: unknown[]; checkedAt: string }
interface QuotaWindow { name: string; used: number; remainingPercent: number; resetsAt?: string; display?: string }
interface QuotaCard { provider: string; name: string; plan: string; user: string; checkedAt: string; windows: QuotaWindow[] }

const KIND_LABEL: Record<string, string> = {
  subscription: '订阅账号', api_key: 'API Key', local: '本地运行时', native: '原生', magpie: '网关',
};

export function ProvidersPanel({ session }: { session: SessionView }) {
  const [catalog, setCatalog] = useState<AvailableModelsView | null>(null);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [addMsg, setAddMsg] = useState('');
  const [form, setForm] = useState({ id: '', api: 'openai-completions', baseUrl: '', models: '', apiKeyEnv: '' });
  const [openId, setOpenId] = useState<string | null>(null);
  const [quotas, setQuotas] = useState<QuotaCard[] | null>(null);

  const openDetail = async (providerId: string) => {
    const next = openId === providerId ? null : providerId;
    setOpenId(next);
    if (next && quotas === null) {
      try {
        const response = await fetch('/api/magpie/local-quotas', { credentials: 'same-origin' });
        if (response.ok) {
          const data = await response.json().catch(() => ({})) as { cards?: QuotaCard[] };
          setQuotas(data.cards ?? []);
        }
      } catch { /* quota windows are optional */ }
    }
  };

  const load = async () => {
    setBusy(true); setError('');
    try {
      const [response, inventoryResponse] = await Promise.all([
        fetch('/api/model-binding', { credentials: 'same-origin' }),
        fetch('/api/magpie/inventory', { credentials: 'same-origin' })
      ]);
      const data = await response.json().catch(() => ({})) as { catalog?: AvailableModelsView };
      if (!response.ok) throw new Error('provider_catalog_unavailable');
      setCatalog(data.catalog ?? null);
      if (inventoryResponse.ok) setInventory(await inventoryResponse.json() as Inventory);
    } catch { setError('暂时读不到供应商目录，请检查网关。'); }
    finally { setBusy(false); }
  };

  // Live: the Host publishes `providers` after a provider/gateway write is persisted;
  // polling stays as the fallback when SSE is disconnected.
  useAdaptiveResource({
    enabled: !!session,
    identity: 'providers:' + (session.identity?.tenantId ?? 'local'),
    scope: 'providers',
    scopes: ['platform'],
    intervalMs: 60000,
    fetcher: async (signal) => {
      const [response, inventoryResponse] = await Promise.all([
        fetch('/api/model-binding', { signal, credentials: 'same-origin' }),
        fetch('/api/magpie/inventory', { signal, credentials: 'same-origin' })
      ]);
      if (!response.ok) throw new Error('provider_catalog_unavailable');
      const data = await response.json().catch(() => ({})) as { catalog?: AvailableModelsView };
      const next: { catalog: AvailableModelsView | null; inventory: Inventory | null } = {
        catalog: data.catalog ?? null, inventory: null
      };
      if (inventoryResponse.ok) next.inventory = await inventoryResponse.json() as Inventory;
      return next;
    },
    onData: (value) => {
      setCatalog(value.catalog);
      if (value.inventory) setInventory(value.inventory);
      setError('');
      setBusy(false);
    },
    onError: () => { setError('暂时读不到供应商目录，请检查网关。'); setBusy(false); }
  });

  const addProvider = async () => {
    setAddMsg('');
    try {
      const response = await fetch('/api/platform/providers', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-daming-csrf': session.csrfToken },
        body: JSON.stringify({
          id: form.id.trim(), api: form.api, baseUrl: form.baseUrl.trim(),
          models: form.models.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean),
          ...(form.apiKeyEnv.trim() ? { apiKeyEnv: form.apiKeyEnv.trim() } : {})
        })
      });
      const data = await response.json().catch(() => ({})) as { reason?: string };
      if (!response.ok) throw new Error(String(data.reason ?? 'provider_add_failed'));
      setAddMsg('已添加供应商 ' + form.id.trim());
      setForm({ id: '', api: 'openai-completions', baseUrl: '', models: '', apiKeyEnv: '' });
      setShowAdd(false);
      notifyRefresh('providers');
    } catch (cause) { setAddMsg(cause instanceof Error ? cause.message : '添加失败'); }
  };

  const providers = useMemo<ProviderGroup[]>(() => {
    const map = new Map<string, AvailableModelView[]>();
    for (const model of catalog?.models ?? []) {
      const list = map.get(model.providerId) ?? [];
      list.push(model);
      map.set(model.providerId, list);
    }
    const inventoryMap = new Map((inventory?.providers ?? []).map((provider) => [provider.id, provider]));
    const ids = new Set([...map.keys(), ...inventoryMap.keys()]);
    return [...ids].map((providerId) => {
      const models = map.get(providerId) ?? [];
      const magpie = inventoryMap.get(providerId);
      const extraModels = (magpie?.models ?? []).filter((model) =>
        !models.some((known) => known.modelId.toLowerCase().endsWith('/' + model.toLowerCase()) || known.modelId.toLowerCase() === model.toLowerCase()));
      return {
        providerId, models,
        kinds: [...new Set(models.map((model) => model.sourceKind))],
        dispatchable: models.filter((model) => model.dispatchable).length,
        accountCount: magpie?.accountCount ?? 0,
        accountLabels: [...new Set(magpie?.accountLabels ?? [])],
        extraModels
      };
    })
      // Hide providers that are only "registered" but unusable: no models and no
      // accounts means nothing can ever be dispatched from them.
      .filter((group) => group.models.length + group.extraModels.length > 0 || group.accountCount > 0)
      .sort((a, b) => (b.models.length + b.extraModels.length) - (a.models.length + a.extraModels.length));
  }, [catalog, inventory]);

  const totalModels = providers.reduce((sum, provider) => sum + provider.models.length + provider.extraModels.length, 0);
  const totalDispatch = providers.reduce((sum, provider) => sum + provider.dispatchable, 0);
  const canWrite = session.role === 'readwrite';

  return (
    <section className="page-stack providers-page" aria-label="供应商">
      <header className="page-head">
        <div>
          <p className="eyebrow">SUPPLIERS / REAL ACCOUNTS</p>
          <h2>供应商</h2>
          <p className="hint">供应商提供模型：Codex 账号、WorkBuddy 账号、API Key 或本地运行时。Agent 只是 Harness，模型永远来自这里。</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {canWrite && <button type="button" className="ghost-btn" onClick={() => { setAddMsg(''); setShowAdd((open) => !open); }}>＋ 添加供应商</button>}
          <button type="button" className="ghost-btn" onClick={() => void load()} disabled={busy}>{busy ? '检查中…' : '刷新供应商'}</button>
        </div>
      </header>

      {error && <div className="error-banner" role="alert">{error}</div>}

      <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(3, minmax(0,1fr))' }}>
        <div className="kpi"><span className="label">供应商</span><div className="value">{providers.length}</div></div>
        <div className="kpi"><span className="label">模型</span><div className="value">{totalModels}</div></div>
        <div className="kpi accent"><span className="label">可派工</span><div className="value">{totalDispatch}</div></div>
      </div>

      {showAdd && (
        <div className="status-card" style={{ padding: 16 }}>
          <div className="card-title"><h3>添加供应商（配置即插，不写代码）</h3><span className="hint">密钥只填环境变量名，不存明文</span></div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 8 }}>
            <label>ID<input value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} placeholder="如 deepseek / zcode" /></label>
            <label>协议
              <select value={form.api} onChange={(e) => setForm({ ...form, api: e.target.value })}>
                <option value="openai-completions">openai-completions</option>
                <option value="openai-responses">openai-responses</option>
                <option value="anthropic-messages">anthropic-messages</option>
              </select>
            </label>
            <label>Base URL<input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.xxx.com" /></label>
            <label>模型（逗号分隔）<input value={form.models} onChange={(e) => setForm({ ...form, models: e.target.value })} placeholder="model-a, model-b" /></label>
            <label>Key 环境变量名（可选）<input value={form.apiKeyEnv} onChange={(e) => setForm({ ...form, apiKeyEnv: e.target.value })} placeholder="DEEPSEEK_API_KEY" /></label>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button type="button" className="primary-btn" onClick={() => void addProvider()} disabled={!form.id.trim() || !form.baseUrl.trim() || !form.models.trim()}>保存供应商</button>
            <button type="button" className="link-btn" onClick={() => setShowAdd(false)}>取消</button>
            {addMsg && <span className="hint">{addMsg}</span>}
          </div>
        </div>
      )}

      {!providers.length && (
        <div className="empty-card">
          <div className="empty-art" aria-hidden="true"><span className="empty-orb" /><span className="empty-ring" /></div>
          <h3>还没有接入供应商</h3>
          <p>点右上「＋ 添加供应商」，或在平台状态里连接 Daming 网关后，账号会自动出现在这里。</p>
        </div>
      )}

      <div className="provider-grid pv-list" role="list">
        {providers.map((provider) => {
          const modelCount = provider.models.length + provider.extraModels.length;
          const kinds = provider.kinds.map((kind) => KIND_LABEL[kind] ?? kind).join(' · ') || 'api-key';
          return (
            <div className={'pv-item' + (openId === provider.providerId ? ' open' : '')} key={provider.providerId}>
              <article
                className="pv-row"
                role="button"
                tabIndex={0}
                aria-expanded={openId === provider.providerId}
                onClick={() => void openDetail(provider.providerId)}
                onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void openDetail(provider.providerId); } }}
              >
                <span className="pv-mark" aria-hidden="true">{provider.providerId.slice(0, 1)}</span>
                <div className="pv-main">
                  <div className="pv-name"><strong>{provider.providerId}</strong><span className="pv-kind">{kinds}</span></div>
                  <div className="pv-sub">
                    <span>{modelCount} 个模型</span>
                    <span className="pv-dot" aria-hidden="true" />
                    <span>{provider.accountCount} 个账号</span>
                    {provider.accountLabels.length > 0 && (
                      <>
                        <span className="pv-dot" aria-hidden="true" />
                        <span>{provider.accountLabels.slice(0, 2).join(' · ')}{provider.accountLabels.length > 2 ? ` +${provider.accountLabels.length - 2}` : ''}</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="pv-models">
                  {provider.models.slice(0, 4).map((model) => (
                    <span className={model.dispatchable ? 'chip chip-ok' : 'chip'} key={model.modelId}>
                      {model.modelId}{model.quota.remainingPercent !== undefined ? ` · ${model.quota.remainingPercent}%` : ''}
                    </span>
                  ))}
                  {provider.models.length === 0 && provider.extraModels.slice(0, 4).map((model) => (
                    <span className="chip chip-ok" key={model}>{provider.providerId}/{model}</span>
                  ))}
                  {modelCount > 4 && <span className="chip chip-more">+{modelCount - 4}</span>}
                </div>
                <div className="pv-state">
                  <span className={provider.dispatchable ? 'pv-pill ok' : 'pv-pill idle'}>
                    {provider.dispatchable ? `可派工 ${provider.dispatchable}` : '仅登记'}
                  </span>
                  <span className="pv-chev" aria-hidden="true">{openId === provider.providerId ? '⌄' : '›'}</span>
                </div>
              </article>
              {openId === provider.providerId && (
                <div className="pv-detail">
                  {(() => {
                    const accounts = (inventory?.accounts ?? []).filter((account) => account.provider === provider.providerId);
                    const providerQuotas = (quotas ?? []).filter((card) => card.provider === provider.providerId);
                    return (
                      <>
                        <div className="pv-detail-col">
                          <h4>账号（{accounts.length}）</h4>
                          {accounts.length === 0 && <p className="hint">该供应商暂无账号。</p>}
                          {accounts.map((account) => (
                            <div className="pv-account" key={account.id}>
                              <strong>{account.detail ?? account.accountId ?? account.id}</strong>
                              <span className="pv-dot" aria-hidden="true" />
                              <span>{account.type ?? 'oauth'}</span>
                              <span className="pv-dot" aria-hidden="true" />
                              <span className={(account.hasAccess || account.type === 'oauth') ? 'chip chip-ok' : 'chip'}>{account.type === 'oauth' ? '订阅账号' : (account.hasAccess ? '可用' : '无凭证')}</span>
                            </div>
                          ))}
                        </div>
                        <div className="pv-detail-col">
                          <h4>额度窗口</h4>
                          {providerQuotas.length === 0 && <p className="hint">暂无额度数据（本地运行时或 API Key 供应商通常无窗口）。</p>}
                          {providerQuotas.map((card) => (
                            <div className="pv-quota" key={card.user + card.name}>
                              <div className="pv-quota-head"><strong>{card.user}</strong><span className="pv-kind">{card.name} · {card.plan}</span></div>
                              {card.windows.map((window) => (
                                <div className="pv-quota-window" key={window.name}>
                                  <span>{window.display ?? window.name}</span>
                                  <span className={window.remainingPercent < 20 ? 'pv-pill warn' : 'pv-pill ok'}>剩余 {Math.round(window.remainingPercent)}%</span>
                                  {window.resetsAt && <span className="hint">{window.resetsAt} 重置</span>}
                                </div>
                              ))}
                            </div>
                          ))}
                        </div>
                      </>
                    );
                  })()}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
