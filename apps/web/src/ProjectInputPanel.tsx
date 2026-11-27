import { useState } from 'react';
import type { FormEvent } from 'react';
import type { SessionView } from '@daming/contracts';

type SpecCheck = { kind: 'present' | 'json_equals'; expected?: unknown };
type SpecClause = { id: string; text: string; check?: SpecCheck };
type PlanStep = { stepId: string; description: string; dependsOn?: string[]; waives?: string[] };
type Frozen = {
  projectId: string; revision: number; runtimeRevision: number; status: 'frozen' | 'frozen_spec_precedence';
  acceptance: { id: string; text: string }[];
  conflicts: { clauseId: string; detail: string }[];
  naturalLanguage?: string; naturalLanguageIsAcceptance: false;
  requiresHumanArbitration: boolean; frozenAt: string;
};

const sampleSpec = JSON.stringify([{ id: 'goal', text: '交付可用构建' }, { id: 'perf', text: '响应 <200ms', check: { kind: 'json_equals', expected: { ok: true } } }], null, 2);
const sampleBaseline = JSON.stringify([{ stepId: 'build', description: '实现' }, { stepId: 'verify', description: '验证', dependsOn: ['build'] }], null, 2);

export function ProjectInputPanel({ session }: { session: SessionView }) {
  const [specText, setSpecText] = useState(sampleSpec);
  const [baselineText, setBaselineText] = useState(sampleBaseline);
  const [runtimeText, setRuntimeText] = useState('');
  const [naturalLanguage, setNaturalLanguage] = useState('');
  const [projectId, setProjectId] = useState('');
  const [frozen, setFrozen] = useState<Frozen | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const tenantId = session.identity?.tenantId;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setMessage('');
    void (async () => {
      let spec: SpecClause[]; let planBaseline: PlanStep[]; let planRuntime: PlanStep[] | undefined;
      try { spec = JSON.parse(specText) as SpecClause[]; } catch { throw new Error('spec 必须是合法 JSON 数组'); }
      try { planBaseline = JSON.parse(baselineText) as PlanStep[]; } catch { throw new Error('plan_baseline 必须是合法 JSON 数组'); }
      if (runtimeText.trim()) { try { planRuntime = JSON.parse(runtimeText) as PlanStep[]; } catch { throw new Error('plan_runtime 必须是合法 JSON 数组'); } }
      const response = await fetch('/api/project-input', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-daming-csrf': session.csrfToken },
        body: JSON.stringify({
          spec, planBaseline,
          ...(planRuntime ? { planRuntime } : {}),
          ...(naturalLanguage.trim() ? { naturalLanguage } : {}),
          ...(projectId.trim() ? { projectId: projectId.trim() } : {})
        })
      });
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) throw new Error(String(data.reason ?? 'project_input_rejected'));
      setFrozen(data.frozen as Frozen);
    })().catch((error) => setMessage(error instanceof Error ? error.message : '提交被拒绝')).finally(() => setBusy(false));
  };

  return (
    <section className="lulu-card" aria-label="项目四件套输入">
      <h3>项目四件套（spec + plan_baseline/plan_runtime + progress + 自然语言）</h3>
      <p className="hint">提交后冻结 spec 与 plan_baseline 为不可变版本并绑定 projectId + revision；plan_runtime 初始等于 baseline，之后由 Agent 与你沟通调整（不得降低 spec 验收）。progress 由 Agent 自写、阶段验收后清空。naturalLanguage 只裁剪范围，绝不作验收标准。当前租户：{tenantId ?? '（未登录）'}</p>
      <form onSubmit={submit}>
        <label>spec 大纲（JSON 数组，每项 id/text，可选 check）
          <textarea rows={5} value={specText} onChange={(e) => setSpecText(e.target.value)} />
        </label>
        <label>plan_baseline（初始存档，JSON 数组）
          <textarea rows={4} value={baselineText} onChange={(e) => setBaselineText(e.target.value)} />
        </label>
        <label>plan_runtime（可选；留空则等于 baseline）
          <textarea rows={3} value={runtimeText} onChange={(e) => setRuntimeText(e.target.value)} placeholder='[{"stepId":"build","description":"细化"}]' />
        </label>
        <label>自然语言指令（可选，仅范围/约束）
          <textarea rows={2} value={naturalLanguage} onChange={(e) => setNaturalLanguage(e.target.value)} />
        </label>
        <label>项目 ID（可选，留空自动生成）
          <input value={projectId} onChange={(e) => setProjectId(e.target.value)} placeholder="project-id" />
        </label>
        <button type="submit" disabled={busy}>提交并冻结</button>
      </form>
      {frozen && (
        <div>
          <h4>已冻结：{frozen.projectId} · spec rev {frozen.revision} · runtime rev {frozen.runtimeRevision} · {frozen.status}</h4>
          <p className="hint">验收来自 spec：{frozen.acceptance.map((criterion) => criterion.text).join('；')}</p>
          <p className="hint">naturalLanguage 作为验收：{frozen.naturalLanguageIsAcceptance ? '是' : '否'}</p>
          {frozen.conflicts.length > 0 && (
            <ul>{frozen.conflicts.map((conflict) => <li key={conflict.clauseId}>冲突（spec 为准）：{conflict.detail}</li>)}</ul>
          )}
        </div>
      )}
      {message && <p role="status" className="hint">{message}</p>}
    </section>
  );
}
