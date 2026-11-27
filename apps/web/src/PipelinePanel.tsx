import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { PipelineRunView, PipelineStepStatus, PipelineStage, SessionView } from '@daming/contracts';

const AGENT_LABEL: Record<string, string> = { dsh: 'DeepSeek Harness', codex: 'Codex', 'claude-code': 'Claude Code' };
const STAGE_LABEL: Record<PipelineStage, string> = {
  architect: '架构师规划', executing: '子 Agent 执行', reviewing: '评审中', rework: '返工中',
  passed: '已通过', budget_exhausted: '额度耗尽', blocked: '评审否决·阻塞'
};
const STEP_STATUS_LABEL: Record<PipelineStepStatus, string> = {
  pending: '待执行', running: '执行中', reviewing: '评审中', rework: '返工中', passed: '通过', failed: '未通过'
};
const STAGE_TONE: Record<PipelineStage, string> = {
  architect: 'idle', executing: 'run', reviewing: 'run', rework: 'warn',
  passed: 'ok', budget_exhausted: 'warn', blocked: 'bad'
};
const STEP_TONE: Record<PipelineStepStatus, string> = {
  pending: 'idle', running: 'run', reviewing: 'run', rework: 'warn', passed: 'ok', failed: 'bad'
};

/** 评测集/评测结果的一行（未执行的步骤 passed 为 null，表示「待评测」）。 */
interface EvalRow { id: string; label?: string; kind: string; passed: boolean | null; reason?: string }
function checkText(check: { label?: string; kind: string; artifactId?: string }): string {
  if (check.label) return check.label;
  if (check.kind === 'present') return '交付物存在';
  if (check.kind === 'json_equals') return '内容符合（' + (check.artifactId ?? '') + '）';
  return '规则（' + (check.artifactId ?? '') + '）';
}

const TONE_STYLE: Record<string, { background: string; color: string }> = {
  ok: { background: 'rgba(34,150,90,0.14)', color: '#1f7a4d' },
  run: { background: 'rgba(79,70,229,0.14)', color: '#4f46e5' },
  warn: { background: 'rgba(200,140,20,0.16)', color: '#9a6b00' },
  bad: { background: 'rgba(190,60,60,0.16)', color: '#b03b3b' },
  idle: { background: 'rgba(120,120,120,0.14)', color: '#666' }
};

function Pill({ tone, label }: { tone: string; label: string }) {
  const style = TONE_STYLE[tone] ?? TONE_STYLE.idle;
  return <span style={{ ...style, borderRadius: 999, padding: '1px 9px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>{label}</span>;
}

interface RunSummary { runId: string; title: string; stage: string; steps: number; roomId: string | null; updatedAt: string }
interface ModelOpt { providerId: string; modelId: string; dispatchable: boolean }
type RunStep = PipelineRunView['steps'][number];
interface RunDetail { runId: string; roomId: string | null; view: PipelineRunView }

const COST_LABEL: Record<string, string> = { low: '低', mid: '中', high: '高' };
const COST_TONE: Record<string, string> = { low: 'ok', mid: 'idle', high: 'warn' };

/** 单步的「换 Agent / 模型 → 改派并重跑」控件（LoopForge 式从任一节点重跑 / 换执行角色）。 */
function ReassignControls({ step, models, busy, onReassign, onRerun }: {
  step: RunStep; models: readonly ModelOpt[]; busy: boolean;
  onReassign: (agent: string, providerId: string | undefined, modelId: string | undefined) => void;
  onRerun: () => void;
}) {
  const [agent, setAgent] = useState(step.agent);
  const [value, setValue] = useState(step.providerId && step.modelId ? step.providerId + '|||' + step.modelId : '');
  const chosen = models.find((model) => model.providerId + '|||' + model.modelId === value);
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 8 }}>
      <label style={{ display: 'grid', gap: 2, fontSize: 11 }}>Agent
        <select value={agent} onChange={(event) => setAgent(event.target.value)}>
          {['dsh', 'codex', 'claude-code'].map((item) => <option key={item} value={item}>{AGENT_LABEL[item] ?? item}</option>)}
        </select>
      </label>
      <label style={{ display: 'grid', gap: 2, fontSize: 11 }}>模型
        <select value={value} onChange={(event) => setValue(event.target.value)} style={{ minWidth: 190 }}>
          <option value="">（沿用当前绑定）</option>
          {models.map((model) => <option key={model.providerId + '|||' + model.modelId} value={model.providerId + '|||' + model.modelId}>{model.providerId} / {model.modelId}</option>)}
        </select>
      </label>
      <button type="button" disabled={busy} onClick={() => onReassign(agent, chosen?.providerId, chosen?.modelId)}>改派并重跑</button>
      <button type="button" disabled={busy} onClick={onRerun}>重跑此阶段</button>
    </div>
  );
}

