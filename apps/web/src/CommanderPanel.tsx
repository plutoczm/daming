import { useEffect, useMemo, useState } from 'react';
import type { AgentTarget, AvailableModelView, AvailableModelsView, ModelBindingView, SessionView } from '@daming/contracts';

const HARNESSES: readonly { id: AgentTarget; name: string }[] = [
  { id: 'dsh', name: 'DeepSeek Harness' },
  { id: 'codex', name: 'Codex' },
  { id: 'claude-code', name: 'Claude Code' },
];

interface ProjectRow { readonly projectId: string }

const STORAGE_PREFIX = 'daming.commander.';
interface CommanderChoice { readonly agent: AgentTarget; readonly providerId: string; readonly modelId: string }

function readChoice(projectId: string): CommanderChoice | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + projectId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CommanderChoice>;
    if (parsed.agent !== 'dsh' && parsed.agent !== 'codex' && parsed.agent !== 'claude-code') return null;
    if (typeof parsed.providerId !== 'string' || typeof parsed.modelId !== 'string') return null;
    return { agent: parsed.agent, providerId: parsed.providerId, modelId: parsed.modelId };
  } catch { return null; }
}

/**
 * 指挥官：用户选择默认 Agent 与模型，可按项目分别设置（项目内可自主更换）。
 * 保存时真正把该 Agent 的模型绑定写入 Host（tenant 作用域），并记下该项目偏好作为执行链默认指挥官。
 */
export function CommanderPanel({ session }: { session: SessionView }) {
  const [models, setModels] = useState<AvailableModelView[]>([]);
  const [bindings, setBindings] = useState<ModelBindingView[]>([]);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [projectId, setProjectId] = useState('');
  const [agent, setAgent] = useState<AgentTarget>('dsh');
  const [modelRef, setModelRef] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const canWrite = session.role === 'readwrite';

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [catalogRes, projectRes] = await Promise.all([
          fetch('/api/model-binding', { credentials: 'same-origin' }),
          fetch('/api/projects', { credentials: 'same-origin' }),
        ]);
        if (catalogRes.ok) {
          const data = await catalogRes.json() as { catalog?: AvailableModelsView; bindings?: ModelBindingView[] };
          if (active) { setModels([...(data.catalog?.models ?? [])]); setBindings([...(data.bindings ?? [])]); }
        }
        if (projectRes.ok) {
          const data = await projectRes.json() as { projects?: ProjectRow[] };
          if (active) setProjects(data.projects ?? []);
        }
      } catch { if (active) setMessage('暂时读不到供应商目录或项目列表'); }
    })();
    return () => { active = false; };
  }, [session.csrfToken]);

  useEffect(() => {
    if (!projectId) return;
    const saved = readChoice(projectId);
    if (saved) { setAgent(saved.agent); setModelRef(saved.providerId + '|||' + saved.modelId); }
  }, [projectId]);

  const dispatchable = useMemo(() => models.filter((model) => model.dispatchable), [models]);
  const activeBinding = (target: AgentTarget) => bindings.find((b) => b.agent === target && b.status === 'active' && b.scope.kind === 'tenant');

  const save = async () => {
    if (!canWrite || busy) return;
    if (!projectId) { setMessage('先选择一个项目'); return; }
    if (!modelRef) { setMessage('先为该指挥官选择模型'); return; }
    const [providerId, modelId] = modelRef.split('|||');
    setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/model-binding/bind', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-daming-csrf': session.csrfToken },
        body: JSON.stringify({ agent, modelId, scope: { kind: 'tenant' } }),
      });
      const data = await response.json().catch(() => ({})) as { reason?: string };
      if (!response.ok) throw new Error(String(data.reason ?? 'bind_failed'));
      const choice: CommanderChoice = { agent, providerId, modelId };
      try { localStorage.setItem(STORAGE_PREFIX + projectId, JSON.stringify(choice)); } catch { /* 本机偏好，失败忽略 */ }
      const label = HARNESSES.find((h) => h.id === agent)?.name ?? agent;
      setMessage(`已把项目「${projectId}」的指挥官设为 ${label} · ${modelId}，并写入模型绑定。`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '设置指挥官失败');
    } finally { setBusy(false); }
  };

  return (
    <section className="status-card commander-card" style={{ padding: 14 }} aria-label="指挥官">
      <div className="card-title">
        <h3>指挥官</h3>
        <span className="hint">默认 Agent 与模型，按项目分别设置；不同项目可自主更换</span>
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 10 }}>
        <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>项目
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">选择项目</option>
            {projects.map((project) => <option key={project.projectId} value={project.projectId}>{project.projectId}</option>)}
          </select>
        </label>
        <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>指挥官 Agent
          <select value={agent} onChange={(event) => setAgent(event.target.value as AgentTarget)}>
            {HARNESSES.map((harness) => (
              <option key={harness.id} value={harness.id}>
                {harness.name}{activeBinding(harness.id) ? `（已绑 ${activeBinding(harness.id)?.modelId}）` : '（未绑定）'}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>模型
          <select value={modelRef} onChange={(event) => setModelRef(event.target.value)} style={{ minWidth: 220 }}>
            <option value="">选择模型</option>
            {dispatchable.map((model) => (
              <option key={model.providerId + '|||' + model.modelId} value={model.providerId + '|||' + model.modelId}>
                {model.providerId}/{model.modelId}{model.quota.remainingPercent !== undefined ? ` · 剩余 ${model.quota.remainingPercent}%` : ''}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="primary-btn" onClick={() => void save()} disabled={!canWrite || busy || !projectId || !modelRef}>
          {busy ? '保存中…' : '设为该项目指挥官'}
        </button>
      </div>
      {!projects.length && <p className="hint" style={{ marginTop: 8 }}>还没有已接入项目：先在「项目」页接入 spec 与 plan_baseline，再指定指挥官。</p>}
      {message && <p className="hint" role="status" style={{ marginTop: 8 }}>{message}</p>}
    </section>
  );
}
