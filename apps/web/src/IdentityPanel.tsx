import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { BudgetPanel } from './BudgetPanel.tsx';
import type { MagpieRouteCatalogView, SessionView } from '@daming/contracts';

type Tenant = { tenantId: string; name: string; role: string };
type Account = { credentialId: string; providerKind: string; providerId: string; label: string;
  verifiedAt: string; expiresAt: string; vendorBillingOwnerVerified: false; productionDispatchEnabled: false };
type Member = { userId: string; username: string; role: string };
type PublicStatus = { initialized: boolean };
type Readiness = { paidModelDispatchPermitted: false; validKeyControlProofs: number;
  mfaEnabled: boolean; blockers: string[] };
type IndependentAccount = { credentialId: string; provider: 'openai' | 'deepseek';
  modelId: string; label: string; verifiedAt: string; expiresAt: string;
  magpieBindingVerified: false; vendorBillingOwnerVerified: false;
  productionDispatchEnabled: false };
type BillingObservation = { observationId: string; credentialId: string; provider: string;
  source: string; scopeHint: string; observedAt: string; periodStart: string | null;
  periodEnd: string | null; amounts: { currency: string; minor: number }[];
  billingOwnerVerified: false; vendorInvoiceVerified: false;
  modelKeyProjectLinkVerified: false; perRequestCashCapGuaranteed: false;
  productionDispatchEnabled: false };

async function identityRequest<T>(path: string, method = 'GET', payload?: unknown, csrf?: string): Promise<T> {
  const response = await fetch('/api/identity/' + path, {
    method,
    credentials: 'same-origin',
    headers: method === 'GET' ? {} : {
      'content-type': 'application/json',
      ...(csrf ? { 'x-daming-csrf': csrf } : {})
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(payload ?? {}) })
  });
  const result = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(result.reason ?? 'HTTP ' + response.status));
  return result as T;
}

