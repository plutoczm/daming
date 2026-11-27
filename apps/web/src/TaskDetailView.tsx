import { useState } from 'react';
import type { FormEvent } from 'react';
import type {
  RealCodexRunView, ReconciliationView, TaskDetailView, TaskEventView, TaskStepView
} from '@daming/contracts';
import { ExecutionGraphPanel } from './ExecutionGraphPanel.tsx';
import { STATUS_LABELS, money, shortId, timeOf, workerLabel } from './format.ts';

const EVENT_LABELS: Record<string, string> = {
  task_created: '任务创建',
  task_transitioned: '状态变更',
  workflow_install: '计划冻结',
  workflow_assign: 'Agent 接单',
  workflow_receive: '接收 Agent 回执',
  workflow_review: '独立评审',
  workflow_supervise: '监督决策',
  effect_settled: '效果结算',
  effect_unknown: '效果未知',
  budget_set: '预算设置',
  budget_reserved: '预算预留',
  budget_settled: '预算结算',
  quote_issued: '报价生成',
  approval_issued: '授权发放',
  tool_started: '工具开始',
  tool_settled: '工具完成',
  tool_unknown: '工具未知'
};

type StepVisualState = 'done' | 'retry' | 'running' | 'blocked' | 'pending';

export function stepState(detail: TaskDetailView, stepId: string): StepVisualState {
  const assignments = detail.assignments.filter((assignment) => assignment.stepId === stepId);
  const latest = assignments.at(-1);
  if (!latest) return 'pending';
  const review = detail.reviews.find((item) => item.assignmentId === latest.assignmentId);
  if (review?.verdict === 'pass') return 'done';
  if (review?.verdict === 'fail') return 'retry';
  if (latest.effectStatus === 'needs_reconciliation' || latest.deliveryStatus === 'failed' || latest.deliveryStatus === 'cancelled') return 'blocked';
  if (['executing', 'pending'].includes(latest.effectStatus)) return 'running';
  return 'pending';
}

const STATE_LABELS: Record<StepVisualState, string> = {
  done: '完成',
  retry: '返工中',
  running: '执行中',
  blocked: '阻塞',
  pending: '等待'
};

function ProcessTimeline({ detail }: { detail: TaskDetailView }) {
  const steps = detail.plan?.steps ?? [];
  if (!steps.length) return <p className="muted">尚无执行阶段。</p>;
  return (
    <div className="process-timeline">
      {steps.map((step: TaskStepView, index: number) => {
        const state = stepState(detail, step.stepId);
        const assignments = detail.assignments.filter((assignment) => assignment.stepId === step.stepId);
        return (
          <details className={`stage-card stage-card--${state}`} key={step.stepId} open={assignments.length > 0}>
            <summary className="stage-card__head">
              <span className={`stage-card__marker stage-card__marker--${state}`} />
              <span className="stage-card__index">{String(index + 1).padStart(2, '0')}</span>
              <span className="stage-card__title"><strong>{step.stepId}</strong><small>{step.description}</small></span>
              <span className="stage-card__worker">{workerLabel(step.workerId)}</span>
              <span className={`mini-status ${state === 'done' ? 'ok' : state === 'retry' || state === 'blocked' ? 'bad' : ''}`}>{STATE_LABELS[state]}</span>
            </summary>
            <div className="stage-card__body">
              {assignments.length ? assignments.map((assignment) => {
                const review = detail.reviews.find((item) => item.assignmentId === assignment.assignmentId);
                return (
                  <div className="attempt-card" key={assignment.assignmentId}>
                    <div className="attempt-card__head">
                      <strong>第 {assignment.stepAttempt} 次 · {workerLabel(assignment.workerId)}</strong>
                      <span className={`mini-status ${review?.verdict === 'pass' ? 'ok' : review?.verdict === 'fail' ? 'bad' : ''}`}>{review?.verdict ?? assignment.deliveryStatus ?? assignment.effectStatus}</span>
                    </div>
                    {assignment.startedAt && <span className="attempt-card__time">{timeOf(assignment.startedAt)}{assignment.endedAt ? ` → ${timeOf(assignment.endedAt)}` : ''}</span>}
                    {assignment.artifactKeys.length > 0 && <div className="attempt-card__artifacts">产出：{assignment.artifactKeys.join('、')}</div>}
                    {assignment.resultPreview && <pre className="attempt-card__preview">{assignment.resultPreview}</pre>}
                    {review?.reasons.length ? <div className="attempt-card__reasons">评审：{review.reasons.join('；')}</div> : null}
                  </div>
                );
              }) : <p className="muted">等待派工</p>}
            </div>
          </details>
        );
      })}
    </div>
  );
}

