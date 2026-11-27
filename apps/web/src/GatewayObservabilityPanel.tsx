import { useEffect, useState } from 'react';
import type { GatewayContextCategory, GatewayContextCompositionView, GatewayObservabilityView, GatewayRequestView, SessionView } from '@daming/contracts';
import { notifyRefresh, useAdaptiveResource } from './live-refresh.ts';

const CAT_LABEL: Record<GatewayContextCategory, string> = {
  system: '系统提示词', tools: '工具', skills: '技能', memory: '记忆', files: '文件', tool_results: '工具结果', conversation: '会话内容', other: '其他',
};
const CAT_COLOR: Record<GatewayContextCategory, string> = {
  system: '#eef0ff', tools: '#fdf0e4', skills: '#e8f6ef', memory: '#fdeef4', files: '#e6f4fb', tool_results: '#f4ecfb', conversation: '#eef4ff', other: '#f0f0f2',
};
const FREE_KEY = '__free';

function fmtTokens(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'K';
  return String(Math.round(n));
}

type TmRect = { x: number; y: number; w: number; h: number };

/** Squarified treemap layout (Bruls et al.), normalized to a W×H box. */
function squarify(values: readonly number[], W: number, H: number): (TmRect | undefined)[] {
  const n = values.length;
  const rects: (TmRect | undefined)[] = new Array(n);
  if (!n) return rects;
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const order = values.map((v, i) => ({ i, area: Math.max((v / total) * W * H, 1e-4) }))
    .sort((a, b) => b.area - a.area);
  const worst = (areas: readonly number[], side: number, sum: number): number => {
    if (sum <= 0 || side <= 0) return Infinity;
    const thick = sum / side;
    let w = 0;
    for (const a of areas) {
      const other = a / thick;
      const ratio = Math.max(thick, other) / Math.max(1e-6, Math.min(thick, other));
      if (ratio > w) w = ratio;
    }
    return w;
  };
  let x = 0, y = 0, w = W, h = H, idx = 0;
  while (idx < order.length) {
    const short = Math.min(w, h);
    const rowAreas: number[] = [order[idx].area];
    let rowSum = order[idx].area;
    let end = idx + 1;
    while (end < order.length) {
      const cand = order[end].area;
      if (worst([...rowAreas, cand], short, rowSum + cand) <= worst(rowAreas, short, rowSum)) {
        rowAreas.push(cand); rowSum += cand; end += 1;
      } else break;
    }
    const thick = rowSum / short;
    const alongHeight = w >= h; // strip spans full height, advancing x
    let off = 0;
    for (let k = idx; k < end; k += 1) {
      const frac = order[k].area / rowSum;
      rects[order[k].i] = alongHeight
        ? { x, y: y + off, w: thick, h: h * frac }
        : { x: x + off, y, w: w * frac, h: thick };
      off += alongHeight ? h * frac : w * frac;
    }
    if (alongHeight) { x += thick; w -= thick; } else { y += thick; h -= thick; }
    idx = end;
  }
  return rects;
}

interface TmItem { key: string; label: string; category: GatewayContextCategory | 'free'; tokens: number; }

function ContextTreemap({ items, selectedKey, onSelect }: { items: TmItem[]; selectedKey: string | null; onSelect: (key: string) => void }) {
  const W = 1000, H = 450;
  const rects = squarify(items.map((it) => it.tokens), W, H);
  const total = items.reduce((s, it) => s + it.tokens, 0) || 1;
  return (
    <div className="ctx-tm">
      {items.map((it, i) => {
        const r = rects[i];
        if (!r) return null;
        const wPct = (r.w / W) * 100;
        const hPct = (r.h / H) * 100;
        const showLabel = wPct >= 13 && hPct >= 14;
        const showValue = wPct >= 18 && hPct >= 30;
        return (
          <button
            type="button"
            key={it.key}
            className={`ctx-tm-cell${it.category === 'free' ? ' free' : ''}${selectedKey === it.key ? ' is-sel' : ''}`}
            style={{
              left: (r.x / W) * 100 + '%', top: (r.y / H) * 100 + '%', width: wPct + '%', height: hPct + '%',
              ...(it.category !== 'free' ? { background: CAT_COLOR[it.category] } : {}),
            }}
            title={`${it.label} · ${fmtTokens(it.tokens)} · ${((it.tokens / total) * 100).toFixed(1)}%`}
            onClick={() => onSelect(it.key)}
          >
            {showLabel && <b>{it.label}</b>}
            {showValue && <em>{fmtTokens(it.tokens)}</em>}
          </button>
        );
      })}
    </div>
  );
}

function money(minor?: number): string { return minor === undefined ? '—' : `¥${minor.toFixed(2)}`; }

