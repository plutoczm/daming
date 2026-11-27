import { useState } from 'react';
import type { PlatformCatalogView, SessionView } from '@daming/contracts';
import { notifyRefresh, useAdaptiveResource } from './live-refresh.ts';

interface GatewayStatus { state: 'stopped' | 'starting' | 'running' | 'failed'; port: number; providersFile: string; scriptPath: string; reason: string }

export function PlatformStatusPanel({ session }: { session: SessionView }) {
  const [catalog, setCatalog] = useState<PlatformCatalogView | null>(null);
  const [gw, setGw] = useState<GatewayStatus | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');

  const csrf = session.csrfToken;
  // Live: gateway start/stop/reload and provider writes publish `platform`.
  useAdaptiveResource({
    enabled: !!session,
    identity: 'platform:' + (session.identity?.tenantId ?? 'local'),
    scope: 'platform',
    scopes: ['providers', 'gateway'],
    intervalMs: 30000,
    fetcher: async (signal) => {
      const [cat, g] = await Promise.all([
        fetch('/api/platform/catalog', { signal, credentials: 'same-origin' }),
        fetch('/api/platform/gateway/status', { signal, credentials: 'same-origin' })
      ]);
      return {
        catalog: cat.ok ? await cat.json() as PlatformCatalogView : null,
        gateway: g.ok ? await g.json() as GatewayStatus : null
      };
    },
    onData: (value) => {
      if (value.catalog) setCatalog(value.catalog);
      if (value.gateway) setGw(value.gateway);
    },
    onError: () => undefined
  });

  const act = async (action: 'start' | 'stop' | 'reload') => {
    setBusy(action); setMsg('');
    try {
      const response = await fetch('/api/platform/gateway/' + action, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-daming-csrf': csrf }, body: '{}' });
      const data = await response.json().catch(() => ({})) as Partial<GatewayStatus> & { reason?: string };
      if (data && typeof data.state === 'string') setGw(data as GatewayStatus);
      setMsg(response.ok ? ('网关已' + (action === 'start' ? '启动' : action === 'stop' ? '停止' : '重载')) : ('操作未完成：' + (data.reason || '请检查网关脚本配置')));
    } catch (error) { setMsg(error instanceof Error ? error.message : '操作失败'); }
    finally { setBusy(''); notifyRefresh('platform'); notifyRefresh('providers'); }
  };

  const providers = catalog?.providers ?? [];
  const agents = catalog?.agents ?? [];
  const totalModels = providers.reduce((sum, provider) => sum + provider.models.length, 0);
  const gwRunning = gw?.state === 'running';
  const canWrite = session.role === 'readwrite';

  return (
    <section className="page-stack" id="platform" data-reveal>
      <header className="page-head">
        <div>
          <p className="eyebrow">GATEWAY / Daming 自持</p>
          <h2>平台状态</h2>
          <p className="hint">大铭自建模型网关：供应商 → 网关 → Agent。网关由大铭托管，可选择启动/停止/重载；密钥只在本机。</p>
        </div>
        <button type="button" className="ghost-btn" onClick={() => notifyRefresh('platform')}>刷新</button>
      </header>
      {msg && <p className="hint" role="status">{msg}</p>}

      <div className="kpi-grid">
        <div className={`kpi${gwRunning ? '' : ' accent'}`}><span className="label">网关引擎</span><div className="value">{gwRunning ? '运行中' : gw?.state === 'starting' ? '启动中' : gw?.state === 'failed' ? '启动失败' : '未启动'}</div></div>
        <div className="kpi"><span className="label">供应商</span><div className="value">{providers.length}</div></div>
        <div className="kpi"><span className="label">模型</span><div className="value">{totalModels}</div></div>
        <div className="kpi"><span className="label">Agent</span><div className="value">{agents.length}</div></div>
      </div>

      <div className="status-card" style={{ padding: 16 }}>
        <div className="card-title"><h3>网关引擎</h3><span className={gwRunning ? 'dm-okpill' : 'dm-idlepill'}>{gw?.state ?? '未启动'}</span></div>
        <div className="dm-model-line"><div className="row"><span>端口</span><b>{gw?.port ?? '—'}</b></div></div>
        <div className="dm-model-line"><div className="row"><span>供应商配置</span><b style={{ maxWidth: 520, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{gw?.providersFile ?? '—'}</b></div></div>
        {gw?.reason && <p className="hint">原因：{gw.reason}</p>}
        {canWrite && (
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" className="primary-btn" disabled={busy !== '' || gwRunning} onClick={() => void act('start')}>{busy === 'start' ? '启动中…' : '启动网关'}</button>
            <button type="button" className="ghost-btn" disabled={busy !== '' || !gwRunning} onClick={() => void act('stop')}>{busy === 'stop' ? '停止中…' : '停止'}</button>
            <button type="button" className="ghost-btn" disabled={busy !== '' || !gwRunning} onClick={() => void act('reload')}>{busy === 'reload' ? '重载中…' : '重载配置'}</button>
          </div>
        )}
        <p className="hint" style={{ marginTop: 8 }}>在「供应商」页新增/修改供应商后，重载即可生效。网关默认对出站请求自动脱敏。</p>
      </div>

      <div className="provider-grid">
        {providers.map((provider) => (
          <article className="dm-card" key={provider.id}>
            <div className="dm-provider-head"><strong>{provider.id}</strong><span className="dm-okpill">{provider.models.length} 模型</span></div>
            <div className="hint" style={{ marginTop: 2 }}>{provider.api}{provider.apiKeyEnv ? ' · 密钥 ' + provider.apiKeyEnv : ''}</div>
            <ul className="model-chips" style={{ marginTop: 8 }}>
              {provider.models.map((model) => <li key={model} className="chip chip-ok">{provider.id}/{model}</li>)}
            </ul>
          </article>
        ))}
        {!providers.length && <div className="empty-card"><h3>还没有供应商</h3><p>去「供应商」页 ＋添加供应商。</p></div>}
      </div>

      <div className="platform-lower">
        <div className="status-panel">
          <div className="status-panel-head"><span className="panel-dot" /><h3>受管 Host</h3><span className="state-pill state-ok">单一写者</span></div>
        </div>
        <div className="status-panel">
          <div className="status-panel-head"><span className={`panel-dot ${gwRunning ? 'online' : ''}`} /><h3>网关端口</h3><span className="state-pill state-ok">{gw?.port ?? '—'}</span></div>
        </div>
      </div>
    </section>
  );
}