function ActivityFeed({ events }: { events: readonly TaskEventView[] }) {
  return (
    <ol className="activity-feed">
      {events.slice(-20).reverse().map((event) => (
        <li className="activity-feed__item" key={event.sequence}>
          <span className="activity-feed__dot" />
          <div><strong>{EVENT_LABELS[event.type] ?? event.type}</strong><small>{timeOf(event.occurredAt)} · {event.sourceId}</small></div>
        </li>
      ))}
    </ol>
  );
}

function ReconcilePanel({ taskId, reconciliations, csrfToken, canWrite }: { taskId: string; reconciliations: readonly ReconciliationView[]; csrfToken: string; canWrite: boolean }) {
  const [drafts, setDrafts] = useState<Record<string, { amount: string; evidence: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const draft = (operationId: string) => drafts[operationId] ?? { amount: '', evidence: '' };
  const update = (operationId: string, key: 'amount' | 'evidence', value: string) => {
    setDrafts((current) => ({ ...current, [operationId]: { ...(current[operationId] ?? { amount: '', evidence: '' }), [key]: value } }));
  };
  const submit = async (event: FormEvent, operationId: string) => {
    event.preventDefault();
    if (!canWrite || busy) return;
    const current = draft(operationId);
    if (!/^\d+(\.\d{1,2})?$/.test(current.amount.trim())) { setError('请输入官方账单金额（元，最多两位小数）'); return; }
    if (!current.evidence.trim()) { setError('请填写账单编号或截图说明'); return; }
    setBusy(operationId);
    setError('');
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/reconcile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Daming-CSRF': csrfToken },
        body: JSON.stringify({
          operationId,
          resolution: 'succeeded',
          actualCashMinor: Math.round(Number(current.amount) * 100),
          evidence: current.evidence.trim()
        })
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { reason?: string };
        throw new Error(body.reason ?? `HTTP ${response.status}`);
      }
      setDrafts((existing) => ({ ...existing, [operationId]: { amount: '', evidence: '' } }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '核对失败');
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="panel reconcile-panel">
      <div className="panel-heading"><h3>未知费用核对</h3><span>{reconciliations.length} 笔待核对</span></div>
      <p className="hint">真实调用出现未知现金时保留预留，必须依据官方账单人工核对；核对后任务仍需人工恢复。</p>
      {reconciliations.map((item) => (
        <form className="reconcile-row" key={item.operationId} onSubmit={(event) => void submit(event, item.operationId)}>
          <div className="reconcile-row__head">
            <strong>{shortId(item.operationId)}</strong>
            <span>当前预留 {money(item.heldCashMinor)} · 上限 {money(item.maximumCashMinor)} · {item.billingSource}</span>
          </div>
          {item.reason && <p className="muted">原因：{item.reason}</p>}
          <div className="reconcile-row__inputs">
            <input aria-label="实际现金（元）" inputMode="decimal" placeholder="官方账单金额（元）" value={draft(item.operationId).amount} onChange={(event) => update(item.operationId, 'amount', event.target.value)} disabled={!canWrite || busy !== null} />
            <input aria-label="核对证据" placeholder="账单编号/截图说明" value={draft(item.operationId).evidence} onChange={(event) => update(item.operationId, 'evidence', event.target.value)} disabled={!canWrite || busy !== null} />
            <button type="submit" disabled={!canWrite || busy !== null}>{busy === item.operationId ? '核对中…' : '核对'}</button>
          </div>
        </form>
      ))}
      {error && <p className="hint reconcile-error" role="alert">{error}</p>}
    </section>
  );
}

export function RealCodexPanel({ run }: { run: RealCodexRunView }) {
  return (
    <section className="panel real-codex-panel">
      <div className="panel-heading">
        <h3>真实 Codex 执行</h3>
        <span className={`mini-status ${run.status === 'completed' ? 'ok' : run.status === 'failed' ? 'bad' : ''}`}>{run.status}</span>
      </div>
      <p className="hint">只读临时目录 · {timeOf(run.startedAt)}{run.endedAt ? ` → ${timeOf(run.endedAt)}` : ''}</p>
      <div className="real-codex-prompt">{run.prompt}</div>
      {run.output && <pre className="attempt-card__preview">{run.output}</pre>}
      {run.error && <div className="notice">错误：{run.error}</div>}
      <ol className="real-run-events">
        {run.events.map((event, index) => (
          <li key={`${event.at}-${index}`}>
            <span className="real-run-events__dot" />
            <span className="real-run-events__type">{event.itemType ?? event.type}</span>
            <span>{event.text ?? event.error ?? event.status ?? ''}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function TaskDetail({ detail, canCancel, onCancel, onApprove, csrfToken }: {
  detail: TaskDetailView;
  canCancel: boolean;
  onCancel: () => void;
  onApprove: () => void;
  csrfToken: string;
}) {
  const active = ['draft', 'planned', 'awaiting_approval', 'queued', 'running', 'reviewing'].includes(detail.status);
  return (
    <article className="detail">
      <header className="detail-header">
        <div>
          <p className="eyebrow">TASK / {shortId(detail.taskId)}</p>
          <h2>{detail.title}</h2>
          <p className="goal">{detail.goal}</p>
        </div>
        <div className="detail-actions">
          <span className={`status-pill status-${detail.status}`}>{STATUS_LABELS[detail.status]}</span>
          {detail.status === 'awaiting_approval' && canCancel && <button type="button" className="approve-button" onClick={onApprove}>批准并执行</button>}
          {active && canCancel && <button type="button" className="ghost-button" onClick={onCancel}>取消任务</button>}
        </div>
      </header>

      {detail.blockedReason && <div className="notice">阻塞原因：{detail.blockedReason}</div>}

      <div className="stat-grid">
        <div className="stat-card"><span>预算上限</span><strong>{money(detail.budget?.limitMinor)}</strong></div>
        <div className="stat-card"><span>已花费</span><strong>{money(detail.budget?.spentMinor)}</strong></div>
        <div className="stat-card"><span>当前预留</span><strong>{money(detail.budget?.heldMinor)}</strong></div>
        <div className="stat-card"><span>完成进度</span><strong>{detail.progress.completedSteps}/{detail.progress.totalSteps}</strong></div>
      </div>

      <ExecutionGraphPanel taskId={detail.taskId} />

      <section className="panel process-panel">
        <div className="panel-heading"><h3>阶段时间线</h3><span>展开查看每次 Agent 行动与评审</span></div>
        <ProcessTimeline detail={detail} />
      </section>

      {detail.decisions.length > 0 && (
        <section className="panel">
          <div className="panel-heading"><h3>监督决策</h3><span>并发与返工预算调整</span></div>
          {detail.decisions.map((decision) => (
            <div className="decision-row" key={decision.sequence}>
              <span className="decision-row__seq">#{decision.sequence}</span>
              <span>并发 {decision.previousConcurrency} → {decision.nextConcurrency}</span>
              <span className="muted">{decision.reason} · {decision.samples} 个样本</span>
            </div>
          ))}
        </section>
      )}

      <div className="two-column">
        <section className="panel">
          <div className="panel-heading"><h3>Worker 路由理由</h3><span>硬过滤后选择</span></div>
          {detail.workerRoutes.map((route) => (
            <div className="route-row" key={route.stepId}>
              <strong>{route.stepId}</strong>
              <span>指定：{route.assignedWorkerId} · 候选首选：{route.selectedWorkerId ?? '无'}</span>
              {route.excluded.length > 0 && <span className="muted">排除：{route.excluded.map((item) => `${item.workerId}（${item.reasons.join('、')}）`).join('；')}</span>}
            </div>
          ))}
        </section>
        <section className="panel">
          <div className="panel-heading"><h3>审批与证据</h3><span>{detail.approvals.length} 条授权</span></div>
          {detail.approvals.length ? detail.approvals.map((approval) => (
            <div className="approval-row" key={`${approval.operationId}-${approval.expiresAt}`}>
              <span>{shortId(approval.operationId)}</span>
              <span className={`mini-status ${approval.status === 'consumed' ? 'ok' : ''}`}>{approval.status}</span>
            </div>
          )) : <p className="muted">尚无审批记录。</p>}
          <div className="evidence-summary">
            <span>任务事件 {detail.events.length}</span>
            <span>治理审计 {detail.audit.length}</span>
            <span>评审 {detail.reviews.length}</span>
          </div>
        </section>
      </div>

      {detail.reconciliations.length > 0 && <ReconcilePanel taskId={detail.taskId} reconciliations={detail.reconciliations} csrfToken={csrfToken} canWrite={canCancel} />}

      <div className="two-column">
        <section className="panel">
          <div className="panel-heading"><h3>活动流</h3><span>Agent 与系统动作</span></div>
          <ActivityFeed events={detail.events} />
        </section>
        <section className="panel">
          <div className="panel-heading"><h3>现金审计</h3><span>预算与结算</span></div>
          <ol className="event-list">
            {detail.audit.slice(-12).reverse().map((event, index) => (
              <li key={`${event.sequence ?? index}-${event.type}`}><span className="event-time">{timeOf(event.at)}</span><span>{event.type}{event.amountMinor !== null ? ` · ${money(event.amountMinor)}` : ''}</span></li>
            ))}
          </ol>
        </section>
      </div>
    </article>
  );
}