export function GatewayObservabilityPanel({ session }: { session: SessionView }) {
  const [data, setData] = useState<GatewayObservabilityView | null>(null);
  const [selected, setSelected] = useState<GatewayRequestView | null>(null);
  const [composition, setComposition] = useState<GatewayContextCompositionView | null>(null);
  const [ctxExpanded, setCtxExpanded] = useState(true);
  const [ctxSel, setCtxSel] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [maskInput, setMaskInput] = useState('');
  const [maskResult, setMaskResult] = useState<{ masked: string; count: number; findings: { placeholder: string; label: string; sample: string }[] } | null>(null);

  // Live: the Host publishes `gateway` once a request record (or usage batch) is
  // durably appended; polling keeps the page fresh while SSE is reconnecting.
  useAdaptiveResource({
    enabled: !!session,
    identity: 'gateway:' + (session.identity?.tenantId ?? 'local'),
    scope: 'gateway',
    scopes: ['platform'],
    intervalMs: 30000,
    fetcher: async (signal) => {
      const response = await fetch('/api/gateway/observability', { signal, credentials: 'same-origin' });
      if (!response.ok) throw new Error('observability_unavailable');
      return await response.json() as GatewayObservabilityView;
    },
    onData: (value) => { setData(value); setError(''); setBusy(false); },
    onError: (cause) => { setError(cause instanceof Error ? cause.message : '读取失败'); setBusy(false); }
  });

  const openContext = async (row: GatewayRequestView) => {
    setSelected(row); setComposition(null); setCtxSel(null);
    try {
      const response = await fetch('/api/gateway/context?requestId=' + encodeURIComponent(row.requestId), { credentials: 'same-origin' });
      if (response.ok) setComposition(await response.json() as GatewayContextCompositionView);
    } catch { /* ignore */ }
  };

  const previewMask = async () => {    if (!maskInput.trim()) { setMaskResult(null); return; }
    try {
      const response = await fetch('/api/platform/mask/preview', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-daming-csrf': session.csrfToken },
        body: JSON.stringify({ text: maskInput })
      });
      if (response.ok) setMaskResult(await response.json() as { masked: string; count: number; findings: { placeholder: string; label: string; sample: string }[] });
    } catch { /* ignore */ }
  };

  const summary = data?.summary;
  useEffect(() => {
    if (selected) return;
    const first = data?.requests.find((row) => (row.contextParts?.length ?? 0) > 0) ?? data?.requests[0];
    if (first) void openContext(first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  const kpis = [
    { label: '请求', value: summary?.requests ?? 0 },
    { label: '错误', value: summary?.errors ?? 0 },
    { label: '平均耗时', value: (summary?.avgLatencyMs ?? 0) + 'ms' },
    { label: '缓存命中', value: (summary?.cacheHitPercentAvg ?? 0) + '%' },
    { label: '总成本', value: money(summary?.totalCostMinor) },
    { label: '脱敏处', value: summary?.maskedTotal ?? 0 }
  ];

  return (
    <section className="page-stack" id="gateway" data-reveal>
      <header className="page-head">
        <div>
          <p className="eyebrow">GATEWAY / OBSERVABILITY</p>
          <h2>网关观测</h2>
          <p className="hint">逐请求明细 · 上下文窗口构成 · 脱敏汇总（用户效果优先）。</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {selected && <button type="button" className="ghost-btn" onClick={() => { setSelected(null); setComposition(null); }}>清除选择</button>}
          <button type="button" className="ghost-btn" onClick={() => notifyRefresh('gateway')} disabled={busy}>{busy ? '刷新中…' : '刷新'}</button>
        </div>
      </header>
      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="kpi-grid">
        {kpis.map((kpi) => (
          <div className={`kpi${kpi.label === '脱敏处' ? ' accent' : ''}`} key={kpi.label}><span className="label">{kpi.label}</span><div className="value">{kpi.value}</div></div>
        ))}
      </div>

      <div className="overview-cols">
        <div className="status-card" style={{ padding: 14 }}>
          <div className="card-title"><h3>请求明细 <span className="count">{data?.requests.length ?? 0}</span></h3><span className="hint">点一条看上下文构成</span></div>
          {(data?.requests ?? []).map((row) => (
            <div className={`dm-req${selected?.requestId === row.requestId ? ' is-active' : ''}`} key={row.requestId} role="button" tabIndex={0}
              onClick={() => void openContext(row)} onKeyDown={(event) => { if (event.key === 'Enter') void openContext(row); }}>
              <span className="dm-dot" style={{ background: row.status === 'ok' ? 'var(--ok)' : 'var(--bad)' }} title={row.status === 'ok' ? '成功' : '失败'} />
              <span className="dm-req-time">{new Date(row.at).toLocaleTimeString()}</span>
              <div className="dm-req-main">
                <div className="dm-req-title">{row.agent}<span className="dm-mono">{row.modelId.startsWith(row.providerId + '/') ? row.modelId : row.providerId + '/' + row.modelId}</span></div>
                <div className="dm-req-metrics">
                  <span className="dm-m">{row.latencyMs}ms</span>
                  {row.firstTokenMs !== undefined && <span className="dm-m">首字 {row.firstTokenMs}ms</span>}
                  <span className="dm-m">in {row.inputTokens} / out {row.outputTokens}</span>
                  {row.cacheHitPercent !== undefined && <span className="dm-m good">缓存 {row.cacheHitPercent}%</span>}
                  {row.costMinor !== undefined && <span className="dm-m">{money(row.costMinor)}</span>}
                  <span className={`dm-m${row.maskedCount ? ' good' : ''}`}>脱敏 {row.maskedCount}</span>
                  {row.status === 'error' && <span className="dm-m bad">失败{row.error ? ' · ' + row.error : ''}</span>}
                </div>
              </div>
              <span className="dm-mono" style={{ color: 'var(--muted)', fontSize: 10.5 }}>{row.requestId.slice(0, 10)}</span>
            </div>
          ))}
          {!(data?.requests.length) && <div className="empty-card"><h3>暂无请求记录</h3><p>网关每次请求后写入一条，这里就会显示明细。</p></div>}
        </div>

        <div className="status-card" style={{ padding: 14 }}>
          <div className="card-title">
            <h3>上下文窗口构成</h3>
            <span className="hint">{selected ? selected.modelId : '未选择'}</span>
            {composition && (
              <button type="button" className="ghost-btn ctx-toggle" onClick={() => setCtxExpanded((v) => !v)}>
                {ctxExpanded ? '收缩' : '展开'}
              </button>
            )}
          </div>
          {composition ? (() => {
            const used = composition.usedTokens;
            const limit = composition.limitTokens;
            const freeTokens = limit ? Math.max(0, limit - used) : 0;
            const items: TmItem[] = composition.parts.map((part) => ({ key: part.category + ':' + part.label, label: part.label, category: part.category, tokens: part.tokens }));
            if (freeTokens > 0) items.push({ key: FREE_KEY, label: '剩余空间', category: 'free', tokens: freeTokens });
            if (!items.length) items.push({ key: FREE_KEY + ':used', label: '已用（未分类）', category: 'free', tokens: used || 1 });
            const total = items.reduce((s, it) => s + it.tokens, 0) || 1;
            const sel = items.find((it) => it.key === ctxSel) ?? null;
            const categories = [...new Set(composition.parts.map((p) => p.category))];
            return (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                  <span>已用 <b className="dm-mono">{fmtTokens(used)}</b> / {limit ? fmtTokens(limit) : '—'} token</span>
                  <span className="hint">剩余 {composition.remainingPercent ?? '—'}%</span>
                </div>
                <div className="dm-bar"><span style={{ width: Math.max(2, Math.min(100, composition.remainingPercent ?? 0)) + '%', background: 'linear-gradient(90deg,#22c55e,#16a34a)' }} /></div>
                {composition.cacheHitPercent !== null && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>提示词缓存命中</span><b className="dm-mono">{composition.cacheHitPercent}%</b></div>
                    <div className="dm-bar"><span style={{ width: Math.max(2, Math.min(100, composition.cacheHitPercent)) + '%' }} /></div>
                  </div>
                )}
                {!ctxExpanded && composition.parts.length > 0 && (
                  <div className="dm-segbar" aria-hidden="true">
                    {composition.parts.map((part) => (
                      <span key={part.label} style={{ width: part.percent + '%', background: CAT_COLOR[part.category] }} />
                    ))}
                  </div>
                )}
                {ctxExpanded && (
                  <>
                    <ContextTreemap items={items} selectedKey={ctxSel} onSelect={(key) => setCtxSel((cur) => (cur === key ? null : key))} />
                    {sel && (
                      <div className="ctx-sel">
                        <i style={{ background: sel.category === 'free' ? 'var(--line)' : CAT_COLOR[sel.category] }} />
                        <b>{sel.label}</b>
                        <span className="hint">{sel.category === 'free' ? '剩余/未分类' : (CAT_LABEL[sel.category] ?? sel.category)} · {fmtTokens(sel.tokens)} · 占 {((sel.tokens / total) * 100).toFixed(1)}%</span>
                      </div>
                    )}
                    <div className="ctx-detail">
                      {[...items].sort((a, b) => b.tokens - a.tokens).map((it) => (
                        <button type="button" key={it.key} className={`ctx-detail-row${ctxSel === it.key ? ' is-sel' : ''}`} onClick={() => setCtxSel((cur) => (cur === it.key ? null : it.key))}>
                          <i style={{ background: it.category === 'free' ? 'var(--line)' : CAT_COLOR[it.category] }} />
                          <span className="ctx-detail-label">{it.label}</span>
                          <span className="ctx-detail-cat">{it.category === 'free' ? '剩余' : (CAT_LABEL[it.category] ?? it.category)}</span>
                          <span className="ctx-detail-bar"><span style={{ width: Math.max(2, (it.tokens / total) * 100) + '%', background: it.category === 'free' ? 'var(--muted-2)' : 'var(--brand)' }} /></span>
                          <span className="ctx-detail-tok dm-mono">{fmtTokens(it.tokens)}</span>
                        </button>
                      ))}
                    </div>
                    {categories.length > 0 && (
                      <div className="dm-legend">
                        {categories.map((category) => (
                          <span key={category}><i style={{ background: CAT_COLOR[category] }} />{CAT_LABEL[category] ?? category}</span>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })() : (<p className="hint">点左侧一条请求，查看它的上下文构成（系统 / 工具 / 文件 / 会话…）。</p>)}
        </div>
      </div>
    </section>
  );
}
