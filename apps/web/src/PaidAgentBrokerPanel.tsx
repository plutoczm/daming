import { useEffect, useState } from 'react';
import type { SessionView } from '@daming/contracts';
import { TenantAgentSafetyPanel } from './TenantAgentSafetyPanel.tsx';

type Account = { credentialId: string; provider: 'openai' | 'deepseek';
  modelId: string; label: string; expiresAt: string };
type Attempt = { requestId: string; credentialId: string; provider: string;
  modelId: string; currency: string; reservedMinor: number; status: string;
  expiresAt: string; vendorInvoiceVerified: false };
type Admission = { manualOneShotEgressEnabled: boolean;
  manualOneShotReady: boolean; blockers: string[] };
type ProductionProof = {
  generatedAt: string; productionPaidDispatchApproved: false;
  manualOneShotPreconditionsMet: boolean;
  realVendorInferencePerformedByThisCheck: false;
  items: { code: string; state: 'verified' | 'blocked' | 'unavailable';
    evidence: string; requirement: string }[];
  blockers: string[];
};
type Frozen = { requestId: string; credentialId: string;
  prompt: string; currency: 'USD' | 'CNY'; reservedMinor: number;
  maxOutputTokens: number; safeMemoryTools: boolean };
type BrokerResult = { text: string; inputTokens: number | null;
  outputTokens: number | null; attempt: Attempt; chargedMinor: null;
  toolResults?: { toolCallId: string; name: string; text: string }[];
  awaitingPaidContinuation?: boolean };

