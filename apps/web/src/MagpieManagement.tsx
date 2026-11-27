import { useState } from 'react';
import type { MagpieReadView } from '@daming/contracts';

interface Props {
  readonly snapshot: Record<string, MagpieReadView> | null;
  readonly canWrite: boolean;
  readonly busy: string;
  readonly onAction: (action: string, body?: Record<string, unknown>) => Promise<void>;
}

const STATUS = { ready: '可用', disabled: '已停用', needs_setup: '待配置', error: '读取异常' } as const;
type Tab = 'accounts' | 'quotas' | 'plugins';

export function MagpieManagement({ snapshot, canWrite, busy, onAction }: Props) {
  const [tab, setTab] = useState<Tab>('accounts');
  const [spec, setSpec] = useState('');
  const providers = snapshot?.providers?.items ?? [];
  const quotas = snapshot?.quotas?.items ?? [];
  const plugins = snapshot?.plugins?.items ?? [];
  const pending = busy !== '';
  return (
    <div className="magpie-manager">
      <div className="magpie-summary">
        {([
          ['models', '模型'], ['providers', '供应商'], ['quotas', '额度卡'], ['plugins', '插件']
        ] as const).map(([key, label]) => (
          <div className="magpie-number" key={key}>
            <span>{label}</span>
            <strong>{snapshot?.[key]?.count ?? '—'}</strong>
          </div>
        ))}
      </div>
      <div className="magpie-tabs" role="tablist" aria-label="网关管理">
        {([
          ['accounts', '账号与供应商'], ['quotas', '额度'], ['plugins', '插件']
        ] as const).map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key}
            className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>
      {tab === 'accounts' && <section className="magpie-panel" role="tabpanel">
        <p className="magpie-explainer">仅显示供应商及账号数量。登录身份、API Key 和密钥不会发送到网页。登录/添加账号须使用平台的本机授权流程。</p>
        {providers.map((item, index) => (
          <div className="magpie-record" key={item.id ?? index}>
            <div className="magpie-record-head"><strong>{item.name}</strong><span>{item.status ? STATUS[item.status] : '未知'}</span></div>
            {item.detail && <p>{item.detail}</p>}
          </div>
        ))}
        {!providers.length && <p className="magpie-empty">{snapshot?.providers ? '暂无已登记供应商' : '供应商状态尚未加载'}</p>}
      </section>}
      {tab === 'quotas' && <section className="magpie-panel" role="tabpanel">
        <p className="magpie-explainer">展示供应商提供的额度快照，可能有延迟；这不是大铭的现金预算结算依据。</p>
        {quotas.map((item, index) => (
          <div className="magpie-record" key={(item.id ?? index) + '-' + index}>
            <div className="magpie-record-head"><strong>{item.name}</strong><span>{item.kind ?? '额度'}</span></div>
            <p>{item.detail}{item.status === 'error' ? ' · 读取异常' : ''}</p>
            {item.remainingPercent !== undefined && (
              <div className="magpie-quota-progress" aria-label={'剩余额度 ' + item.remainingPercent + '%'}>
                <span style={{ width: item.remainingPercent + '%' }} />
              </div>
            )}
            {item.remainingPercent !== undefined && <p>剩余 {item.remainingPercent}%</p>}
            {item.resetsAt && <p>重置时间：{new Date(item.resetsAt).toLocaleString()}</p>}
          </div>
        ))}
        {!quotas.length && <p className="magpie-empty">{snapshot?.quotas ? '暂无已记录额度' : '额度数据尚未加载'}</p>}
        {canWrite && <button type="button" className="magpie-primary" disabled={pending} onClick={() => void onAction('refresh-quotas')}>
          {busy === 'refresh-quotas' ? '正在刷新…' : '从供应商刷新额度'}
        </button>}
      </section>}
      {tab === 'plugins' && <section className="magpie-panel" role="tabpanel">
        <p className="magpie-explainer">安装、更新或启停第三方插件会改变本机代码与配置。执行前需浏览器确认和 Windows 本机弹窗批准；不支持静默自动安装。</p>
        {plugins.map((item, index) => (
          <div className="magpie-record" key={(item.installedSpec ?? item.name) + '-' + index}>
            <div className="magpie-record-head"><strong>{item.name}</strong><span>{item.status ? STATUS[item.status] : '未知'}</span></div>
            <p>{item.version ? '当前 ' + item.version : '版本未知'}{item.latest ? ' · 最新 ' + item.latest : ''}</p>
            {canWrite && item.installedSpec && (
              <button type="button" className="magpie-secondary" disabled={pending}
                onClick={() => void onAction('plugin-toggle', { spec: item.installedSpec, off: item.status !== 'disabled' })}>
                {item.status === 'disabled' ? '启用插件' : '停用插件'}
              </button>
            )}
          </div>
        ))}
        {!plugins.length && <p className="magpie-empty">{snapshot?.plugins ? '未安装第三方插件' : '插件数据尚未加载'}</p>}
        {canWrite && <>
          <label className="magpie-input-label" htmlFor="magpie-plugin-spec">安装 npm 插件（包名）</label>
          <div className="magpie-install">
            <input id="magpie-plugin-spec" type="text" value={spec} maxLength={130}
              placeholder="@scope/package" onChange={(event) => setSpec(event.target.value.trim())} disabled={pending}/>
            <button type="button" disabled={pending || !spec} onClick={() => void onAction('plugin-add', { spec })}>安装</button>
          </div>
          <div className="magpie-action-row">
            <button type="button" disabled={pending} onClick={() => void onAction('plugin-check')}>检查更新</button>
            <button type="button" disabled={pending || plugins.length === 0} onClick={() => void onAction('plugin-update')}>更新已安装插件</button>
          </div>
        </>}
      </section>}
      {canWrite && tab === 'accounts' && <button type="button" className="magpie-secondary" disabled={pending}
        onClick={() => void onAction('workbuddy-checkin')}>手动执行 WorkBuddy 已登录账号签到</button>}
      <p className="magpie-footnote">管理操作经过同源会话、CSRF、一次性授权与持久化回执；高风险动作还需 Windows 本机弹窗同意（不等同于 Windows Hello）。</p>
    </div>
  );
}
