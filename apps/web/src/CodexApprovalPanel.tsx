import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { CodexApprovalTaskView, SessionView } from '@daming/contracts';
import { notifyRefresh, useAdaptiveResource } from './live-refresh.ts';

const BASE = '/api/codex-subscription/tasks';
const money = (minor: number) => '¥' + (minor / 100).toFixed(2);
const labels: Record<string, string> = { awaiting_approval: '等待手动审批', running: '单次执行中', queued: '等待执行',
  blocked: '执行已停止，需人工核对', cancelled: '已取消', completed: '已完成', failed: '已停止' };
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { reason?: string } | null;
    const messages: Record<string, string> = {
      codex_web_runtime_unavailable: '未找到 Codex 执行环境或受信 Magpie 连接，请检查本机配置。',
      codex_web_scope_unavailable: '当前 Magpie 未通过单次发送能力检查。',
      codex_web_subscription_unavailable: '固定模型或唯一 Codex 订阅账号不可用，请检查 Magpie。',
      codex_web_unresolved: '已有待审批、执行中或待核账任务，请先处理该任务。',
      codex_web_expired: '审批已失效，请取消后重新创建。',
      codex_web_binding_changed: '账号或模型发生变化，本次没有执行，请取消后重新创建。',
      codex_web_request_conflict: '该请求已保存，请刷新查看；修改内容需创建新请求。'
    };
    throw new Error(messages[body?.reason ?? ''] ?? '操作未确认，请刷新查看任务状态。');
  }
  return await response.json() as T;
}
export function CodexApprovalPanel({ session }: { session: SessionView }) {
  const allowed = session.role === 'readwrite' &&
    (session.localMode === true || (!!session.identity?.rootAdministrator && session.mfaEnabled === true));
  const [tasks, setTasks] = useState<readonly CodexApprovalTaskView[]>([]);
  const [prompt, setPrompt] = useState('回复 OK。不要调用工具。');
  const [limit, setLimit] = useState('500');
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const actionLock = useRef(false);
  useAdaptiveResource({ enabled: allowed, identity: 'codex-consent:' + session.csrfToken, scope: 'codex',
    intervalMs: () => tasks.some(t => !t.recoveryRequired && (t.status === 'running' || t.status === 'queued')) ? 2000 : 15000,
    fetcher: signal => api<{ tasks: CodexApprovalTaskView[] }>(BASE, { signal }),
    onData: data => { setTasks(data.tasks); setReadError(''); },
    onError: () => setReadError('任务状态读取失败，请刷新后再审批。') });
  const post = <T,>(path: string, body: object) => api<T>(path, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-daming-csrf': session.csrfToken }, body: JSON.stringify(body) });
  const act = async (key: string, action: () => Promise<void>) => {
    if (actionLock.current) return;
    actionLock.current = true; setBusy(key); setError('');
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : '操作未确认，请刷新。'); }
    finally { actionLock.current = false; setBusy(''); setConfirmed(null); notifyRefresh('codex'); }
  };
  const update = (task: CodexApprovalTaskView) => setTasks(old => [task, ...old.filter(t => t.taskId !== task.taskId)]);
  const prepare = (event: FormEvent) => {
    event.preventDefault();
    void act('prepare', async () => {
      update(await post<CodexApprovalTaskView>(BASE, { requestId, prompt, limitMinor: Number(limit) }));
      setRequestId(crypto.randomUUID());
    });
  };
  return <section className="command-center codex-approval" aria-label="Codex 单次手动审批">
    <div className="command-center__head"><div><span className="eyebrow">CODEX → MAGPIE</span><h2>单次文本任务 · 手动审批</h2></div>
      {allowed && <button type="button" onClick={() => notifyRefresh('codex')}>刷新审批状态</button>}</div>
    <p className="hint">每次批准只发送一次文本，不调用工具。预算是大铭预留，实际费用需人工核对。</p>
    {!allowed ? <p className="hint">请使用管理员账号登录并完成双重验证后使用此入口。</p> : <>
      <div className="codex-approval__columns">
        <form className="codex-approval__form" onSubmit={prepare}>
          <label>本次文本任务<textarea required maxLength={4000} rows={5} value={prompt} onChange={e => setPrompt(e.target.value)} disabled={!!busy} /></label>
          <label>本次预算预留（分，1–500）<input type="number" required min={1} max={500} step={1} value={limit} onChange={e => setLimit(e.target.value)} disabled={!!busy} /></label>
          <p className="hint">固定模型 codex/gpt-6.1-sol；账号会在审批卡中确认。审批五分钟内有效。</p>
          <button type="submit" disabled={!!busy || !prompt.trim()}>创建待审批任务</button>
        </form>
        <div className="codex-approval__tasks" aria-live="polite">
          {!tasks.length && <p className="hint">尚无网页审批任务。创建后可核对内容，再决定是否发送。</p>}
          {tasks.map(task => <article className="codex-approval__task" key={task.taskId}>
            <div className="panel-heading"><h3>{task.recoveryRequired ? '执行中断，需人工核对' : labels[task.status] ?? task.status}</h3><span>{task.model}</span></div>
            <p>{task.accountLabel} · 本次预留上限 {money(task.limitMinor)}</p>
            <pre className="codex-approval__text" aria-label="待发送文本">{task.prompt}</pre>
            {task.status === 'awaiting_approval' && <>
              <p className="hint">有效期至 {new Date(task.expiresAt).toLocaleString()}。账号、模型变化后本次审批不执行。</p>
              {task.approvalAvailable ? <label className="codex-approval__consent"><input type="checkbox" checked={confirmed === task.taskId}
                disabled={!!busy || !!readError} onChange={e => setConfirmed(e.target.checked ? task.taskId : null)} />
                我确认发送以上文本一次，并预留 {money(task.limitMinor)}；实际费用待核对。</label>
                : <p className="hint">审批已过期、会话已变化或服务已重启，请取消后重新创建。</p>}
              <div className="codex-approval__actions">
                <button type="button" disabled={!!busy || !!readError || !task.approvalAvailable || confirmed !== task.taskId}
                  onClick={() => void act(task.taskId, async () => update(await post<CodexApprovalTaskView>(BASE + '/' + task.taskId + '/approve', { approvedMaximumMinor: task.limitMinor })))}>
                  {busy === task.taskId ? '处理中…' : '批准并发送一次'}</button>
                <button type="button" disabled={!!busy} onClick={() => void act('cancel:' + task.taskId,
                  async () => update(await post<CodexApprovalTaskView>(BASE + '/' + task.taskId + '/cancel', {})))}>取消本次任务</button>
              </div>
            </>}
            {task.modelStatus && <p>模型结果：{task.modelStatus === 'completed' ? '文本返回成功' : '未确认成功'} · 当前保留 {money(task.cashHeldMinor)} · 现金费用待核对</p>}
            {task.output && <pre className="codex-approval__text" aria-label="模型输出">{task.output}</pre>}
            {task.usage && <p className="hint">用量：输入 {task.usage.input_tokens ?? '未知'} / 输出 {task.usage.output_tokens ?? '未知'} token</p>}
            {task.status === 'blocked' && <p className="hint">保留预留，等待可信 Host 人工核对。不会自动退款或重新发送。</p>}
            {task.recoveryRequired && <p className="hint">服务曾在执行期间停止，当前保留 {money(task.cashHeldMinor)}。需先确认旧执行器已停止，再由可信 Host 显式恢复；不会自动退款或重发。</p>}
            <small className="muted">任务 {task.taskId}</small>
          </article>)}
        </div>
      </div>
      {(error || readError) && <p className="error-banner" role="alert">{error || readError}</p>}
    </>}
  </section>;
}
