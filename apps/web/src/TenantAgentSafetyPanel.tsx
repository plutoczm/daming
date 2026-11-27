import { useEffect, useState } from 'react';
import type { SessionView } from '@daming/contracts';

type RouteCandidate = {
  targetId: string; kind: string; eligibility: string;
  credentialId: string | null; autoPaidDispatchPermitted: false;
};
type RoutePlan = {
  selected: RouteCandidate | null; candidates: RouteCandidate[];
  paidDispatchPermitted: false; nativeMagpieFallbackDisabled: true;
};
type InvoiceEvidence = {
  observationId: string; utcDay: string; costMicroUsd: number;
  provider: string; singleRequestSettled: false; cashHoldReleased: false;
};
type CostRow = { observationId: string; utcDay: string;
  totalMicroUsd: number; keyHint: string; projectHint: string };
type Issued = { credentialId: string | null; projectHint: string;
  status: string; expiresAt: string | null };
type LimitRecord = { observationId: string; observedAt: string; projectHint: string;
  project: { enforcementStatus: string; thresholdMinor: number };
  organization: { enforcementStatus: string; thresholdMinor: number } };
type LimitProof = { providerMonthlyEnforcementVerified: boolean;
  effectiveMonthlyThresholdMinor: number | null; limitMayOvershoot: true;
  exactPerRequestCashCapVerified: false };