export function PipelinePanel({ session }: { session: SessionView }) {
  const [title, setTitle] = useState('交付一个多 Agent 协作功能');
  const [goal, setGoal] = useState('完成需求梳理、代码实现、测试验证和最终复核交付。');
  const [subgoals, setSubgoals] = useState('');
  const [mode, setMode] = useState<'rework' | 'pass' | 'blocked' | 'budget'>('rework');
  const [maxReworks, setMaxReworks] = useState(1);
  const [budgetMinor, setBudgetMinor] = useState(50);
  const [notify, setNotify] = useState(false);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<PipelineRunView | null>(null);
  const [message, setMessage] = useState('');
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [activeRun, setActiveRun] = useState<RunDetail | null>(null);
  const [models, setModels] = useState<ModelOpt[]>([]);
  const [runBusy, setRunBusy] = useState(false);
  const [runMessage, setRunMessage] = useState('');
  const [executorMode, setExecutorMode] = useState<'offline' | 'real'>('offline');

  const loadRuns = async () => {
    try { const response = await fetch('/api/pipeline/runs', { credentials: 'same-origin' }); if (response.ok) { const data = await response.json() as { runs?: RunSummary[] }; setRuns(data.runs ?? []); } } catch { /* ignore */ }
  };
  useEffect(() => {
    void (async () => {
      try {
        const [runsRes, bindingRes] = await Promise.all([
          fetch('/api/pipeline/runs', { credentials: 'same-origin' }),
          fetch('/api/model-binding', { credentials: 'same-origin' })
        ]);
        if (runsRes.ok) { const data = await runsRes.json() as { runs?: RunSummary[] }; setRuns(data.runs ?? []); }
        if (bindingRes.ok) { const data = await bindingRes.json() as { catalog?: { models?: ModelOpt[] } }; setModels((data.catalog?.models ?? []).filter((model) => model.dispatchable)); }
      } catch { /* ignore */ }
    })();
  }, []);

  const startPersisted = async () => {
    if (runBusy) return;
    setRunBusy(true); setRunMessage('');
    try {
      const response = await fetch('/api/pipeline/run', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-daming-csrf': session.csrfToken },
        body: JSON.stringify({
          title, goal, mode, maxReworks, budgetMinor, notify, runtime: executorMode,
          ...(subgoals.trim() ? { subgoals: subgoals.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) } : {})
        })
      });
      const data = await response.json().catch(() => ({})) as { runId?: string; roomId?: string | null; view?: PipelineRunView; reason?: string };
      if (!response.ok || !data.view) throw new Error(data.reason ?? 'pipeline_run_failed');
      setActiveRun({ runId: data.runId ?? '', roomId: data.roomId ?? null, view: data.view });
      setRunMessage(executorMode === 'real'
        ? '已用真实模型运行并留存，建立项目协作群；可在下方对任意阶段换 Agent/模型重跑。'
        : '已留存运行并建立项目协作群；可在下方对任意阶段换 Agent/模型重跑。');
      await loadRuns();
    } catch (cause) { setRunMessage(cause instanceof Error ? cause.message : '留存运行失败'); }
    finally { setRunBusy(false); }
  };

  const openRun = async (runId: string) => {
    try {
      const response = await fetch('/api/pipeline/runs/' + runId, { credentials: 'same-origin' });
      const data = await response.json().catch(() => ({})) as (RunDetail & { reason?: string });
      if (!response.ok) throw new Error(data.reason ?? 'load_failed');
      setActiveRun({ runId: data.runId, roomId: data.roomId, view: data.view });
      setRunMessage('');
    } catch (cause) { setRunMessage(cause instanceof Error ? cause.message : '加载失败'); }
  };

  const reassignStep = async (runId: string, stepId: string, agent: string, providerId: string | undefined, modelId: string | undefined) => {
    setRunBusy(true); setRunMessage('');
    try {
      const response = await fetch('/api/pipeline/runs/' + runId + '/reassign', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-daming-csrf': session.csrfToken },
        body: JSON.stringify({ stepId, agent, ...(providerId ? { providerId } : {}), ...(modelId ? { modelId } : {}) })
      });
      const data = await response.json().catch(() => ({})) as { runId: string; roomId: string | null; view: PipelineRunView; reason?: string };
      if (!response.ok) throw new Error(data.reason ?? 'reassign_failed');
      setActiveRun({ runId: data.runId, roomId: data.roomId, view: data.view });
      setRunMessage('已改派并从该阶段重跑；讨论已回传到协作群。');
      await loadRuns();
    } catch (cause) { setRunMessage(cause instanceof Error ? cause.message : '改派失败'); }
    finally { setRunBusy(false); }
  };

  const rerunStep = async (runId: string, stepId: string) => {
    setRunBusy(true); setRunMessage('');
    try {
      const response = await fetch('/api/pipeline/runs/' + runId + '/rerun', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-daming-csrf': session.csrfToken },
        body: JSON.stringify({ stepId })
      });
      const data = await response.json().catch(() => ({})) as { runId: string; roomId: string | null; view: PipelineRunView; reason?: string };
      if (!response.ok) throw new Error(data.reason ?? 'rerun_failed');
      setActiveRun({ runId: data.runId, roomId: data.roomId, view: data.view });
      setRunMessage('已重跑该阶段；讨论已回传到协作群。');
      await loadRuns();
    } catch (cause) { setRunMessage(cause instanceof Error ? cause.message : '重跑失败'); }
    finally { setRunBusy(false); }
  };

  const run = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/pipeline/simulate', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-daming-csrf': session.csrfToken },
        body: JSON.stringify({
          title, goal, mode, maxReworks, budgetMinor, notify,
          ...(subgoals.trim() ? { subgoals: subgoals.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) } : {})
        })
      });
      const data = await response.json().catch(() => ({})) as PipelineRunView & { reason?: string };
      if (!response.ok) throw new Error(data.reason ?? 'pipeline_failed');
      setView(data);
      setMessage(notify ? '已运行执行链，并按配置尝试推送通知。' : '已运行执行链（离线推演，未触达真实模型）。');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '运行失败');
    } finally { setBusy(false); }
  };

  const fmtPct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

  const report = (() => {
    if (!view) return null;
    const rows = view.steps.flatMap((step) => step.lastReview ? step.lastReview.results : []);
    const total = view.steps.reduce((n, step) => n + (step.lastReview ? step.lastReview.results.length : step.contract.length), 0);
    const passed = rows.filter((row) => row.passed).length;
    const failed = rows.filter((row) => !row.passed).length;
    return { total, passed, failed };
  })();

  return (
    <section className="page-stack" aria-label="执行链">
      <header className="page-head">
        <div>
          <h2>执行链</h2>
          <p className="hint">架构师拆解目标并按能力/绑定/成本分配 Agent 与模型 → 子 Agent 执行 → 评审员按评测集审核 → 不通过就返工，直到通过或额度耗尽；关键节点经飞书/微信/QQ 通知你。</p>
        </div>
      </header>

      <details className="status-card" style={{ padding: 14 }} open>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>运行执行链（离线推演）</summary>
        <form onSubmit={run} style={{ marginTop: 12, display: 'grid', gap: 10 }}>
          <label style={{ display: 'grid', gap: 4 }}>标题
            <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>总目标
            <textarea value={goal} onChange={(event) => setGoal(event.target.value)} rows={2} maxLength={2000} />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>子目标（可选，一行一个；留空由架构师拆分）
            <textarea value={subgoals} onChange={(event) => setSubgoals(event.target.value)} rows={3} placeholder={'调研需求与验收\n实现核心功能\n测试与复核'} />
          </label>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>演示模式
              <select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
                <option value="rework">返工一次后通过（推荐）</option>
                <option value="pass">一次通过</option>
                <option value="blocked">一直不通过（评审否决）</option>
                <option value="budget">额度耗尽</option>
              </select>
            </label>
            <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>每步最多返工
              <input type="number" min={0} max={2} value={maxReworks} onChange={(event) => setMaxReworks(Math.max(0, Math.min(2, Number(event.target.value) || 0)))} style={{ width: 80 }} />
            </label>
            <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>额度（分）
              <input type="number" min={1} value={budgetMinor} onChange={(event) => setBudgetMinor(Math.max(1, Number(event.target.value) || 1))} style={{ width: 100 }} />
            </label>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
              <input type="checkbox" checked={notify} onChange={(event) => setNotify(event.target.checked)} /> 运行后推送到已配置通知通道
            </label>
            <button type="submit" className="primary-btn" disabled={busy || !goal.trim()}>{busy ? '运行中…' : '运行'}</button>
          </div>
        </form>
      </details>

      {message && <p className="hint" role="status">{message}</p>}

      <details className="status-card" style={{ padding: 14 }} open>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>留存运行 · 换 Agent / 模型重跑 · 协作群讨论</summary>
        <p className="hint" style={{ marginTop: 8 }}>「留存运行」会把整条执行链保存下来并建立项目专属 Agents 协作群：指挥官分派、各阶段 Agent 执行、评审员审核，讨论自动回传到群。你可对任意阶段换 Agent / 模型后从该阶段重跑（已通过的前序阶段保留）。</p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
          <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>执行模式
            <select value={executorMode} onChange={(event) => setExecutorMode(event.target.value === 'real' ? 'real' : 'offline')}>
              <option value="offline">离线推演（不触达真实模型）</option>
              <option value="real">真实模型（自托管 gateway）</option>
            </select>
          </label>
          <button type="button" className="primary-btn" disabled={runBusy || !goal.trim()} onClick={() => void startPersisted()}>{runBusy ? '处理中…' : '运行并留存（进协作群）'}</button>
          <span className="hint">使用上方表单的标题 / 目标 / 子目标 / 模式 / 额度。真实模型需先在「供应商」配置并启动网关，否则会 fail-closed 拒绝。</span>
        </div>
        {runMessage && <p className="hint" role="status">{runMessage}</p>}

        {runs.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div className="card-title"><h3>已留存运行</h3><span className="hint">{runs.length} 条</span></div>
            {runs.map((item) => (
              <div className="detected-row" key={item.runId} style={{ alignItems: 'center' }}>
                <strong style={{ minWidth: 200 }}>{item.title}</strong>
                <span className="hint">{item.steps} 阶段 · {new Date(item.updatedAt).toLocaleString()}</span>
                {item.roomId && <span className="hint">协作群已建</span>}
                <button type="button" style={{ marginLeft: 'auto' }} onClick={() => void openRun(item.runId)} disabled={runBusy}>查看 / 改派</button>
              </div>
            ))}
          </div>
        )}

        {activeRun && (
          <div style={{ marginTop: 12 }}>
            <div className="card-title"><h3>{activeRun.view.title}</h3><Pill tone={STAGE_TONE[activeRun.view.stage]} label={STAGE_LABEL[activeRun.view.stage]} /><Pill tone={activeRun.view.executor === 'real' ? 'ok' : 'idle'} label={activeRun.view.executor === 'real' ? '真实模型' : '离线推演'} /><Pill tone={activeRun.view.reviewerKind === 'model' ? 'ok' : 'idle'} label={activeRun.view.reviewerKind === 'model' ? '模型评审' : '评测集评审'} /></div>
            <div className="crew-kpis" style={{ marginTop: 8 }}>
              <div><span>迭代</span><strong>{activeRun.view.iteration}</strong></div>
              <div><span>子目标</span><strong>{activeRun.view.steps.length}</strong></div>
              <div><span>已通过</span><strong>{activeRun.view.steps.filter((step) => step.status === 'passed').length}</strong></div>
              <div><span>额度</span><strong>{activeRun.view.spentMinor}/{activeRun.view.budgetMinor}</strong></div>
            </div>
            {activeRun.view.steps.map((step) => (
              <div key={step.stepId} className="status-card" style={{ padding: 12, marginTop: 10 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className="dm-dot" style={{ background: step.status === 'passed' ? 'var(--ok)' : step.status === 'failed' ? '#b03b3b' : '#c9c5bc' }} />
                  <strong>{step.title}</strong>
                  <span>{AGENT_LABEL[step.agent] ?? step.agent} · {step.providerId || '—'}/{step.modelId || '—'}</span>
                  {step.costTier && <Pill tone={COST_TONE[step.costTier] ?? 'idle'} label={'成本 ' + (COST_LABEL[step.costTier] ?? step.costTier)} />}
                  <Pill tone={STEP_TONE[step.status]} label={STEP_STATUS_LABEL[step.status]} />
                  <span className="hint">尝试 {step.attempts} 次</span>
                </div>
                {step.rationale && <p className="hint" style={{ margin: '4px 0 0' }}>分配理由：{step.rationale}</p>}
                {(step.discussion?.length ?? 0) > 0 && (
                  <div style={{ marginTop: 6, paddingLeft: 10, borderLeft: '2px solid rgba(120,120,120,0.2)', display: 'grid', gap: 3 }}>
                    {step.discussion!.map((line, index) => (
                      <div key={index} style={{ fontSize: 12 }}><b>{line.name}</b>：{line.text}</div>
                    ))}
                  </div>
                )}
                <ReassignControls
                  step={step} models={models} busy={runBusy}
                  onReassign={(agent, providerId, modelId) => void reassignStep(activeRun.runId, step.stepId, agent, providerId, modelId)}
                  onRerun={() => void rerunStep(activeRun.runId, step.stepId)}
                />
              </div>
            ))}
          </div>
        )}
      </details>

      {view && (
        <>
          <div className="status-card" style={{ padding: 14 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <strong style={{ fontSize: 15 }}>{view.title}</strong>
              <Pill tone={STAGE_TONE[view.stage]} label={STAGE_LABEL[view.stage]} />
              <span className="hint" style={{ marginLeft: 'auto' }}>架构师：{view.architect.planner === 'main-agent' ? '主 Agent 分派' : '平台规则'} · 评审员：{AGENT_LABEL[view.reviewer.agent] ?? view.reviewer.agent} · 评测项 {view.reviewer.checks}</span>
            </div>
            <div className="crew-kpis" style={{ marginTop: 10 }} aria-label="执行链指标">
              <div><span>迭代次数</span><strong>{view.iteration}</strong></div>
              <div><span>子目标</span><strong>{view.steps.length}</strong></div>
              <div><span>已通过</span><strong>{view.steps.filter((step) => step.status === 'passed').length}</strong></div>
              <div><span>额度</span><strong>{view.spentMinor}/{view.budgetMinor}</strong></div>
            </div>
            <div className="crew-progress" style={{ marginTop: 8 }}>
              <div className="crew-progress__track"><span style={{ width: Math.max(2, fmtPct(view.spentMinor, view.budgetMinor)) + '%' }} /></div>
              <small>额度消耗 {fmtPct(view.spentMinor, view.budgetMinor)}%</small>
            </div>
            {view.architect.notes.map((note) => <p className="hint" key={note}>{note}</p>)}
          </div>

          <div className="status-card" style={{ padding: 14 }}>
            <div className="card-title"><h3>子目标 · 执行与评审</h3><span className="hint">{view.steps.length} 个</span></div>
            {view.steps.map((step) => (
              <div className="detected-row" key={step.stepId} style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <span className="dm-dot" style={{ background: step.status === 'passed' ? 'var(--ok)' : step.status === 'failed' ? '#b03b3b' : '#c9c5bc', marginTop: 4 }} />
                <strong style={{ minWidth: 140 }}>{step.title}</strong>
                <span>{AGENT_LABEL[step.agent] ?? step.agent} · {step.providerId || '—'}/{step.modelId || '—'}</span>
                <span className="hint">尝试 {step.attempts} 次 · 返工上限 {step.maxReworks}</span>
                <Pill tone={STEP_TONE[step.status]} label={STEP_STATUS_LABEL[step.status]} />
                <span className="hint" style={{ flexBasis: '100%', marginLeft: 22 }}>
                  评测集：{step.contract.map((check) => checkText(check)).join(' · ')}
                  {step.lastReview && <> ；评审：<b style={{ color: step.lastReview.verdict === 'pass' ? '#1f7a4d' : '#b03b3b' }}>{step.lastReview.verdict === 'pass' ? '通过' : '不通过'}</b>{step.lastReview.reasons.length ? '（' + step.lastReview.reasons.join('、') + '）' : ''}</>}
                </span>
              </div>
            ))}
          </div>

          <div className="status-card" style={{ padding: 14 }}>
            <div className="card-title"><h3>评测报告</h3><span className="hint">评审员 · {AGENT_LABEL[view.reviewer.agent] ?? view.reviewer.agent}{report ? ' · 共 ' + report.total + ' 项（通过 ' + report.passed + ' / 未通过 ' + report.failed + '）' : ''}</span></div>
            <p className="hint">评测集由评审员为每个子目标生成；子 Agent 交付后逐条比对，全部通过才算过关，否则打回返工。这就是整条执行链的「验收/评测」环节。</p>
            {view.steps.map((step) => {
              const rows: EvalRow[] = step.lastReview
                ? step.lastReview.results.map((row) => ({ id: row.id, label: row.label, kind: row.kind, passed: row.passed, reason: row.reason }))
                : step.contract.map((check) => ({ id: check.id, label: check.label, kind: check.kind, passed: null }));
              return (
                <div key={step.stepId} style={{ marginTop: 12 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 13 }}>{step.title}</strong>
                    <Pill tone={STEP_TONE[step.status]} label={STEP_STATUS_LABEL[step.status]} />
                    <span className="hint" style={{ marginLeft: 'auto' }}>{step.lastReview ? '已评测 · 第 ' + step.lastReview.attempt + ' 次尝试' : '待执行 · 评测集 ' + step.contract.length + ' 项'}</span>
                  </div>
                  <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 6, fontSize: 12 }}>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.id} style={{ borderTop: '1px solid rgba(120,120,120,0.16)' }}>
                          <td style={{ width: 26, padding: '5px 0', textAlign: 'center' }}>{row.passed === null ? '•' : row.passed ? '✅' : '❌'}</td>
                          <td style={{ padding: '5px 8px' }}>{row.label ?? checkText({ kind: row.kind })}</td>
                          <td style={{ width: 96, color: '#888' }}>{row.kind}</td>
                          <td style={{ width: '34%', color: row.passed === false ? '#b03b3b' : '#888' }}>{row.reason ?? (row.passed === false ? '未通过' : row.passed === null ? '待评测' : '通过')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })}
          </div>

          <div className="status-card" style={{ padding: 14 }}>
            <div className="card-title"><h3>执行日志</h3><span className="hint">{view.events.length} 条</span></div>
            <ol style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
              {view.events.map((event, index) => (
                <li key={index} style={{ fontSize: 12 }}>
                  <b>[{event.actor}]</b> {event.text}
                  <span className="hint" style={{ marginLeft: 8 }}>{new Date(event.at).toLocaleTimeString()}</span>
                </li>
              ))}
            </ol>
          </div>

          <div className="status-card" style={{ padding: 14 }}>
            <div className="card-title"><h3>通知（{notify ? '已尝试推送' : '预览'}）</h3><span className="hint">{view.notifications.length} 条</span></div>
            {view.notifications.length === 0 && <p className="hint">本次没有需要打扰你的关键节点。</p>}
            {view.notifications.map((note, index) => (
              <div className="detected-row" key={index} style={{ alignItems: 'flex-start' }}>
                <Pill tone={note.event === 'pipeline.passed' ? 'ok' : note.event === 'pipeline.reviewer_reject_2' ? 'warn' : 'bad'} label={note.event} />
                <span style={{ flex: 1 }}>{note.text}</span>
                <span className="hint">→ {note.channelHint}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
