import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import type { CrewChildView, CrewOverviewView, CrewPlanView, SessionView } from '@daming/contracts';
import { notifyRefresh, useAdaptiveResource } from './live-refresh.ts';
import { STATUS_LABELS } from './format.ts';

const AGENT_LABEL: Record<string, string> = { dsh: 'DeepSeek Harness', codex: 'Codex', 'claude-code': 'Claude Code' };
const BINDING_LABEL: Record<CrewChildView['binding'], string> = { bound: '模型已绑定', unbound: '模型未绑定' };

function timeOf(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function ChildRow({ child, onOpenTask }: { child: CrewChildView; onOpenTask?: (taskId: string) => void }) {
  const percent = child.totalSteps > 0 ? Math.round((child.completedSteps / child.totalSteps) * 100) : 0;
  const statusLabel = child.status ? STATUS_LABELS[child.status] : '任务记录已缺失';
  return (
    <li className="crew-child">
      <span className="crew-branch" aria-hidden="true">└</span>
      <article className="crew-node">
        <header className="crew-node__head">
          <strong title={child.title}>{child.title}</strong>
          <span className={`crew-state crew-state--${child.status ?? 'missing'}`}>
            <i aria-hidden="true" />
            {statusLabel}
          </span>
        </header>
        <dl className="crew-node__meta">
          <div><dt>Agent</dt><dd>{AGENT_LABEL[child.agent] ?? child.agent}</dd></div>
          <div><dt>模型</dt><dd title={child.modelId}>{child.modelId || '未分配'}</dd></div>
          <div><dt>绑定</dt><dd>{BINDING_LABEL[child.binding]}</dd></div>
          <div><dt>派发</dt><dd>{timeOf(child.dispatchedAt)}</dd></div>
          <div><dt>任务</dt><dd className="crew-mono" title={child.taskId}>{child.taskId.slice(0, 8)}</dd></div>
        </dl>
        <div className="crew-progress" aria-label={`执行进度 ${child.completedSteps}/${child.totalSteps}`}>
          <div className="crew-progress__track"><span style={{ width: Math.max(child.status === 'completed' ? 100 : 2, percent) + '%' }} /></div>
          <small>{child.completedSteps}/{child.totalSteps} 步 · {percent}%</small>
        </div>
        {child.blockedReason && <p className="crew-node__error" role="status">阻塞：{child.blockedReason}</p>}
        {child.waitingOn.length > 0 && (
          <p className="crew-node__wait" role="status">
            等待前置交付：{child.waitingOn.join('、')}（计划依赖，Host 不强制串行）
          </p>
        )}
        {child.status === null && <p className="crew-node__error" role="status">该 taskId 在任务库中已不存在（可能被清理），已保留派发回执。</p>}
        {onOpenTask && child.status !== null && (
          <button type="button" className="link-btn" onClick={() => onOpenTask(child.taskId)}>打开任务执行图 →</button>
        )}
      </article>
    </li>
  );
}

function PlanDetail({ plan, canWrite, busy, onDispatch, onOpenTask }: {
  plan: CrewPlanView;
  canWrite: boolean;
  busy: string;
  onDispatch: () => void;
  onOpenTask?: (taskId: string) => void;
}) {
  const dispatchable = plan.assignments.filter((assignment) => assignment.ready).length;
  const undispatched = plan.assignments.filter((assignment) =>
    !plan.children.some((child) => child.assignmentId === assignment.id) &&
    !plan.skipped.some((skip) => skip.assignmentId === assignment.id));
  const dispatchLabel = busy === 'dispatch' ? '派发中…'
    : undispatched.length === 0 ? '已全部派发'
    : plan.children.length ? '派发剩余子目标'
    : '按方案派发';
  const doneRatio = plan.progress.dispatched
    ? Math.round((plan.progress.completed / plan.progress.dispatched) * 100) : 0;
  return (
    <article className="crew-plan" aria-label={`编队方案 ${plan.title}`}>
      <header className="crew-plan-head">
        <div>
          <p className="eyebrow">{plan.planner === 'main-agent' ? '主 AGENT 分派' : '平台规则分派'}</p>
          <h3>{plan.title}</h3>
          <p className="hint">{plan.goal}</p>
        </div>
        <div className="crew-plan-actions">
          <span className="hint">创建 {timeOf(plan.createdAt)}</span>
          {plan.dispatchedAt && <span className="hint">最近派发 {timeOf(plan.dispatchedAt)}</span>}
          {canWrite && (
            <button
              type="button"
              className={dispatchable === 0 || undispatched.length === 0 ? 'ghost-btn' : 'primary-btn'}
              disabled={busy === 'dispatch' || dispatchable === 0 || undispatched.length === 0}
              onClick={onDispatch}
            >
              {dispatchLabel}
            </button>
          )}
        </div>
      </header>

      <div className="crew-kpis" aria-label="编队进度">
        <div><span>子目标</span><strong>{plan.assignments.length}</strong></div>
        <div><span>已派发</span><strong>{plan.progress.dispatched}</strong></div>
        <div><span>进行中</span><strong>{plan.progress.running}</strong></div>
        <div><span>已交付</span><strong>{plan.progress.completed}</strong></div>
        <div><span>阻塞 / 失败</span><strong>{plan.progress.blocked + plan.progress.failed}</strong></div>
        <div><span>未派发</span><strong>{plan.progress.pending}</strong></div>
      </div>
      <div className="crew-progress crew-progress--plan">
        <div className="crew-progress__track"><span style={{ width: Math.max(2, doneRatio) + '%' }} /></div>
        <small>交付 {plan.progress.completed}/{plan.progress.dispatched || 0} · {doneRatio}%</small>
      </div>

      <div className="crew-tree">
        <div className="crew-node crew-node--root">
          <header className="crew-node__head">
            <strong>编队 · {plan.title}</strong>
            <span className="crew-state crew-state--plan"><i aria-hidden="true" />父任务（方案）</span>
          </header>
          <p className="crew-node__detail">派发回执持久化在 Host；子任务状态实时来自任务库。</p>
        </div>
        <ol className="crew-children">
          {plan.children.map((child) => (
            <ChildRow key={child.assignmentId + child.taskId} child={child} onOpenTask={onOpenTask} />
          ))}
        </ol>
        {!plan.children.length && <p className="hint crew-empty">还没有派发回执：点击“按方案派发”，子任务会作为独立任务进入看板。</p>}
      </div>

      <div className="crew-pending">
        <div className="card-title"><h3>尚未派发的子目标</h3><span className="hint">{undispatched.length} 个</span></div>
        {undispatched.map((assignment) => (
          <div className="crew-assignment" key={assignment.id}>
            <strong>{assignment.title}</strong>
            <span>{AGENT_LABEL[assignment.agent] ?? assignment.agent} · {assignment.providerId || '无供应商'}/{assignment.modelId || '无模型'}</span>
            <span className="hint">理由：{assignment.rationale}</span>
            {assignment.dependsOn.length > 0 && <span className="hint">计划前置：{assignment.dependsOn.join('、')}</span>}
            <span className={`state-pill ${assignment.ready ? 'state-ok' : 'state-idle'}`}>{assignment.ready ? '可派发' : '待接入模型'}</span>
          </div>
        ))}
        {!undispatched.length && <p className="hint">所有子目标都有派发回执或跳过原因。</p>}
      </div>

      {plan.skipped.length > 0 && (
        <div className="crew-pending">
          <div className="card-title"><h3>跳过与失败</h3><span className="hint">{plan.skipped.length} 条</span></div>
          {plan.skipped.map((skip) => (
            <div className="crew-assignment" key={skip.assignmentId + skip.reason}>
              <strong>{skip.assignmentId}</strong>
              <span className="crew-mono">{skip.reason}</span>
              <span className="hint">{timeOf(skip.at)}</span>
            </div>
          ))}
        </div>
      )}

      {plan.notes.map((note) => <p className="hint" key={note}>{note}</p>)}
    </article>
  );
}

export function CrewPanel({ session, onOpenTask }: { session: SessionView; onOpenTask?: (taskId: string) => void }) {
  const [title, setTitle] = useState('交付一个多 Agent 协作功能');
  const [goal, setGoal] = useState('完成需求梳理、代码实现、测试验证和最终复核交付。');
  const [subgoals, setSubgoals] = useState('');
  const [planner, setPlanner] = useState<'platform' | 'main-agent'>('main-agent');
  const [sequence, setSequence] = useState<'parallel' | 'sequential'>('parallel');
  const [overview, setOverview] = useState<CrewOverviewView | null>(null);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useAdaptiveResource({
    enabled: !!session,
    identity: 'crew:' + (session.identity?.tenantId ?? 'local'),
    scope: 'crew',
    scopes: ['tasks'],
    intervalMs: () => {
      const plans = overview?.plans ?? [];
      return plans.some((plan) => plan.progress.running > 0) ? 4000 : 20000;
    },
    fetcher: async (signal) => {
      const response = await fetch('/api/crew/overview', { signal, credentials: 'same-origin' });
      if (!response.ok) throw new Error('crew_overview_unavailable');
      return await response.json() as CrewOverviewView;
    },
    onData: (value) => setOverview(value),
    onError: () => setError('暂时读不到编队记录（Host 未就绪或会话只读）。')
  });

  const plans = overview?.plans ?? [];
  const selected = useMemo(
    () => plans.find((plan) => plan.planId === selectedPlanId) ?? plans[0] ?? null,
    [plans, selectedPlanId]
  );

  useEffect(() => {
    if (selected && selected.planId !== selectedPlanId) setSelectedPlanId(selected.planId);
  }, [selected, selectedPlanId]);

  const createPlan = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy('plan'); setMessage(''); setError('');
    try {
      const response = await fetch('/api/crew/plan', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-daming-csrf': session.csrfToken },
        body: JSON.stringify({ title, goal, planner, sequence, ...(subgoals.trim() ? { subgoals: subgoals.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) } : {}) })
      });
      const data = await response.json().catch(() => ({})) as { plan?: { planId: string; assignments: unknown[] }; reason?: string; catalogCount?: number };
      if (!response.ok || !data.plan) throw new Error(data.reason ?? 'crew_plan_failed');
      setSelectedPlanId(data.plan.planId);
      setMessage('平台已根据真实供应商目录生成 ' + data.plan.assignments.length + ' 个子目标分配方案（目录 ' + (data.catalogCount ?? 0) + ' 个模型）。');
      notifyRefresh('crew');
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : '生成方案失败'); }
    finally { setBusy(''); }
  };

  const dispatch = async (plan: CrewPlanView) => {
    setBusy('dispatch'); setMessage(''); setError('');
    try {
      const response = await fetch('/api/crew/' + plan.planId + '/dispatch', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'x-daming-csrf': session.csrfToken }
      });
      const data = await response.json().catch(() => ({})) as { tasks?: unknown[]; skipped?: { assignmentId: string; reason: string }[]; reason?: string };
      if (!response.ok) throw new Error(data.reason ?? 'crew_dispatch_failed');
      setMessage('已派发 ' + (data.tasks?.length ?? 0) + ' 个子任务' + (data.skipped?.length ? '，跳过 ' + data.skipped.length + ' 个' : '') + '。派发回执已写入 Host。');
      notifyRefresh('crew');
      notifyRefresh('tasks');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '派发失败'); }
    finally { setBusy(''); }
  };

  const totals = plans.reduce((sum, plan) => ({
    children: sum.children + plan.children.length,
    running: sum.running + plan.progress.running,
    completed: sum.completed + plan.progress.completed,
    blocked: sum.blocked + plan.progress.blocked + plan.progress.failed
  }), { children: 0, running: 0, completed: 0, blocked: 0 });
  const canWrite = session.role === 'readwrite';

  return (
    <section className="page-stack crew-page" aria-label="编队">
      <header className="page-head">
        <div>
          <p className="eyebrow">CREW / MULTI-AGENT CONTROL</p>
          <h2>编队</h2>
          <p className="hint">一个目标拆成多个子目标，由平台或主 Agent 选择 Agent 与供应商模型；派发回执、子任务状态和进度全部来自 Host 持久化记录。</p>
        </div>
        <div className="crew-summary" aria-label="编队总览">
          <span><b>{plans.length}</b> 方案</span>
          <span><b>{totals.children}</b> 子任务</span>
          <span><b>{totals.running}</b> 进行中</span>
          <span><b>{totals.completed}</b> 已交付</span>
          <span className={totals.blocked ? 'is-bad' : ''}><b>{totals.blocked}</b> 阻塞/失败</span>
        </div>
      </header>

      {error && <div className="error-banner" role="alert">{error}</div>}
      {message && <p className="hint" role="status">{message}</p>}

      <details className="crew-compose">
        <summary>新建编队方案</summary>
        <form className="crew-form" onSubmit={createPlan}>
          <label>编队名称<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} /></label>
          <label>总目标<textarea value={goal} onChange={(event) => setGoal(event.target.value)} rows={3} maxLength={4000} /></label>
          <label>子目标（可选，一行一个；留空由平台拆分）
            <textarea value={subgoals} onChange={(event) => setSubgoals(event.target.value)} rows={3} placeholder={'调研需求与验收\n实现核心功能\n测试与复核'} />
          </label>
          <div className="crew-options">
            <label className="crew-radio"><input type="radio" checked={planner === 'main-agent'} onChange={() => setPlanner('main-agent')} /> 主 Agent 自动分派（推荐）</label>
            <label className="crew-radio"><input type="radio" checked={planner === 'platform'} onChange={() => setPlanner('platform')} /> 平台规则分派</label>
            <label className="crew-radio" title="只记录计划依赖：Host 仍并行创建子任务，不会强制串行">
              <input type="checkbox" checked={sequence === 'sequential'} onChange={(event) => setSequence(event.target.checked ? 'sequential' : 'parallel')} /> 记录顺序依赖（建议型）
            </label>
            <button type="submit" className="primary-btn" disabled={busy === 'plan'}>{busy === 'plan' ? '规划中…' : '生成编队方案'}</button>
          </div>
        </form>
      </details>

      <div className="crew-layout">
        <aside className="crew-plans" aria-label="历史编队">
          <div className="card-title"><h3>历史编队</h3><span className="hint">最近 50 个</span></div>
          {plans.map((plan) => (
            <button
              type="button"
              key={plan.planId}
              className={`crew-plan-row${selected?.planId === plan.planId ? ' is-active' : ''}`}
              onClick={() => setSelectedPlanId(plan.planId)}
              aria-current={selected?.planId === plan.planId ? 'true' : undefined}
            >
              <strong title={plan.title}>{plan.title}</strong>
              <span>{plan.children.length}/{plan.assignments.length} 派发 · {plan.progress.completed} 交付</span>
              <span className={plan.progress.blocked + plan.progress.failed > 0 ? 'is-bad' : ''}>
                {timeOf(plan.createdAt)}
              </span>
            </button>
          ))}
          {!plans.length && <p className="hint">还没有编队方案。先在“新建编队方案”里生成一个。</p>}
        </aside>

        <div className="crew-detail">
          {selected ? (
            <PlanDetail
              plan={selected}
              canWrite={canWrite}
              busy={busy}
              onDispatch={() => void dispatch(selected)}
              onOpenTask={onOpenTask}
            />
          ) : (
            <div className="empty-card">
              <div className="empty-art" aria-hidden="true"><span className="empty-orb" /><span className="empty-ring" /></div>
              <h3>还没有可观察的编队</h3>
              <p>生成方案后，这里会显示父任务、子目标、Agent 与模型分配、派发状态和执行进度。</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}