export function TenantAgentSafetyPanel({ session, onSelectAccount }: {
  session: SessionView; onSelectAccount?: (credentialId: string) => void
}) {
  const [route, setRoute] = useState<RoutePlan | null>(null);
  const [capabilities, setCapabilities] = useState<Record<string, unknown> | null>(null);
  const [issuances, setIssuances] = useState<Issued[]>([]);
  const [credentialId, setCredentialId] = useState('');
  const [adminKey, setAdminKey] = useState('');
  const [costs, setCosts] = useState<CostRow[]>([]);
  const [latest, setLatest] = useState<InvoiceEvidence | null>(null);
  const [limits, setLimits] = useState<LimitRecord[]>([]);
  const [limitProof, setLimitProof] = useState<LimitProof | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const tenantId = session.identity?.tenantId;

  const read = async () => {
    const [a,b,c,d] = await Promise.all([
      fetch('/api/identity/agent-runtime/governed-capabilities'),
      fetch('/api/identity/billing/issued-key-daily-costs'),
      fetch('/api/identity/openai/issuances'),
      fetch('/api/identity/billing/official-spend-limits')
    ]);
    if (!a.ok || !b.ok || !c.ok || !d.ok) throw new Error('verification_read_denied');
    setCapabilities(await a.json() as Record<string, unknown>);
    setCosts(((await b.json()) as { observations: CostRow[] }).observations);
    setLimits(((await d.json()) as { observations: LimitRecord[] }).observations);
    const received = ((await c.json()) as { issuances: Issued[] }).issuances
      .filter(entry => entry.status === 'issued' && entry.credentialId);
    setIssuances(received);
    setCredentialId(id => received.some(x => x.credentialId === id)
      ? id : (received[0]?.credentialId ?? ''));
  };
  useEffect(() => {
    setRoute(null); setCapabilities(null); setCosts([]); setIssuances([]);
    setCredentialId(''); setAdminKey(''); setLatest(null); setLimitProof(null);
    setLimits([]); setError('');
    void read().catch(() => setError('Agent 与账单审核状态读取失败'));
  }, [tenantId]);

  const post = async (path: string, body: unknown) => {
    const response = await fetch(path, { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json',
        'X-Daming-CSRF': session.csrfToken }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error('请求被安全闸门拒绝（HTTP ' + response.status + '）');
    return await response.json() as Record<string, unknown>;
  };
  const plan = async () => {
    setBusy(true); setError('');
    try {
      setRoute(await post('/api/identity/agent-runtime/governed-route-plan',
        { preferredTargets: [] }) as unknown as RoutePlan);
    } catch (e) { setError(e instanceof Error ? e.message : 'Magpie 目录不可用'); }
    finally { setBusy(false); }
  };
  const verifyCost = async () => {
    if (!credentialId || adminKey.length < 12 || busy) return;
    setBusy(true); setError(''); setLatest(null);
    const ephemeral = adminKey;
    setAdminKey(''); // Never retain the Admin credential after submission.
    try {
      const result = await post('/api/identity/billing/issued-key-daily-costs', {
        credentialId, adminKey: ephemeral,
        confirmation: 'READ_OFFICIAL_KEY_SCOPED_COSTS'
      });
      setLatest(result as unknown as InvoiceEvidence);
      await read();
    } catch (e) { setError(e instanceof Error ? e.message : '官方费用核验失败'); }
    finally { setBusy(false); }
  };

  const verifyLimit = async () => {
    if (!credentialId || adminKey.length < 12 || busy) return;
    setBusy(true); setError(''); setLimitProof(null);
    const ephemeral = adminKey;
    setAdminKey('');
    try {
      const result = await post('/api/identity/billing/official-spend-limits', {
        credentialId, adminKey: ephemeral,
        confirmation: 'READ_OFFICIAL_MONTHLY_LIMITS'
      });
      setLimitProof(result as unknown as LimitProof);
      await read();
    } catch (e) { setError(e instanceof Error ? e.message : '官方月度限制核验失败'); }
    finally { setBusy(false); }
  };

  return <section className="lulu-card" aria-label="Magpie Agent 与供应商账单安全准入">
    <h3>Magpie 自动路由与官方费用证据</h3>
    <p className="hint">这里区分 Magpie 订阅 Agent、路由组、独立 API 模型。
      只有单一且已在本租户验证的 API 账号会被列为候选；所有订阅和动态组仍不允许绕过 Host 的派工与账本。</p>
    <button type="button" onClick={() => void read()
      .catch(() => setError('刷新失败'))} disabled={busy}>刷新安全能力与官方费用记录</button>
    <p className="hint">生产多轮付费自动派工：未开放；单轮模型可以请求安全纯内存工具，但费用未知时暂停下一轮。</p>
    {session.identity?.rootAdministrator && <div>
      <button type="button" onClick={() => void plan()} disabled={busy}>
        使用 Magpie 当前目录生成自动路由预览（不发送）
      </button>
      {route && <div role="status">
        <p>唯一可绑定候选：{route.selected?.targetId ?? '无'}。仅供规划，不产生费用。</p>
        {route.selected?.credentialId && onSelectAccount && <button type="button"
          onClick={() => onSelectAccount(route.selected!.credentialId!)}>
          将已验证的路由账号填入手动请求（不执行）
        </button>}
        <ul>{route.candidates.map(candidate => <li key={candidate.targetId}>
          {candidate.targetId} · {candidate.kind} · {candidate.eligibility}
        </li>)}</ul>
      </div>}
    </div>}
    <h4>OpenAI 官方 Admin API 项目＋服务 Key 费用核对</h4>
    <p className="hint">核验前一完整 UTC 日的项目及 API Key 费用总额。
      官方聚合费用并不是逐请求发票，不能自动解除费用未知冻结。组织/项目月度硬限制生效可能延迟，不能保证不超额。</p>
    <label>已由本租户官方签发的 OpenAI Service Key
      <select value={credentialId} onChange={e => setCredentialId(e.target.value)}>
        {!issuances.length && <option value="">暂无已签发服务 Key</option>}
        {issuances.map(issue => <option key={issue.credentialId!} value={issue.credentialId!}>
          {issue.projectHint} · {issue.credentialId!.slice(0,8)}
        </option>)}
      </select>
    </label>
    <label>临时 OpenAI Admin Key（不落地保存）
      <input type="password" autoComplete="off" value={adminKey}
        onChange={e => setAdminKey(e.target.value)}/>
    </label>
    <button type="button" disabled={busy || !credentialId || adminKey.length < 12}
      onClick={() => void verifyCost()}>读取并登记官方完整日费用（不解冻）</button>
    <button type="button" disabled={busy || !credentialId || adminKey.length < 12}
      onClick={() => void verifyLimit()}>只读核验项目＋组织月度硬限额</button>
    {limitProof && <p className="hint" role="status">
      官方月度硬限额：{limitProof.providerMonthlyEnforcementVerified ? '至少一个处于 enforcing' : '均未生效'}；
      生效范围最小阈值：{limitProof.effectiveMonthlyThresholdMinor == null
        ? '无' : (limitProof.effectiveMonthlyThresholdMinor / 100).toFixed(2) + ' USD'}。
      官方明确允许生效延迟及少量超额；它不是精确单次现金上限，也不会解除现金未知冻结。
    </p>}
    {limits.length > 0 && <div>
      <h4>最近官方月度限额状态</h4>
      <ul>{limits.slice(0,5).map(item => <li key={item.observationId}>
        {item.projectHint} · {item.observedAt} · 项目 {item.project.enforcementStatus}
        （{(item.project.thresholdMinor / 100).toFixed(2)} USD） · 组织 {item.organization.enforcementStatus}
        （{(item.organization.thresholdMinor / 100).toFixed(2)} USD）
      </li>)}</ul>
    </div>}
    {latest && <p className="hint" role="status">
      已记录 {latest.utcDay} 的官方费用聚合：{(latest.costMicroUsd / 1000000).toFixed(6)} USD；
      单请求发票验证：否；费用预留释放：否。
    </p>}
    {costs.length > 0 && <ul>{costs.slice(0,10).map(cost =>
      <li key={cost.observationId}>{cost.utcDay} · {cost.projectHint} ·
        {cost.keyHint} · {(cost.totalMicroUsd / 1000000).toFixed(6)} USD（聚合，未结算）</li>)}</ul>}
    {capabilities && <p className="hint">
      订阅 Agent 经受信出口运行：{capabilities.magpieSubscriptionExecutionThroughTrustedEgress ? '可用' : '尚未验证'}；
      供应商精确单请求现金硬上限：{capabilities.exactVendorCashHardCapGuaranteed ? '已验证' : '未获得保证'}。
    </p>}
    {error && <p role="alert" className="hint">{error}</p>}
  </section>;
}