export function PaidAgentBrokerPanel({ session }: { session: SessionView }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [admission, setAdmission] = useState<Admission | null>(null);
  const [credentialId, setCredentialId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [reservedMinor, setReservedMinor] = useState(20);
  const [maxOutputTokens, setMaxOutputTokens] = useState(32);
  const [safeMemoryTools, setSafeMemoryTools] = useState(false);
  const [frozen, setFrozen] = useState<Frozen | null>(null);
  const [ack, setAck] = useState(false);
  const [result, setResult] = useState<BrokerResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [productionProof, setProductionProof] = useState<ProductionProof | null>(null);
  const [proofChecking, setProofChecking] = useState(false);
  const tenantId = session.identity?.tenantId;
  const chosen = accounts.find(row => row.credentialId === credentialId);
  const currency = chosen?.provider === 'openai' ? 'USD' as const : 'CNY' as const;

  const refresh = async () => {
    const [a, b, r] = await Promise.all([
      fetch('/api/identity/tenant-accounts'),
      fetch('/api/identity/paid-egress/attempts'),
      fetch('/api/identity/agent-runtime/readiness')
    ]);
    if (!a.ok || !b.ok || !r.ok) throw new Error('broker_read_unavailable');
    const accountBody = await a.json() as { accounts: Account[] };
    const attemptBody = await b.json() as { attempts: Attempt[] };
    const readiness = await r.json() as Admission;
    setAccounts(accountBody.accounts);
    setAttempts(attemptBody.attempts);
    setAdmission(readiness);
    setCredentialId(id => accountBody.accounts.some(x => x.credentialId === id)
      ? id : (accountBody.accounts[0]?.credentialId ?? ''));
  };
  useEffect(() => {
    setAccounts([]); setAttempts([]); setAdmission(null);
    setCredentialId(''); setPrompt(''); setFrozen(null); setResult(null);
    setAck(false); setMessage(''); setProductionProof(null);
    void refresh().catch(() => setMessage('未能读取付费代理状态'));
  }, [tenantId]);

  const verifyProductionProof = async () => {
    if (proofChecking || busy) return;
    setProofChecking(true); setProductionProof(null); setMessage('');
    try {
      const query = credentialId ? '?credentialId=' + encodeURIComponent(credentialId) : '';
      const response = await fetch(
        '/api/identity/agent-runtime/production-proof' + query,
        { credentials: 'same-origin', cache: 'no-store' }
      );
      if (!response.ok) throw new Error('production_proof_read_denied_' + response.status);
      setProductionProof(await response.json() as ProductionProof);
    } catch (error) {
      setMessage('生产证据核验未完成：' +
        (error instanceof Error ? error.message : 'unavailable'));
    } finally { setProofChecking(false); }
  };

  const post = async (path: string, body: unknown) => {
    const response = await fetch(path, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json',
        'X-Daming-CSRF': session.csrfToken },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(error.error ?? 'request_rejected');
    }
    return await response.json() as Record<string, unknown>;
  };

  const prepare = async () => {
    if (!chosen || !prompt.trim() || busy || frozen) return;
    setBusy(true); setResult(null); setMessage('');
    try {
      const intent: Frozen = {
        requestId: crypto.randomUUID(), credentialId: chosen.credentialId,
        prompt, currency, reservedMinor, maxOutputTokens, safeMemoryTools
      };
      const value = await post('/api/identity/paid-egress/prepare', {
        ...intent, confirmation: 'PREPARE_ONE_PAID_AGENT_ATTEMPT'
      });
      if (!(value.attempt as Attempt)?.requestId) throw new Error('prepare_incomplete');
      setFrozen(intent); setAck(false);
      setMessage('已预留本地软预算；没有发送任何供应商请求。若不继续，可取消预留。');
      await refresh();
    } catch (error) {
      setMessage('准备失败：' + (error instanceof Error ? error.message : 'invalid'));
    } finally { setBusy(false); }
  };

  const cancel = async (requestId: string) => {
    if (busy) return;
    setBusy(true); setMessage('');
    try {
      await post('/api/identity/paid-egress/attempts/' + requestId + '/cancel', {});
      if (frozen?.requestId === requestId) { setFrozen(null); setAck(false); }
      setMessage('尚未发送的预算预留已取消。');
      await refresh();
    } catch (error) {
      setMessage('取消失败：可能已经发送，费用未知的记录不能释放。' +
        (error instanceof Error ? error.message : ''));
    } finally { setBusy(false); }
  };

  const execute = async () => {
    if (!frozen || !ack || busy || !admission?.manualOneShotReady) return;
    setBusy(true); setResult(null);
    setMessage('准备发送；只允许一次，超时也不会自动重试。');
    const intent = frozen;
    // Never expose a "retry" button after submission. A lost HTTP response
    // does not mean the vendor did not charge.
    setFrozen(null); setAck(false);
    try {
      const answer = await post('/api/identity/paid-egress/execute', {
        ...intent, confirmation: 'SEND_ONE_PAID_MODEL_REQUEST_WITH_UNVERIFIED_CASH_CAP'
      });
      setResult(answer as BrokerResult);
      setMessage('模型返回成功；本地费用仍标为未知，必须取得可信账单后才可再次派工。');
    } catch {
      setMessage('执行失败或响应中断。可能已产生供应商费用；禁止自动重试，请检查审计记录。');
    } finally {
      await refresh().catch(() => undefined);
      setBusy(false);
    }
  };

  return (
    <section className="lulu-card" aria-label="受信付费 Agent 网络代理">
      <h3>受信网络代理 · 手动一次性付费 Agent</h3>
      <p className="hint">
        Agent 运行在断网 Docker 内，通过标准输入输出请求 Host；只有 Host 使用本租户加密账号向官方 HTTPS 发送固定的单轮文本请求。
        不接入共享 Magpie 登录态，不运行第三方插件或自动工具调用。
      </p>
      <p className="hint">
        <strong>费用警告：</strong>预留金额是本地软预算，不是供应商保证的现金硬上限。
        发送成功、失败或超时都可能计费；发送后保留未知费用，不能自动重试。
      </p>
      <button type="button" disabled={busy} onClick={() => void refresh()
        .catch(() => setMessage('网络代理状态刷新失败'))}>刷新账号、费用与准入</button>
      {admission && <p className="hint">
        手动发送开关：{admission.manualOneShotEgressEnabled ? '已显式启用' : '默认关闭'}；
        安全条件：{admission.manualOneShotReady ? '满足手动一次性准入' : '尚未满足'}。
        自动付费派工仍未开放。
      </p>}
      {!frozen && <div>
        <label>独立租户 API 账号（不显示密钥）
          <select value={credentialId} onChange={e => setCredentialId(e.target.value)}>
            {!accounts.length && <option value="">请先在用户与账号归属登记账号</option>}
            {accounts.map(account =>
              <option key={account.credentialId} value={account.credentialId}>
                {account.label} · {account.provider} · {account.modelId}
              </option>)}
          </select>
        </label>
        <label>Agent 单轮目标（最多 2048 字符）
          <textarea maxLength={2048} value={prompt}
            onChange={e => setPrompt(e.target.value)}/>
        </label>
        <label>本次预留（{currency === 'CNY' ? '人民币分' : '美元美分'}，非供应商硬上限）
          <input type="number" min={1} max={1000000} value={reservedMinor}
            onChange={e => setReservedMinor(Number(e.target.value))}/>
        </label>
        <label>最大输出 token（1–128）
          <input type="number" min={1} max={128} value={maxOutputTokens}
            onChange={e => setMaxOutputTokens(Number(e.target.value))}/>
        </label>
        <label><input type="checkbox" checked={safeMemoryTools}
          onChange={e => setSafeMemoryTools(e.target.checked)}/>
          允许本次模型请求提出只读内存工具调用（字符计数/文字查找）；下一轮付费仍暂停等待对账。
        </label>
        <button type="button" disabled={busy || !chosen || !prompt.trim() ||
          !Number.isSafeInteger(reservedMinor) || reservedMinor < 1 ||
          !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 ||
          maxOutputTokens > 128} onClick={() => void prepare()}>
          第一步：预留费用并冻结请求（不发送）
        </button>
      </div>}
      {frozen && <div>
        <p className="hint">准备号：{frozen.requestId}。账号、任务与最大输出已冻结，下一步才会尝试真实付费请求。</p>
        <label><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)}/>
          我确认可能实际扣费，且本地金额不是供应商现金硬上限。只允许发送一次。
        </label>
        <button type="button" disabled={busy || !ack || !admission?.manualOneShotReady}
          onClick={() => void execute()}>第二步：确认发送一次真实请求</button>
        <button type="button" disabled={busy} onClick={() => void cancel(frozen.requestId)}>
          不发送，取消预留
        </button>
      </div>}
      {result && <div role="status">
        <h4>Agent 输出</h4>
        <p>{result.text}</p>
        {result.toolResults && result.toolResults.length > 0 && <div>
          <h4>已审查的只读工具结果</h4>
          <ul>{result.toolResults.map(t => <li key={t.toolCallId}>
            {t.name}：{t.text}</li>)}</ul>
          {result.awaitingPaidContinuation && <p className="hint">
            已暂停下一轮付费模型请求：缺少单请求权威现金结算，禁止自动续跑。
          </p>}
        </div>}
        <p className="hint">输入 {result.inputTokens ?? '未知'} token；
          输出 {result.outputTokens ?? '未知'} token；供应商最终扣费未知，账本状态 {result.attempt.status}。</p>
      </div>}
      {message && <p className="hint" role="status">{message}</p>}
      {attempts.length > 0 && <div>
        <h4>最近尝试（仅本租户）</h4>
        <ul>{attempts.slice(0, 12).map(item => <li key={item.requestId}>
          {item.modelId} · {item.requestId.slice(0, 8)} · {item.status} · 本地预留 {item.reservedMinor} {item.currency === 'CNY' ? '分' : '美分'}
          {item.status === 'prepared' && <button type="button" disabled={busy}
            onClick={() => void cancel(item.requestId)}>取消未发送预留</button>}
        </li>)}</ul>
      </div>}
      <div aria-label="生产级证据核验">
        <h4>生产级准入证据（只读）</h4>
        <p className="hint">实际核查当前租户、MFA、Docker 隔离、部署中的 Magpie 单上游协议、官方费用观察以及历史现金未知记录。
          这是核验报告，不是开通付费自动派工的按钮。</p>
        <button type="button" disabled={busy || proofChecking}
          onClick={() => void verifyProductionProof()}>
          {proofChecking ? '正在核查生产证据…' : '生成当前生产准入证据报告（不会产生模型费用）'}
        </button>
        {productionProof && <div role="status">
          <p><strong>生产自动付费准入：未通过</strong> ·
            手动单次前提：{productionProof.manualOneShotPreconditionsMet ? '已满足（仍需确认与显式开关）' : '未满足'} ·
            记录时间：{productionProof.generatedAt}</p>
          <p className="hint">本次核验不会进行真实模型推理，也不会解冻未知现金费用。</p>
          <details>
            <summary>查看 {productionProof.items.length} 项生产证据、未通过原因（{productionProof.blockers.length} 项待证明）</summary>
            <ul>{productionProof.items.map(entry => <li key={entry.code}>
              <strong>{entry.state === 'verified' ? '已验证' :
                entry.state === 'blocked' ? '已阻断' : '无法证明'}</strong> ·
              {entry.requirement} · {entry.evidence}
            </li>)}</ul>
          </details>
        </div>}
      </div>
      <TenantAgentSafetyPanel session={session} onSelectAccount={id => {
        if (!frozen && accounts.some(account => account.credentialId === id)) {
          setCredentialId(id); setMessage('已采用 Magpie 安全路由候选；仍需手动冻结与逐笔确认。');
        }
      }}/>
    </section>
  );
}
