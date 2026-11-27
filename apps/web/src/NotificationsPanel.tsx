import { useState } from 'react';
import type { SessionView } from '@daming/contracts';
import { notifyRefresh, useAdaptiveResource } from './live-refresh.ts';

type ChannelId = 'feishu' | 'wecom' | 'wechat' | 'qq' | 'webhook';
interface ChannelView {
  id: ChannelId; enabled: boolean; configured: boolean; endpointHint: string;
  secretConfigured: boolean; events: string[];
}
interface HubView {
  channels: ChannelView[];
  remote: { publicBaseUrl: string; loginUrl: string; hasToken: boolean };
  recent: { at: string; event: string; text: string; results: Record<string, string> }[];
}

const META: Record<ChannelId, { name: string; sub: string; placeholder: string; note: string }> = {
  feishu: { name: '飞书', sub: '群机器人 Webhook', placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/…', note: '飞书群机器人可直接推送；远程处理点消息里的链接。' },
  wecom: { name: '企业微信', sub: '群机器人 Webhook', placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…', note: '企业微信群机器人，支持文本消息。' },
  wechat: { name: '微信', sub: '第三方推送 / Server酱', placeholder: 'https://sctapi.ftqq.com/…', note: '个人微信没有官方 Webhook；走 Server酱 / PushPlus 等中转。' },
  qq: { name: 'QQ', sub: 'OneBot / 第三方推送', placeholder: 'http://127.0.0.1:3000/send_private_msg', note: '通过 OneBot HTTP 或你自己的 QQ 推送网关转发。' },
  webhook: { name: '通用 Webhook', sub: '任意 HTTPS 回调', placeholder: 'https://your-endpoint.example.com/daming', note: '自定义接收器，POST { text, event }。' }
};
const EVENT_LABELS: Record<string, string> = {
  'task.created': '新任务', 'task.approval': '待审批', 'task.review': '待验收',
  'task.blocked': '阻塞', 'task.completed': '完成', 'task.failed': '失败', 'autoloop.card': 'Autoloop 待拍板'
};
const CONNECT_URL: Record<ChannelId, string> = {
  feishu: 'https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot',
  wecom: 'https://developer.work.weixin.qq.com/document/path/91770',
  wechat: 'https://sct.ftqq.com/',
  qq: 'https://onebot.dev/',
  webhook: ''
};

export function NotificationsPanel({ session }: { session: SessionView }) {
  const [hub, setHub] = useState<HubView | null>(null);
  const [draft, setDraft] = useState<Record<string, { endpoint: string; secret: string; enabled: boolean; events: string[] }>>({});
  const [baseUrl, setBaseUrl] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [setupId, setSetupId] = useState<ChannelId | null>(null);
  const [probe, setProbe] = useState('');

  // Live: `notifications` is published after a channel/remote write is persisted.
  useAdaptiveResource({
    enabled: !!session,
    identity: 'notifications:' + (session.identity?.tenantId ?? 'local'),
    scope: 'notifications',
    scopes: ['portfolio'],
    intervalMs: 60000,
    fetcher: async (signal) => {
      const response = await fetch('/api/notifications', { signal, credentials: 'same-origin' });
      if (!response.ok) throw new Error('notifications_unavailable');
      return await response.json() as HubView;
    },
    onData: (data) => {
      setHub(data);
      setBaseUrl((current) => current || data.remote.publicBaseUrl);
      setDraft((current) => Object.fromEntries(data.channels.map((channel) => [channel.id, {
        endpoint: current[channel.id]?.endpoint ?? '',
        secret: current[channel.id]?.secret ?? '',
        enabled: channel.enabled,
        events: channel.events
      }])));
    },
    onError: () => setMessage('暂时读不到通知配置')
  });

  const post = async (path: string, body: unknown) => {
    const response = await fetch('/api/notifications' + path, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-daming-csrf': session.csrfToken },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(String(data.reason ?? 'notification_action_failed'));
    return data;
  };
  const saveChannel = async (id: ChannelId) => {
    const value = draft[id];
    setBusy(id); setMessage('');
    try {
      const result = await post('/channels', {
        id, enabled: value.enabled, events: value.events,
        ...(value.endpoint.trim() ? { endpoint: value.endpoint.trim() } : {}),
        ...(value.secret.trim() ? { secret: value.secret.trim() } : {})
      }) as unknown as HubView;
      setHub(result); setMessage(META[id].name + ' 已保存');
      setDraft((current) => ({ ...current, [id]: { ...current[id], endpoint: '', secret: '' } }));
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存失败'); }
    finally { setBusy(''); }
  };
  const testChannel = async (id: ChannelId) => {
    setBusy('test:' + id); setMessage('');
    try { await post('/test', { id }); setMessage(META[id].name + ' 测试消息已发送'); }
    catch (error) { setMessage(error instanceof Error ? error.message : '测试失败，请检查 Webhook'); }
    finally { setBusy(''); }
  };
  const saveRemote = async (regenerate = false) => {
    setBusy('remote'); setMessage('');
    try {
      const result = await post('/remote', { publicBaseUrl: baseUrl, ...(regenerate ? { regenerate: true } : {}) }) as unknown as HubView;
      setHub(result); setMessage(regenerate ? '已生成新的远程访问链接' : '远程访问地址已保存');
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存失败'); }
    finally { setBusy(''); }
  };
  const probeRemote = async () => {
    if (!hub?.remote.loginUrl) { setProbe('先生成远程链接'); return; }
    setProbe('检测中…');
    try {
      await fetch(hub.remote.loginUrl, { mode: 'no-cors', signal: AbortSignal.timeout(6000) });
      setProbe('地址可达 ✓');
    } catch { setProbe('地址不可达，请检查隧道/公网地址'); }
  };
  const connectChannel = async (id: ChannelId) => {
    const value = draft[id];
    setBusy('connect:' + id); setMessage('');
    try {
      await post('/channels', {
        id, enabled: true, events: value.events,
        ...(value.endpoint.trim() ? { endpoint: value.endpoint.trim() } : {}),
        ...(value.secret.trim() ? { secret: value.secret.trim() } : {})
      });
      await post('/test', { id });
      notifyRefresh('notifications');
      setSetupId(null);
      setMessage(META[id].name + ' 已连接并发送测试消息');
    } catch (error) { setMessage(error instanceof Error ? error.message : '连接失败，请检查 Webhook'); }
    finally { setBusy(''); }
  };

  return (
    <section className="page-stack notifications-page" aria-label="通知">
      <header className="page-head">
        <div>
          <p className="eyebrow">NOTIFICATIONS / REMOTE CONTROL</p>
          <h2>通知与远程</h2>
          <p className="hint">任务与 Autoloop 的变化推到飞书 / 企业微信 / 微信 / QQ；消息里的远程链接可在手机或外网打开大铭并直接审批、验收。</p>
        </div>
      </header>

      {message && <p className="hint" role="status">{message}</p>}

      {hub && (
        <>
          <div className="remote-card">
            <div className="remote-head">
              <span className="remote-icon" aria-hidden="true">↗</span>
              <div>
                <h3>远程访问</h3>
                <p>把本机 Host 通过 Tailscale / Cloudflare Tunnel 暴露后，填入公网地址即可在千里之外接管。</p>
              </div>
              <span className={`state-pill ${hub.remote.hasToken ? 'state-ok' : 'state-idle'}`}>{hub.remote.hasToken ? '已开启' : '未开启'}</span>
            </div>
            <div className="path-row">
              <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://daming.your-tunnel.com" />
              <button type="button" className="ghost-btn" disabled={busy === 'remote'} onClick={() => void saveRemote(false)}>保存地址</button>
              <button type="button" className="primary-btn" disabled={busy === 'remote'} onClick={() => void saveRemote(true)}>生成/重置链接</button>
            </div>
            {hub.remote.loginUrl && (
              <div className="remote-link">
                <code>{hub.remote.loginUrl}</code>
                <button type="button" className="link-btn" onClick={() => void navigator.clipboard.writeText(hub.remote.loginUrl)}>复制</button>
                <button type="button" className="link-btn" onClick={() => void probeRemote()}>检测</button>
                {probe && <span className="hint">{probe}</span>}
              </div>
            )}
          </div>

          <div className="notify-grid">
            {(Object.keys(META) as ChannelId[]).map((id) => {
              const channel = hub.channels.find((item) => item.id === id);
              const value = draft[id];
              if (!channel || !value) return null;
              return (
                <article className="notify-card" key={id}>
                  <div className="notify-head">
                    <span className={`avatar avatar-${id === 'feishu' ? 'sky' : id === 'wecom' ? 'sage' : id === 'wechat' ? 'mint' : id === 'qq' ? 'lilac' : 'sand'}`}>{META[id].name.slice(0, 1)}</span>
                    <div className="notify-name"><strong>{META[id].name}</strong><span>{META[id].sub}</span></div>
                    <label className="switch">
                      <input type="checkbox" checked={value.enabled} onChange={(event) => setDraft((current) => ({ ...current, [id]: { ...current[id], enabled: event.target.checked } }))} />
                      <span />
                    </label>
                  </div>
                  <p className="notify-note">{META[id].note}</p>
                  <label className="notify-field">Webhook / 推送地址
                    <input value={value.endpoint} onChange={(event) => setDraft((current) => ({ ...current, [id]: { ...current[id], endpoint: event.target.value } }))} placeholder={channel.configured ? '已配置（留空保持）' : META[id].placeholder} />
                  </label>
                  <label className="notify-field">签名 / Secret（可选）
                    <input type="password" value={value.secret} onChange={(event) => setDraft((current) => ({ ...current, [id]: { ...current[id], secret: event.target.value } }))} placeholder={channel.secretConfigured ? '已保存（留空保持）' : '可选'} />
                  </label>
                  <div className="event-chips">
                    {Object.entries(EVENT_LABELS).map(([event, label]) => (
                      <label key={event} className={`event-chip ${value.events.includes(event) ? 'on' : ''}`}>
                        <input type="checkbox" checked={value.events.includes(event)} onChange={(e) => setDraft((current) => ({
                          ...current,
                          [id]: { ...current[id], events: e.target.checked ? [...current[id].events, event] : current[id].events.filter((x) => x !== event) }
                        }))} />{label}
                      </label>
                    ))}
                  </div>
                  <div className="notify-actions">
                    <button type="button" className="primary-btn" disabled={busy === id} onClick={() => void saveChannel(id)}>{busy === id ? '保存中…' : '保存'}</button>
                    <button type="button" className="link-btn" onClick={() => setSetupId(id)}>连接</button>
                    <button type="button" className="link-btn" disabled={busy === 'test:' + id || !channel.configured} onClick={() => void testChannel(id)}>发送测试</button>
                  </div>
                </article>
              );
            })}
          </div>

          <div className="recent-notifications">
            <div className="card-title"><h3>最近通知</h3><span className="hint">本地持久化 · 最多 20 条</span></div>
            {hub.recent.length === 0 && <p className="hint">还没有发送记录。配置通道后点「发送测试」，或等任务状态变化自动推送。</p>}
            {hub.recent.map((item, index) => (
              <div className="notify-row" key={item.at + index}>
                <span className="notify-event">{EVENT_LABELS[item.event] ?? item.event}</span>
                <span className="notify-text">{item.text}</span>
                <span className="notify-time">{new Date(item.at).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {setupId && (
        <div className="palette-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSetupId(null); }}>
          <div className="setup-dialog" role="dialog" aria-modal="true" aria-label={'连接' + META[setupId].name}>
            <div className="setup-head">
              <h3>连接{META[setupId].name}</h3>
              <button type="button" className="drawer-close" onClick={() => setSetupId(null)} aria-label="关闭">×</button>
            </div>
            <ol className="setup-steps">
              <li>打开{META[setupId].name}的官方配置页面，创建机器人或推送密钥。</li>
              <li>复制 Webhook / 推送地址（和个人接收账号）。</li>
              <li>粘贴到下面，点击「保存并测试」，收到测试消息就完成了。</li>
            </ol>
            {CONNECT_URL[setupId] && (
              <button type="button" className="ghost-btn" onClick={() => window.open(CONNECT_URL[setupId], '_blank')}>打开{META[setupId].name}官方页面 ↗</button>
            )}
            <label className="notify-field">Webhook / 推送地址
              <input autoFocus value={draft[setupId]?.endpoint ?? ''} onChange={(event) => setDraft((current) => ({ ...current, [setupId]: { ...current[setupId], endpoint: event.target.value } }))} placeholder={META[setupId].placeholder} />
            </label>
            <label className="notify-field">签名 / Secret（可选）
              <input type="password" value={draft[setupId]?.secret ?? ''} onChange={(event) => setDraft((current) => ({ ...current, [setupId]: { ...current[setupId], secret: event.target.value } }))} placeholder="可选" />
            </label>
            {message && <p className="hint" role="status">{message}</p>}
            <div className="setup-actions">
              <button type="button" className="primary-btn" disabled={busy === 'connect:' + setupId} onClick={() => void connectChannel(setupId)}>{busy === 'connect:' + setupId ? '连接中…' : '保存并测试'}</button>
              <button type="button" className="link-btn" onClick={() => setSetupId(null)}>稍后</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
