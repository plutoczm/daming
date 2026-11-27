import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  SessionView,
  WorkbenchProjectView,
  WorkbenchVerifyView,
  WorkbenchGitStatusView,
  WorkbenchCommitView,
  WorkbenchPushView
} from '@daming/contracts';

interface ProjectRow {
  readonly projectId: string;
  readonly directory: string;
  readonly revision: number;
  readonly status: string;
  readonly specCount: number;
  readonly planCount: number;
  readonly updatedAt: string;
}

export function ProjectsPanel({ session }: { session: SessionView }) {
  const [mode, setMode] = useState<'open' | 'upload'>('open');
  const [directory, setDirectory] = useState('');
  const [projectId, setProjectId] = useState('');
  const [specText, setSpecText] = useState('');
  const [baselineText, setBaselineText] = useState('');
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [wbView, setWbView] = useState<WorkbenchProjectView | null>(null);
  const [wbBusy, setWbBusy] = useState(false);
  const [wbNote, setWbNote] = useState('');
  const [wbSource, setWbSource] = useState('');
  const [gate, setGate] = useState<WorkbenchVerifyView | null>(null);
  const [git, setGit] = useState<WorkbenchGitStatusView | null>(null);
  const [commitMsg, setCommitMsg] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [repoToken, setRepoToken] = useState('');
  const [repoProvider, setRepoProvider] = useState<'github' | 'gitee'>('github');
  const [repoName, setRepoName] = useState('');
  const [repoPrivate, setRepoPrivate] = useState(true);
  const [gitNote, setGitNote] = useState('');
  const [gitBusy, setGitBusy] = useState(false);

  const load = async () => {
    try {
      const response = await fetch('/api/projects', { credentials: 'same-origin' });
      const data = await response.json().catch(() => ({})) as { projects?: ProjectRow[] };
      if (response.ok) setProjects(data.projects ?? []);
    } catch { /* list is best-effort */ }
  };
  useEffect(() => { void load(); }, [session.identity?.tenantId]);

  const removeProject = async (id: string) => {
    if (!window.confirm(`删除项目「${id}」？会移除它的 spec / plan / progress 记录，不可撤销。`)) return;
    try {
      const response = await fetch('/api/projects/' + encodeURIComponent(id), {
        method: 'DELETE', credentials: 'same-origin',
        headers: { 'x-daming-csrf': session.csrfToken }
      });
      if (!response.ok && response.status !== 404) throw new Error('删除失败（' + response.status + '）');
      if (wbView?.projectId === id) setWbView(null);
      setMessage('已删除项目 ' + id);
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : '删除失败'); }
  };

  const choose = async () => {
    const picked = await window.daming?.chooseDirectory?.({ create: false });
    if (picked) { setMode('open'); setDirectory(picked); }
    else if (!window.daming?.chooseDirectory) setMessage('当前不是桌面壳，请手动填写绝对路径。');
  };
  useEffect(() => {
    const openFolder = () => { setMode('open'); void choose(); };
    window.addEventListener('daming-open-folder', openFolder);
    return () => window.removeEventListener('daming-open-folder', openFolder);
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setMessage('');
    try {
      if (mode === 'upload') {
        if (!specText.trim() || !baselineText.trim()) throw new Error('请先选择 spec 与 plan_baseline 两个文件');
        const response = await fetch('/api/projects/intake-upload', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'x-daming-csrf': session.csrfToken },
          body: JSON.stringify({ projectId, specText, planBaselineText: baselineText })
        });
        const data = await response.json().catch(() => ({})) as Record<string, unknown>;
        if (!response.ok) throw new Error(String(data.reason ?? 'project_upload_failed'));
        setMessage('已上传并接入项目 ' + String(data.projectId) + '（spec ' + String(data.specCount) + ' 条 / baseline ' + String(data.planCount) + ' 步）。Progress.md 与功能清单已生成。');
        setSpecText(''); setBaselineText(''); setProjectId('');
        await load();
        await openWorkbench(String(data.projectId));
        return;
      }
      const response = await fetch('/api/projects/intake', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-daming-csrf': session.csrfToken },
        body: JSON.stringify({ mode, directoryPath: directory, ...(projectId.trim() ? { projectId: projectId.trim() } : {}) })
      });
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) throw new Error(String(data.reason ?? 'project_intake_failed'));
      if (data.needsFiles) {
        setMessage('目录已创建：' + String(data.directoryPath) + '。请把 spec.md 与 plan_baseline.md 放进去，再点「接入已有目录」。');
        setMode('open');
      } else {
        setMessage('已接入项目 ' + String(data.projectId) + '（spec ' + String(data.specCount) + ' 条 / baseline ' + String(data.planCount) + ' 步）。plan_runtime 与 progress 交给 Agent。');
      }
      setProjectId('');
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : '项目接入失败'); }
    finally { setBusy(false); }
  };

  const postWorkbench = async (id: string, action: 'expand' | 'advance', body?: Record<string, unknown>) => {
    const response = await fetch(`/api/workbench/projects/${id}/${action}`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-daming-csrf': session.csrfToken },
      body: JSON.stringify(body ?? {})
    });
    const data = await response.json().catch(() => ({})) as { view?: WorkbenchProjectView; reason?: string };
    if (!response.ok || !data.view) throw new Error(String(data.reason ?? 'workbench_action_failed'));
    setWbView(data.view);
  };

  const openWorkbench = async (id: string) => {
    setWbBusy(true); setWbNote('');
    try {
      const response = await fetch(`/api/workbench/projects/${id}`, { credentials: 'same-origin' });
      const data = await response.json().catch(() => ({})) as { view?: WorkbenchProjectView; reason?: string };
      if (!response.ok || !data.view) throw new Error(String(data.reason ?? 'workbench_load_failed'));
      setWbView(data.view);
      void loadGit(id);
    } catch (error) { setWbNote(error instanceof Error ? error.message : '读取工作台失败'); }
    finally { setWbBusy(false); }
  };

  const expandPhase = async () => {
    if (!wbView) return;
    setWbBusy(true); setWbNote('');
    try { await postWorkbench(wbView.projectId, 'expand'); setWbNote('已让指挥官把当前阶段展开成 JSON 功能清单。'); }
    catch (error) { setWbNote(error instanceof Error ? error.message : '展开失败'); }
    finally { setWbBusy(false); }
  };

  const advancePhase = async () => {
    if (!wbView) return;
    if (!window.confirm('确认本阶段已完成？将清空 Progress.md 并进入下一阶段。')) return;
    setWbBusy(true); setWbNote('');
    try {
      await postWorkbench(wbView.projectId, 'advance');
      setWbNote('本阶段完成，Progress.md 已清空并进入下一阶段。');
    } catch (error) { setWbNote(error instanceof Error ? error.message : '推进失败'); }
    finally { setWbBusy(false); }
  };

  const loadGit = async (id: string) => {
    try {
      const response = await fetch(`/api/workbench/projects/${id}/git`, { credentials: 'same-origin' });
      const data = await response.json().catch(() => ({})) as { status?: WorkbenchGitStatusView };
      if (response.ok && data.status) {
        setGit(data.status);
        const saved = data.status.configuredRemote || data.status.remoteUrl || '';
        if (saved) setRepoUrl((prev) => prev || saved);
      }
    } catch { /* best-effort */ }
  };

  const saveRepoUrl = async () => {
    if (!wbView) return;
    setGitBusy(true); setGitNote('');
    try {
      const url = repoUrl.trim();
      await postGit(wbView.projectId, 'remote', { repoUrl: url });
      setGitNote(url ? `已保存仓库地址：${url}` : '已清除仓库地址');
      await loadGit(wbView.projectId);
    } catch (error) { setGitNote(error instanceof Error ? error.message : '保存失败'); }
    finally { setGitBusy(false); }
  };

  const postGit = async (id: string, action: 'workspace' | 'verify' | 'commit' | 'push' | 'remote' | 'create-repo', body: Record<string, unknown>) => {
    const response = await fetch(`/api/workbench/projects/${id}/${action}`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-daming-csrf': session.csrfToken },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(String(data.reason ?? 'workbench_git_failed'));
    return data;
  };

  const createRemoteRepo = async () => {
    if (!wbView) return;
    const name = repoName.trim();
    if (!name) { setGitNote('先填仓库名（如 my-project）'); return; }
    setGitBusy(true); setGitNote('');
    try {
      const data = await postGit(wbView.projectId, 'create-repo', { provider: repoProvider, name, private: repoPrivate });
      const repo = data.repo as { cloneUrl?: string; htmlUrl?: string } | undefined;
      const remote = data.remote as { repoUrl?: string } | undefined;
      if (remote?.repoUrl) setRepoUrl(remote.repoUrl);
      setGitNote(`已创建 ${repoProvider} 仓库并绑定：${repo?.cloneUrl ?? remote?.repoUrl ?? ''}`);
      await loadGit(wbView.projectId);
    } catch (error) { setGitNote('建仓失败：' + (error instanceof Error ? error.message : 'unknown')); }
    finally { setGitBusy(false); }
  };

  const prepareWorkspace = async () => {
    if (!wbView) return;
    setGitBusy(true); setGitNote('');
    try {
      const data = await postGit(wbView.projectId, 'workspace', { sourceDir: wbSource.trim() || undefined });
      const ws = data.workspace as { workspaceDir?: string; fileCount?: number } | undefined;
      setGitNote(`工作目录已设定：${ws?.workspaceDir ?? ''}（${ws?.fileCount ?? 0} 个文件，就地执行不复制）`);
      await loadGit(wbView.projectId);
    } catch (error) { setGitNote(error instanceof Error ? error.message : '设定工作目录失败'); }
    finally { setGitBusy(false); }
  };

  const runVerify = async () => {
    if (!wbView) return;
    setGitBusy(true); setGitNote('');
    try {
      const data = await postGit(wbView.projectId, 'verify', {});
      setGate((data.verify as WorkbenchVerifyView) ?? null);
      const ok = (data.verify as WorkbenchVerifyView | undefined)?.passed;
      setGitNote(ok ? '验证门通过 ✅' : '验证门未通过（见下方逐项结果）');
    } catch (error) { setGitNote(error instanceof Error ? error.message : '运行验证门失败'); }
    finally { setGitBusy(false); }
  };

  const doCommit = async () => {
    if (!wbView) return;
    setGitBusy(true); setGitNote('');
    try {
      const data = await postGit(wbView.projectId, 'commit', { message: commitMsg.trim() || undefined });
      const commit = data.commit as WorkbenchCommitView | undefined;
      setGitNote(commit?.committed ? `已提交 ${commit.hash ?? ''}：${commit.message ?? ''}` : `未提交：${commit?.reason ?? '无改动'}`);
      await loadGit(wbView.projectId);
    } catch (error) { setGitNote(error instanceof Error ? error.message : '提交失败'); }
    finally { setGitBusy(false); }
  };

  const doPush = async () => {
    if (!wbView) return;
    setGitBusy(true); setGitNote('');
    try {
      const payload: Record<string, string> = { repoName: wbView.projectId };
      if (repoUrl.trim()) payload.repoUrl = repoUrl.trim();
      if (repoToken.trim()) payload.token = repoToken.trim();
      const data = await postGit(wbView.projectId, 'push', payload);
      const push = data.push as WorkbenchPushView | undefined;
      setGitNote(push?.ok ? `已推送：${push.remoteUrl ?? ''}` : `未推送：${push?.reason ?? ''}${push?.hint ? ' · ' + push.hint : ''}`);
      await loadGit(wbView.projectId);
    } catch (error) { setGitNote(error instanceof Error ? error.message : '推送失败'); }
    finally { setGitBusy(false); }
  };

  const readFiles = async (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      const text = await file.text();
      if (/plan[_-]?baseline/i.test(file.name)) setBaselineText(text);
      else setSpecText(text);
    }
  };

  return (
    <section className="page-stack projects-page" aria-label="项目">
      <header className="page-head">
        <div>
          <p className="eyebrow">PROJECTS / INTAKE</p>
          <h2>项目</h2>
          <p className="hint">项目开始时只接收两样东西：用户放入的 <code>spec.md</code> 与 <code>plan_baseline.md</code>。plan_runtime 和 progress 由执行 Agent 维护。</p>
        </div>
      </header>

      <div className="project-intake-grid">
        <article className={`intake-card ${mode === 'open' ? 'selected' : ''}`} onClick={() => setMode('open')}>
          <span className="intake-icon" aria-hidden="true">▦</span>
          <h3>接入已有项目目录</h3>
          <p>选择一个已经放好 `spec.md` 与 `plan_baseline.md` 的项目目录。</p>
          <button type="button" className="link-btn" onClick={(event) => { event.stopPropagation(); setMode('open'); }}>选择这个方式</button>
        </article>
        <article className={`intake-card ${mode === 'upload' ? 'selected' : ''}`} onClick={() => setMode('upload')}>
          <span className="intake-icon" aria-hidden="true">⇪</span>
          <h3>上传 spec / plan_baseline</h3>
          <p>直接选择两个文件；Host 会保存到受管项目目录并登记，plan_runtime 与 progress 由 Agent 维护。</p>
          <button type="button" className="link-btn" onClick={(event) => { event.stopPropagation(); setMode('upload'); }}>选择这个方式</button>
        </article>
      </div>

      <form className="intake-form" onSubmit={submit}>
        {mode === 'upload' ? (
          <>
            <label>spec.md / spec.json
              <input type="file" accept=".md,.markdown,.json,text/plain,application/json" onChange={(event) => void readFiles(event.target.files)} />
              {specText && <span className="hint">已读取 {specText.length} 字符</span>}
            </label>
            <label>plan_baseline.md / plan_baseline.json
              <input type="file" accept=".md,.markdown,.json,text/plain,application/json" onChange={(event) => void readFiles(event.target.files)} />
              {baselineText && <span className="hint">已读取 {baselineText.length} 字符</span>}
            </label>
          </>
        ) : (
          <label>项目目录（绝对路径）
            <div className="path-row">
              <input value={directory} onChange={(event) => setDirectory(event.target.value)} placeholder="D:\\Projects\\my-project" required />
              <button type="button" className="ghost-btn" onClick={() => void choose()}>选择目录</button>
            </div>
          </label>
        )}
        <label>项目 ID（可选，留空自动生成）
          <input value={projectId} onChange={(event) => setProjectId(event.target.value)} placeholder="my-project" />
        </label>
        <button type="submit" className="primary-btn" disabled={busy}>{busy ? '处理中…' : mode === 'upload' ? '上传并接入' : '接入已有目录'}</button>
      </form>

      {message && <p className="hint" role="status">{message}</p>}

      <div className="project-list">
        {projects.map((project) => (
          <article className="project-row" key={project.projectId}>
            <span className="project-mark" aria-hidden="true">▦</span>
            <div className="project-main">
              <strong>{project.projectId}</strong>
              <span>{project.directory}</span>
            </div>
            <div className="project-meta">
              <span>spec {project.specCount}</span>
              <span>baseline {project.planCount}</span>
              <span className="state-pill state-ok">rev {project.revision} · {project.status}</span>
              <button type="button" className="link-btn" onClick={() => void openWorkbench(project.projectId)}>打开工作台</button>
              {session.role === 'readwrite' && (
                <button type="button" className="link-btn danger" onClick={() => void removeProject(project.projectId)}>删除</button>
              )}
            </div>
          </article>
        ))}
        {!projects.length && <p className="hint">还没有接入项目。先选择上面的任一方式。</p>}
      </div>

      {wbView && (
        <article className="lulu-card workbench" aria-label="项目工作台">
          <header className="workbench-head">
            <div>
              <h3>{wbView.projectId} · 项目工作台</h3>
              <p className="hint">
                {wbView.done
                  ? '全部阶段已完成 🎉'
                  : `当前阶段 ${wbView.currentPhaseIndex + 1}/${wbView.phases.length}：${wbView.currentPhase?.title ?? '—'}`}
                {' · spec '}{wbView.specCount}{' 条 / 计划 '}{wbView.planCount}{' 阶段'}
              </p>
              <p className="hint">{wbView.directoryPath}</p>
            </div>
            <div className="workbench-actions">
              <button type="button" className="ghost-btn" disabled={wbBusy || wbView.done} onClick={() => void expandPhase()}>展开当前阶段为功能清单</button>
              <button type="button" className="primary-btn" disabled={wbBusy || wbView.done} onClick={() => void advancePhase()}>完成本阶段 → 下一阶段</button>
            </div>
          </header>
          {wbNote && <p className="hint" role="status">{wbNote}</p>}

          <ol className="wb-phases">
            {wbView.phases.map((phase, index) => (
              <li key={phase.phaseId} className={`wb-phase ${phase.status} ${index === wbView.currentPhaseIndex ? 'current' : ''}`}>
                <span className="wb-phase-idx">{index + 1}</span>
                <span className="wb-phase-title">{phase.title}</span>
                <span className={`state-pill ${phase.status === 'done' ? 'state-ok' : phase.status === 'doing' ? 'state-busy' : ''}`}>
                  {phase.status === 'done' ? '已完成' : phase.status === 'doing' ? '进行中' : '待开始'}
                </span>
              </li>
            ))}
          </ol>

          <div className="wb-columns">
            <section className="wb-col">
              <h4>Progress.md（只记录当前阶段）</h4>
              <pre className="wb-pre">{wbView.progressMarkdown || '（空）'}</pre>
            </section>
            <section className="wb-col">
              <h4>功能清单 JSON{wbView.featuresPhaseId ? ` · ${wbView.featuresPhaseId}` : ''}</h4>
              {wbView.features.length ? (
                <ul className="wb-features">
                  {wbView.features.map((feature) => (
                    <li key={feature.id}>
                      <code>{feature.id}</code>
                      <span>{feature.title}</span>
                      <span className="state-pill">{feature.status}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="hint">还没有功能清单。点上面的「展开当前阶段为功能清单」。</p>
              )}
            </section>
          </div>

          <section className="wb-bphase" aria-label="B 阶段：验证门与 Git">
            <h4>B 阶段 · 验证门 / Git（就地执行，不复制）</h4>
            <p className="hint">直接在工作目录里让 Agent 跑 lint/typecheck/test 等项目脚本，通过后再提交。推送：填好仓库地址（可「保存地址」记住），令牌留空则用「设置 → Git 身份」里一次性验证过的平台账号。</p>
            <div className="wb-brow">
              <input value={wbSource} onChange={(event) => setWbSource(event.target.value)} placeholder="工作目录（绝对路径；留空=使用项目目录）" />
              <button type="button" className="ghost-btn" disabled={gitBusy} onClick={() => void prepareWorkspace()}>设定工作目录</button>
            </div>
            <div className="wb-brow">
              <button type="button" className="ghost-btn" disabled={gitBusy} onClick={() => void runVerify()}>运行验证门</button>
              <input value={commitMsg} onChange={(event) => setCommitMsg(event.target.value)} placeholder="提交信息（可留空）" />
              <button type="button" className="ghost-btn" disabled={gitBusy} onClick={() => void doCommit()}>提交</button>
            </div>
            <div className="wb-brow">
              <span className="hint">新建远程仓库（用平台身份，免去网页手动建）：</span>
              <select value={repoProvider} onChange={(event) => setRepoProvider(event.target.value === 'gitee' ? 'gitee' : 'github')}>
                <option value="github">GitHub</option>
                <option value="gitee">Gitee</option>
              </select>
              <input value={repoName} onChange={(event) => setRepoName(event.target.value)} placeholder="仓库名（如 my-project）" style={{ flex: '0 1 220px' }} />
              <label className="hint" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                <input type="checkbox" checked={repoPrivate} onChange={(event) => setRepoPrivate(event.target.checked)} />私有
              </label>
              <button type="button" className="ghost-btn" disabled={gitBusy} onClick={() => void createRemoteRepo()}>创建并绑定</button>
            </div>
            <div className="wb-brow">
              <input value={repoUrl} onChange={(event) => setRepoUrl(event.target.value)} placeholder="上传仓库地址（如 https://github.com/you/repo.git 或 https://gitee.com/you/repo.git）" style={{ flex: '1 1 320px' }} />
              <button type="button" className="ghost-btn" disabled={gitBusy} onClick={() => void saveRepoUrl()}>保存地址</button>
              <input value={repoToken} onChange={(event) => setRepoToken(event.target.value)} type="password" placeholder="令牌（可留空=用平台身份）" style={{ flex: '0 1 180px' }} />
              <button type="button" className="primary-btn" disabled={gitBusy} onClick={() => void doPush()}>推送</button>
            </div>
            {gitNote && <p className="hint" role="status">{gitNote}</p>}
            {git && (
              <p className="hint">
                仓库：{git.isRepo ? `${git.branch ?? '?'}` : '未初始化'} · {git.dirty ? '有改动' : '干净'}
                {git.remoteUrl ? ` · ${git.remoteUrl}` : ' · 无远程'}
                {git.lastCommit ? ` · 最近提交 ${git.lastCommit}` : ''}
              </p>
            )}
            {gate && (
              <ul className="wb-gates">
                {gate.results.map((row) => (
                  <li key={row.script} className={row.ok ? 'ok' : 'fail'}>
                    <span className="wb-gate-name">{row.ok ? '✅' : '❌'} {row.script}</span>
                    <span className="wb-gate-meta">{row.ms}ms · exit {row.code ?? '?'}</span>
                    {!row.ok && row.outputTail && <pre className="wb-pre wb-gate-out">{row.outputTail}</pre>}
                  </li>
                ))}
                {!gate.results.length && <li className="fail"><span className="wb-gate-name">未检测到可运行的验证脚本</span><span className="wb-gate-meta">{gate.note ?? ''}</span></li>}
              </ul>
            )}
          </section>
        </article>
      )}
    </section>
  );
}