export function IdentityPanel({ session, onAuthenticated }: {
  session: SessionView | null;
  onAuthenticated: (session: SessionView | null) => void;
}) {
  const [initialized, setInitialized] = useState<boolean | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [mfaEnrollment, setMfaEnrollment] = useState<{ secret: string; enrollmentUri: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [tenantName, setTenantName] = useState('我的工作空间');
  const [invitationCode, setInvitationCode] = useState('');
  const [enrolling, setEnrolling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [independentAccounts, setIndependentAccounts] = useState<IndependentAccount[]>([]);
  const [independentProvider, setIndependentProvider] = useState<'openai' | 'deepseek'>('deepseek');
  const [independentModel, setIndependentModel] = useState('deepseek-chat');
  const [independentLabel, setIndependentLabel] = useState('我的独立 API Key');
  const [independentKey, setIndependentKey] = useState('');
  const [independentReverify, setIndependentReverify] = useState('');
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [billingObservations, setBillingObservations] = useState<BillingObservation[]>([]);
  const [billingCredentialId, setBillingCredentialId] = useState('');
  const [billingModelKey, setBillingModelKey] = useState('');
  const [billingAdminKey, setBillingAdminKey] = useState('');
  const [billingProjectId, setBillingProjectId] = useState('');
  const [candidates, setCandidates] = useState<MagpieRouteCatalogView['candidates']>([]);
  const [selectedCandidate, setSelectedCandidate] = useState('');
  const [providerKind, setProviderKind] = useState<'openai' | 'deepseek'>('openai');
  const [accountLabel, setAccountLabel] = useState('我的 API Key');
  const [apiKey, setApiKey] = useState('');
  const [inviteRole, setInviteRole] = useState<'operator' | 'viewer'>('operator');
  const [newTenant, setNewTenant] = useState('');
  const [newInvitation, setNewInvitation] = useState('');
  const [verifyId, setVerifyId] = useState('');
  const identity = session?.identity;
  const canManage = identity?.memberRole === 'owner';
  const selectedBillingAccount = accounts.find(item => item.credentialId === billingCredentialId);

  const reload = async () => {
    if (!identity) return;
    const result = await Promise.all([
      identityRequest<{ tenants: Tenant[] }>('tenants'),
      identityRequest<{ accounts: Account[] }>('accounts'),
      identityRequest<{ members: Member[] }>('members'),
      identityRequest<Readiness>('readiness'),
      identityRequest<{ observations: BillingObservation[] }>('billing/observations'),
      identityRequest<{ accounts: IndependentAccount[] }>('tenant-accounts')
    ]);
    setTenants(result[0].tenants);
    setAccounts(result[1].accounts);
    setMembers(result[2].members);
    setReadiness(result[3]);
    setBillingObservations(result[4].observations);
    setIndependentAccounts(result[5].accounts);
    if (identity.memberRole === 'owner') {
      const catalog = await identityRequest<MagpieRouteCatalogView>('candidates').catch(() => null);
      setCandidates(catalog?.candidates ?? []);
    } else setCandidates([]);
  };
  useEffect(() => {
    let active = true;
    void identityRequest<PublicStatus>('status').then(data => {
      if (active) setInitialized(data.initialized);
    }).catch(() => { if (active) setInitialized(null); });
    return () => { active = false; };
  }, [session?.identity?.userId]);
  useEffect(() => { void reload().catch(() => undefined); }, [session?.identity?.tenantId, session?.mfaEnabled]);

  const act = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try { await fn(); } catch (err) {
      setMessage(err instanceof Error ? err.message : '操作失败');
    } finally { setBusy(false); }
  };
  const authenticate = (event: FormEvent) => {
    event.preventDefault();
    void act(async () => {
      const endpoint = !initialized ? 'setup' : enrolling ? 'enroll' : 'login';
      const data = await identityRequest<SessionView>(endpoint, 'POST', {
        username, password,
        ...(!initialized ? { tenantName } : enrolling ? { invitationCode } :
          mfaCode.trim() ? { mfaCode: mfaCode.trim() } : {})
      }, !initialized ? session?.csrfToken : undefined);
      setPassword(''); setMfaCode('');
      setInvitationCode('');
      setInitialized(true);
      onAuthenticated(data);
    });
  };
  if (initialized === null) return <p className="hint">正在查询持久身份状态…</p>;
  if (!identity) {
    if (!initialized && !session) {
      return <p className="hint">尚未创建管理员。请先通过本机启动时提供的 bootstrap 链接进入任务板，再创建首个持久管理员。</p>;
    }
    return (
      <section className="lulu-card" aria-label="持久用户登录">
        <h2>{!initialized ? '创建持久管理员（仅一次）' : enrolling ? '使用一次性邀请注册' : '登录大铭工作空间'}</h2>
        <form onSubmit={authenticate}>
          <label>用户名 <input required autoComplete="username" minLength={3} maxLength={48}
            value={username} onChange={e => setUsername(e.target.value)} placeholder="英文与数字" /></label>
          <label>密码 <input required type="password" autoComplete={initialized && !enrolling ? 'current-password' : 'new-password'}
            minLength={14} maxLength={256} value={password} onChange={e => setPassword(e.target.value)} /></label>
          {!initialized && <label>初始租户名称 <input required value={tenantName}
            maxLength={80} onChange={e => setTenantName(e.target.value)} /></label>}
          {initialized && !enrolling && <label>验证器动态码 / 一次性恢复码（已启用 MFA 时填写）
            <input autoComplete="one-time-code" value={mfaCode} onChange={e => setMfaCode(e.target.value)} />
          </label>}
          {initialized && enrolling && <label>邀请凭据 <input required autoComplete="off"
            value={invitationCode} onChange={e => setInvitationCode(e.target.value)} /></label>}
          <button disabled={busy || password.length < 14} type="submit">
            {!initialized ? '完成一次性管理员初始化' : enrolling ? '接受邀请并创建账户' : '登录'}
          </button>
        </form>
        {initialized && <button type="button" disabled={busy} onClick={() => setEnrolling(!enrolling)}>
          {enrolling ? '已有账户，返回登录' : '有邀请凭据？注册新账户'}
        </button>}
        {message && <p role="alert" className="hint">{message}</p>}
        <p className="hint">会话存储于本机 Host；登录密码不会发送给任何 LLM 或供应商。</p>
      </section>
    );
  }

  if (identity && !session?.mfaEnabled) {
    return (
      <section className="lulu-card" aria-label="绑定多因素验证器">
        <h2>启用两步验证后才能执行操作</h2>
        <p className="hint">使用支持 TOTP 的验证器。二维码不是必需的：可手动输入下面的密钥。验证码每 30 秒更新，密码和密钥只留在本机 Host。</p>
        {recoveryCodes.length > 0 ? <>
          <p><strong>一次性恢复码（仅此一次展示）</strong>：请离线安全保存。每个恢复码只能登录一次。</p>
          <textarea readOnly rows={9} value={recoveryCodes.join('\n')}
            aria-label="MFA 一次性恢复码" />
          <button type="button" onClick={() => void act(async () => {
            const response = await fetch('/api/session');
            if (!response.ok) throw new Error('session_refresh_failed');
            const updated = await response.json() as SessionView;
            setRecoveryCodes([]); setMfaEnrollment(null); setMfaCode(''); setPassword('');
            onAuthenticated(updated);
          })}>我已安全保存恢复码，继续</button>
        </> : !mfaEnrollment ? (
          <form onSubmit={e => { e.preventDefault(); void act(async () => {
            const data = await identityRequest<{ secret: string; enrollmentUri: string }>(
              'mfa/begin', 'POST', { password }, session.csrfToken);
            setMfaEnrollment(data); setPassword('');
          }); }}>
            <label>再次输入当前登录密码
              <input type="password" required minLength={14} maxLength={256}
                autoComplete="current-password" value={password}
                onChange={e => setPassword(e.target.value)} />
            </label>
            <button type="submit" disabled={busy || password.length < 14}>创建验证器绑定</button>
          </form>
        ) : <>
          <p>验证器手动输入密钥：<code>{mfaEnrollment.secret}</code></p>
          <p className="hint">也可以在验证器中使用标准 otpauth URI（请不要发送给第三方）：</p>
          <code>{mfaEnrollment.enrollmentUri}</code>
          <form onSubmit={e => { e.preventDefault(); void act(async () => {
            const confirmed = await identityRequest<{ recoveryCodes: string[] }>(
              'mfa/confirm', 'POST', { code: mfaCode }, session.csrfToken);
            setMfaCode(''); setMfaEnrollment(null);
            setRecoveryCodes(confirmed.recoveryCodes);
          }); }}>
            <label>验证器当前 6 位动态码
              <input inputMode="numeric" pattern="[0-9]{6}" required
                autoComplete="one-time-code" maxLength={6} value={mfaCode}
                onChange={e => setMfaCode(e.target.value)} />
            </label>
            <button type="submit" disabled={busy || !/^\d{6}$/.test(mfaCode)}>验证并启用 MFA</button>
          </form>
        </>}
        {message && <p role="alert" className="hint">{message}</p>}
      </section>
    );
  }

  return (
    <section className="lulu-card" aria-label="用户、租户与 API 账号管理">
      <details>
        <summary><strong>用户与账号归属</strong> · {identity.username} · {identity.tenantName}（{identity.memberRole}）</summary>
        <p className="hint">账号与租户绑定；密钥仅加密存储于本机，不向页面回显。官方 API 只读校验代表密钥控制权，不能证明供应商账单所有权。真实付费派工仍关闭。</p>
        {readiness && <div className="hint">
          <strong>生产准入检查 · 已核验 Key {readiness.validKeyControlProofs} 把 · 自动付费派工关闭</strong>
          <ul>{readiness.blockers.map(item => <li key={item}>{({
            mfa_enrollment_required: '尚未完成 MFA',
            no_recent_verified_api_key: '缺少 24 小时内有效的凭据控制权证明',
            vendor_billing_organization_proof_missing: '供应商计费组织授权未核验',
            vendor_guaranteed_per_request_cash_limit_missing: '无法保证单任务硬现金上限',
            vendor_authenticated_invoice_reconciliation_missing: '缺少供应商认证账单对账',
            legacy_global_services_not_multitenant: '旧全局管理服务尚未租户隔离'
          } as Record<string, string>)[item] ?? item}</li>)}</ul>
        </div>}
        <div className="row-actions">
          <label>当前租户
            <select value={identity.tenantId} disabled={busy} onChange={e => void act(async () => {
              const result = await identityRequest<SessionView>('switch-tenant', 'POST', {
                tenantId: e.target.value
              }, session!.csrfToken);
              setApiKey(''); setVerifyId(''); onAuthenticated(result);
            })}>
              {tenants.map(t => <option key={t.tenantId} value={t.tenantId}>{t.name} · {t.role}</option>)}
            </select>
          </label>
          <button type="button" disabled={busy} onClick={() => void act(async () => {
            await identityRequest('logout', 'POST', {}, session!.csrfToken);
            setApiKey(''); onAuthenticated(null);
          })}>退出登录</button>
        </div>


        <h3>租户独立 API 账号（不使用共享 Magpie）</h3>
        <p className="hint">租户 Owner 可独立登记自己的官方 API Key。它只存入本租户的加密凭据库并验证指定模型；不会写入本机共享 Magpie 供应商、安装插件或启动模型执行器。</p>
        {independentAccounts.length === 0 && <p className="hint">当前租户还没有独立验证的账号。</p>}
        <ul>{independentAccounts.map(account => (
          <li key={account.credentialId}>
            {account.label} · {account.provider} / {account.modelId} ·
            最近验证到期 {new Date(account.expiresAt).toLocaleString()} ·
            Magpie 执行绑定未通过
            {canManage && <>
              <button type="button" disabled={busy} onClick={() => {
                setIndependentReverify(account.credentialId);
                setIndependentKey('');
                setMessage('重新输入这条账号的完整 API Key，只做官方模型列表核验。');
              }}>重新验证</button>
              <button type="button" disabled={busy} onClick={() => void act(async () => {
                await identityRequest('tenant-accounts/' + account.credentialId,
                  'DELETE', {}, session!.csrfToken);
                if (independentReverify === account.credentialId) setIndependentReverify('');
                await reload();
              })}>撤销</button>
            </>}
          </li>
        ))}</ul>
        {canManage && <form onSubmit={event => {
          event.preventDefault();
          void act(async () => {
            if (independentReverify) {
              await identityRequest('tenant-accounts/' + independentReverify + '/verify',
                'POST', { apiKey: independentKey }, session!.csrfToken);
            } else {
              await identityRequest('tenant-accounts', 'POST', {
                provider: independentProvider, modelId: independentModel.trim(),
                label: independentLabel, apiKey: independentKey
              }, session!.csrfToken);
            }
            setIndependentKey(''); setIndependentReverify('');
            await reload();
            setMessage('官方模型读取校验成功。仍需独立租户网关及真实账单费控才能派工。');
          });
        }}>
          <h3>{independentReverify ? '复核独立账号' : '登记独立账号'}</h3>
          {!independentReverify && <>
            <label>供应商
              <select value={independentProvider} onChange={event => {
                const value = event.target.value as 'openai' | 'deepseek';
                setIndependentProvider(value);
                setIndependentModel(value === 'deepseek' ? 'deepseek-chat' : '');
              }}>
                <option value="deepseek">DeepSeek 官方直连</option>
                <option value="openai">OpenAI 官方直连</option>
              </select>
            </label>
            <label>模型 ID
              <input required maxLength={100} value={independentModel}
                onChange={event => setIndependentModel(event.target.value)} />
            </label>
            <label>备注
              <input required maxLength={80} value={independentLabel}
                onChange={event => setIndependentLabel(event.target.value)} />
            </label>
          </>}
          <label>完整 API Key（只发送到本机 Host 与该供应商官方只读接口）
            <input required type="password" autoComplete="off" value={independentKey}
              onChange={event => setIndependentKey(event.target.value)} />
          </label>
          <button type="submit" disabled={busy || independentKey.length < 12 ||
            (!independentReverify && (!independentModel || !independentLabel.trim()))}>
            {independentReverify ? '重新核验' : '核验并加密保存'}
          </button>
          {independentReverify && <button type="button" disabled={busy}
            onClick={() => { setIndependentReverify(''); setIndependentKey(''); }}>取消复核</button>}
        </form>}

        <h3>共享 Magpie 账号（{accounts.length}）</h3>
        {accounts.length === 0 && <p className="hint">此租户暂未验证任何 API Key。</p>}
        <ul>{accounts.map(account => (
          <li key={account.credentialId}>{account.label} · {account.providerKind} · {account.providerId} ·
            只读鉴权已验证（到期 {new Date(account.expiresAt).toLocaleString()}） · 真实供应商账单所有权未验证
            {canManage && <>
              <button type="button" disabled={busy} onClick={() => { setVerifyId(account.credentialId); setMessage('请输入同一把 API Key，选择对应模型后重新验证。'); }}>重新验证</button>
              <button type="button" disabled={busy} onClick={() => void act(async () => {
                await identityRequest('accounts/' + account.credentialId, 'DELETE', {}, session!.csrfToken);
                await reload();
              })}>撤销账号</button>
            </>}
          </li>
        ))}</ul>
        {canManage && identity.rootAdministrator && <form onSubmit={e => {
          e.preventDefault();
          void act(async () => {
            if (!selectedCandidate) throw new Error('请先选择 Magpie 模型账号');
            if (verifyId) await identityRequest('accounts/' + verifyId + '/verify', 'POST',
              { candidateId: selectedCandidate, apiKey }, session!.csrfToken);
            else await identityRequest('accounts', 'POST', {
              candidateId: selectedCandidate, providerKind, apiKey, label: accountLabel
            }, session!.csrfToken);
            setApiKey(''); setVerifyId(''); await reload();
            setMessage('密钥控制权验证成功；实际付费路由仍未开放。');
          });
        }}>
          <h3>{verifyId ? '重新核验现有账号' : '登记自己提供的 API Key'}</h3>
          <label>Magpie 候选模型/账号
            <select required value={selectedCandidate} onChange={e => setSelectedCandidate(e.target.value)}>
              <option value="">选择候选项</option>
              {candidates.map(c => <option key={c.candidateId} value={c.candidateId}>
                {c.providerId} / {c.modelId} / {c.accountLabel}
              </option>)}
            </select>
          </label>
          {!verifyId && <>
            <label>供应商
              <select value={providerKind} onChange={e => setProviderKind(e.target.value as 'openai' | 'deepseek')}>
                <option value="openai">OpenAI（官方直连）</option>
                <option value="deepseek">DeepSeek（官方直连）</option>
              </select>
            </label>
            <label>账号备注 <input maxLength={80} required value={accountLabel}
              onChange={e => setAccountLabel(e.target.value)} /></label>
          </>}
          <label>API Key（不会回显）
            <input required type="password" autoComplete="off" value={apiKey}
              onChange={e => setApiKey(e.target.value)} />
          </label>
          <button type="submit" disabled={busy || !selectedCandidate || apiKey.length < 12}>
            {verifyId ? '只读重新验证' : '验证并加密登记'}
          </button>
          {verifyId && <button type="button" disabled={busy} onClick={() => { setVerifyId(''); setApiKey(''); }}>取消重新验证</button>}
        </form>}


        <h3>供应商只读财务观测</h3>
        <p className="hint">这里展示的是官方 API 返回的余额或项目费用，并非最终发票、付款人身份认证或模型 Key 与项目的绑定证明。即使成功查询，也不会开放付费模型执行。</p>
        {canManage && <form onSubmit={event => {
          event.preventDefault();
          void act(async () => {
            const account = accounts.find(item => item.credentialId === billingCredentialId);
            if (!account) throw new Error('请选择本租户已登记的账号');
            const input = account.providerKind === 'deepseek'
              ? { credentialId: account.credentialId, provider: 'deepseek',
                apiKey: billingModelKey }
              : { credentialId: account.credentialId, provider: 'openai',
                adminKey: billingAdminKey, projectId: billingProjectId.trim() };
            await identityRequest('billing/probe', 'POST', input, session!.csrfToken);
            setBillingModelKey(''); setBillingAdminKey(''); await reload();
            setMessage('官方只读数据已记录。账单所有权、最终发票与单请求硬费控仍未通过。');
          });
        }}>
          <label>已登记账号
            <select required value={billingCredentialId} onChange={event => {
              setBillingCredentialId(event.target.value);
              setBillingModelKey(''); setBillingAdminKey(''); setBillingProjectId('');
            }}>
              <option value="">选择账号</option>
              {accounts.map(account => <option key={account.credentialId} value={account.credentialId}>
                {account.label} · {account.providerKind}
              </option>)}
            </select>
          </label>
          {selectedBillingAccount?.providerKind === 'deepseek' && <label>
            DeepSeek API Key（仅本次官方余额只读查询）
            <input type="password" autoComplete="off" required
              value={billingModelKey} onChange={event => setBillingModelKey(event.target.value)} />
          </label>}
          {selectedBillingAccount?.providerKind === 'openai' && <>
            <p className="hint">OpenAI 项目费用查询需要单独提供拥有组织费用读取权限的 Admin API Key，权限较高。仅在可信本机输入，查询后不会保存；不进行项目变更或扣费操作。</p>
            <label>OpenAI Admin API Key（只使用本次）
              <input type="password" autoComplete="off" required
                value={billingAdminKey} onChange={event => setBillingAdminKey(event.target.value)} />
            </label>
            <label>OpenAI Project ID
              <input autoComplete="off" required placeholder="proj_..."
                value={billingProjectId} onChange={event => setBillingProjectId(event.target.value)} />
            </label>
          </>}
          <button type="submit" disabled={busy || !selectedBillingAccount ||
            (selectedBillingAccount.providerKind === 'deepseek'
              ? billingModelKey.length < 12 : billingAdminKey.length < 12 || !billingProjectId.startsWith('proj_'))}>
            查询官方只读状态
          </button>
        </form>}
        {billingObservations.length > 0 && <div>
          <h3>当前租户的历史观测（{billingObservations.length}）</h3>
          <ul>{billingObservations.map(item => <li key={item.observationId}>
            {item.provider} · {item.scopeHint} · {new Date(item.observedAt).toLocaleString()} ·
            {item.amounts.map(amount => ' ' + amount.currency + ' ' +
              (amount.minor / 100).toFixed(2)).join(' / ')} ·
            {item.periodStart ? '上一完整 UTC 日的项目费用' : '查询当时的账户余额'} ·
            仅供观察，尚非认证发票
          </li>)}</ul>
        </div>}

        <BudgetPanel session={session!} />
        <h3>租户成员</h3>
        <ul>{members.map(member => <li key={member.userId}>{member.username}（{member.role}）
          {canManage && member.userId !== identity.userId && member.role !== 'owner' &&
            <button type="button" disabled={busy} onClick={() => void act(async () => {
              await identityRequest('members/' + member.userId, 'DELETE', {}, session!.csrfToken);
              await reload();
            })}>移除成员并注销其会话</button>}
        </li>)}</ul>
        {canManage && <div>
          <label>邀请权限
            <select value={inviteRole} onChange={e => setInviteRole(e.target.value as 'operator' | 'viewer')}>
              <option value="operator">操作员</option><option value="viewer">只读观察员</option>
            </select>
          </label>
          <button type="button" disabled={busy} onClick={() => void act(async () => {
            const invited = await identityRequest<{ invitationCode: string }>('invitations', 'POST',
              { role: inviteRole }, session!.csrfToken);
            setNewInvitation(invited.invitationCode);
          })}>创建单次邀请（20 分钟）</button>
          {newInvitation && <p className="hint">仅显示一次的邀请码：<code>{newInvitation}</code></p>}
          <form onSubmit={e => { e.preventDefault(); void act(async () => {
            await identityRequest('tenants', 'POST', { name: newTenant }, session!.csrfToken);
            setNewTenant(''); await reload();
          }); }}>
            <label>新租户名称 <input required maxLength={80} value={newTenant}
              onChange={e => setNewTenant(e.target.value)} /></label>
            <button type="submit" disabled={busy || !newTenant.trim()}>创建独立租户</button>
          </form>
        </div>}
        {message && <p role="status" className="hint">{message}</p>}
      </details>
    </section>
  );
}
