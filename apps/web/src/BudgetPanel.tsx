import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { SessionView } from '@daming/contracts';

type Currency = 'USD' | 'CNY';
type Policy = {
  tenantId: string; currency: Currency;
  perRequestMinor: number; perUtcDayMinor: number;
  holdsAndSettledTodayMinor: number; canReservePreview: boolean;
  authorizedPaidDispatch: false;
};
type Hold = {
  holdId: string; requestId: string; tenantId: string;
  currency: Currency; reservedMinor: number;
  status: 'held_preview' | 'cancelled' | 'uncertain';
  utcDay: string; paidDispatchPermitted: false; externalVendorCalled: false;
};

export function BudgetPanel({ session }: { session: SessionView }) {
  const [currency, setCurrency] = useState<Currency>('CNY');
  const [perRequest, setPerRequest] = useState('100');
  const [perDay, setPerDay] = useState('500');
  const [previewMinor, setPreviewMinor] = useState('50');
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [holds, setHolds] = useState<Hold[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const tenantId = session.identity?.tenantId;
  const isOwner = session.identity?.memberRole === 'owner';
  const canOperate = session.identity?.memberRole !== 'viewer';
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch('/api/identity/budget' + path, {
      method, credentials: 'same-origin',
      headers: method === 'GET' ? {} : {
        'content-type': 'application/json', 'x-daming-csrf': session.csrfToken
      },
      ...(method === 'GET' || method === 'DELETE' ? {} : {
        body: JSON.stringify(body ?? {})
      })
    });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(String(data.reason ?? 'budget_action_rejected'));
    return data;
  };
  const reload = async () => {
    const data = await request('');
    setPolicies(data.policies as Policy[]);
    setHolds(data.holds as Hold[]);
  };
  useEffect(() => {
    setPolicies([]); setHolds([]); setMessage('');
    void reload().catch(() => setMessage('无法读取本租户预算状态'));
  }, [tenantId]);
  const doAction = (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setMessage('');
    void fn().catch(e => setMessage(e instanceof Error ? e.message : '操作被拒绝'))
      .finally(() => setBusy(false));
  };
  const asMinor = (value: string) =>
    /^\d{1,9}$/.test(value) ? Number(value) : NaN;
  const configure = (event: FormEvent) => {
    event.preventDefault();
    doAction(async () => {
      await request('/policy', 'POST', {
        currency, perRequestMinor: asMinor(perRequest), perUtcDayMinor: asMinor(perDay)
      });
      await reload();
    });
  };
  const preview = (event: FormEvent) => {
    event.preventDefault();
    doAction(async () => {
      await request('/preview', 'POST', {
        currency, requestedMinor: asMinor(previewMinor),
        requestId: crypto.randomUUID()
      });
      await reload();
    });
  };
  return (
    <section className="lulu-card" aria-label="租户离线预算账本">
      <h3>租户预算预览（不授权真实消费）</h3>
      <p className="hint">金额单位为分（USD 美分、CNY 人民币分），不做货币兑换。这里的预留只用于离线任务预算演算，不能用于启用付费模型、证明供应商硬消费限额或替代发票对账。任何不确定预留会阻断后续预览，直到独立的可信对账流程完成。</p>
      <label>币种
        <select value={currency} onChange={e => setCurrency(e.target.value as Currency)}>
          <option value="CNY">人民币 CNY</option>
          <option value="USD">美元 USD</option>
        </select>
      </label>
      {isOwner && <form onSubmit={configure}>
        <label>单次预留最大金额（整数分）
          <input type="number" min={1} max={100000000} required
            value={perRequest} onChange={e => setPerRequest(e.target.value)} />
        </label>
        <label>单个 UTC 日最大总预留（整数分）
          <input type="number" min={1} max={100000000} required
            value={perDay} onChange={e => setPerDay(e.target.value)} />
        </label>
        <button type="submit" disabled={busy}>保存本租户预览预算</button>
      </form>}
      {canOperate && <form onSubmit={preview}>
        <label>为离线任务预留（整数分）
          <input type="number" min={1} max={100000000} required
            value={previewMinor} onChange={e => setPreviewMinor(e.target.value)} />
        </label>
        <button type="submit" disabled={busy}>创建离线预留（绝不发起付费调用）</button>
      </form>}
      <ul>
        {policies.map(policy => <li key={policy.currency}>
          {policy.currency} · 单次 {policy.perRequestMinor} 分 · 单日 {policy.perUtcDayMinor} 分 ·
          今日尚未释放 {policy.holdsAndSettledTodayMinor} 分 ·
          真实模型付费授权：关闭
        </li>)}
      </ul>
      <h3>本租户最近的预算预留</h3>
      <ul>{holds.filter(hold => hold.status !== 'cancelled').slice(0, 20).map(hold =>
        <li key={hold.holdId}>{hold.utcDay} · {hold.currency} {hold.reservedMinor} 分 ·
          {hold.status === 'uncertain' ? '不确定，禁止自动释放' : '尚未发送至任何供应商'}
          {canOperate && hold.status === 'held_preview' && <button type="button"
            disabled={busy} onClick={() => doAction(async () => {
              await request('/holds/' + hold.holdId, 'DELETE'); await reload();
            })}>取消预览预留</button>}
          {isOwner && hold.status === 'held_preview' && <button type="button"
            disabled={busy} onClick={() => doAction(async () => {
              await request('/holds/' + hold.holdId + '/uncertain', 'POST', {});
              await reload();
            })}>标记结果不确定并冻结</button>}
        </li>
      )}</ul>
      {message && <p role="status" className="hint">{message}</p>}
    </section>
  );
}
