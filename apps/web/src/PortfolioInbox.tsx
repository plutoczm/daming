import type { EscalationItemView, PortfolioDigestView } from '@daming/contracts';

const KIND_LABEL: Record<EscalationItemView['kind'], string> = {
  contract: '契约', acceptance: '验收', budget: '预算', irreversible: '不可逆', anomaly: '异常',
};
const BUCKET_LABEL: Record<EscalationItemView['bucket'], string> = {
  needs_you: '需拍板', at_risk: '风险', awaiting_acceptance: '待验收', healthy: '健康',
};
const DEFAULT_LABEL: Record<EscalationItemView['defaultAction'], string> = {
  hold: '保持现状', pause: '暂停', advance: '推进', reject: '驳回',
};

function ItemRow({ item, canWrite, onDecide }: {
  item: EscalationItemView;
  canWrite: boolean;
  onDecide: (itemId: string, action: 'approve' | 'reject' | 'defer') => void;
}) {
  return (
    <div className="inbox-row" style={{ alignItems: 'flex-start', display: 'grid', gap: 4 }}>
      <span className={`status-pill status-${item.severity === 'high' ? 'blocked' : 'reviewing'}`}>
        {KIND_LABEL[item.kind]} · {BUCKET_LABEL[item.bucket]}
      </span>
      <span className="inbox-row-title">{item.projectName}：{item.summary}</span>
      <span className="inbox-row-goal">
        推荐：{item.recommendation}　影响：{item.impact}　超时默认：{DEFAULT_LABEL[item.defaultAction]}
      </span>
      {canWrite && (
        <span style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="link-btn" onClick={() => onDecide(item.itemId, 'approve')}>批准 / 结案</button>
          <button type="button" className="link-btn" onClick={() => onDecide(item.itemId, 'reject')}>驳回</button>
          <button type="button" className="link-btn" onClick={() => onDecide(item.itemId, 'defer')}>稍后</button>
        </span>
      )}
    </div>
  );
}

export function PortfolioInbox({ digest, canWrite, onDecide }: {
  digest: PortfolioDigestView | null;
  canWrite: boolean;
  onDecide: (itemId: string, action: 'approve' | 'reject' | 'defer') => void;
}) {
  if (!digest) {
    return (
      <section className="page-stack" id="portfolio">
        <header className="page-head"><div>
          <p className="eyebrow">PORTFOLIO / 少管</p><h2>组合收件箱</h2>
          <p className="hint">加载中…（一个用户可持多个项目，这里只放需要你拍板的事）</p>
        </div></header>
      </section>
    );
  }
  const totals = digest.totals;
  const kpis = [
    { label: '项目', value: totals.projects }, { label: '需拍板', value: totals.needsYou },
    { label: '风险', value: totals.atRisk }, { label: '待验收', value: totals.awaitingAcceptance },
    { label: '健康', value: totals.healthy },
  ];
  return (
    <section className="page-stack" id="portfolio" data-reveal>
      <header className="page-head"><div>
        <p className="eyebrow">PORTFOLIO / 少管</p>
        <h2>组合收件箱</h2>
        <p className="hint">一屏管所有项目：只把「需你拍板 / 风险 / 待验收」放这里，其余系统自治并留痕。{digest.dayKey}</p>
      </div></header>
      <div className="kpi-grid">
        {kpis.map((kpi) => (
          <div className="kpi" key={kpi.label}>
            <span className="label">{kpi.label}</span>
            <div className="value">{kpi.value}</div>
          </div>
        ))}
      </div>
      <div className="overview-cols">
        <div className="inbox-card">
          <div className="card-title"><h3>生命线 · 实时 <span className="count">{digest.realtime.length}</span></h3></div>
          <div className="inbox-full">
            {digest.realtime.map((item) => <ItemRow item={item} key={item.itemId} canWrite={canWrite} onDecide={onDecide} />)}
            {!digest.realtime.length && (
              <div className="empty-card"><h3>没有生命线事件</h3><p>没有阻塞 / 不可逆 / 超预算的待拍板项。</p></div>
            )}
          </div>
        </div>
        <div className="inbox-card">
          <div className="card-title"><h3>晨间 digest <span className="count">{digest.digest.length}</span></h3></div>
          <div className="inbox-full">
            {digest.digest.map((item) => <ItemRow item={item} key={item.itemId} canWrite={canWrite} onDecide={onDecide} />)}
            {!digest.digest.length && (
              <div className="empty-card"><h3>digest 为空</h3><p>没有需要汇总给你的事项。</p></div>
            )}
          </div>
        </div>
      </div>
      {(digest.autoHandled.length > 0 || digest.notes.length > 0) && (
        <div className="status-card">
          <div className="card-title"><h3>系统替你做了</h3><span className="hint">审计可回看</span></div>
          <div className="status-rows">
            {digest.autoHandled.map((line, index) => (
              <div className="status-row" key={'auto-' + index}><span>{line}</span></div>
            ))}
            {digest.notes.map((line, index) => (
              <div className="status-row" key={'note-' + index}><span className="hint">{line}</span></div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
