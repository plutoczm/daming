import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { SessionView, TaskSummaryView, TaskDetailView } from '@daming/contracts';
import { PaidAgentBrokerPanel } from './PaidAgentBrokerPanel.tsx';

export function TenantTasks({ session }: { session: SessionView }) {
  const [tasks, setTasks] = useState<TaskSummaryView[]>([]);
  const [selected, setSelected] = useState<TaskDetailView | null>(null);
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [isolatedText, setIsolatedText] = useState('');
  const [isolatedProof, setIsolatedProof] = useState<{
    networkBlocked: true; windowsDrivesHidden: true; homeHidden: true;
    hostConfigHidden: true; unprivileged: true; ephemeralFilesystem: true;
    inspectedCharacters: number; paidDispatchPermitted: false; modelCallsEnabled: false
  } | null>(null);
  const [dockerProof, setDockerProof] = useState<{
    runtime: string; containerIsolated: true; networkBlocked: true;
    rootReadonly: true; windowsDrivesHidden: true; hostSecretsHidden: true;
    paidDispatchPermitted: false; chargedMinor: number
  } | null>(null);
  const [paidReadiness, setPaidReadiness] = useState<{
    dockerOfflineIsolationVerified: boolean; productionPaidAgentReady: false;
    paidDispatchPermitted: false; blockers: string[]
  } | null>(null);
  const tenantId = session.identity?.tenantId;
  const refresh = async () => {
    const response = await fetch('/api/tasks', { credentials: 'same-origin' });
    if (!response.ok) throw new Error('tenant_tasks_unavailable');
    setTasks((await response.json() as { tasks: TaskSummaryView[] }).tasks);
  };
  useEffect(() => {
    setTasks([]); setSelected(null); setError(''); setIsolatedProof(null); setIsolatedText('');
    setDockerProof(null); setPaidReadiness(null);
    void refresh().catch(() => setError('当前租户任务读取失败'));
  }, [tenantId]);
  const open = async (id: string) => {
    try {
      const response = await fetch('/api/tasks/' + encodeURIComponent(id));
      if (!response.ok) throw new Error('task_not_found');
      setSelected(await response.json() as TaskDetailView);
    } catch { setSelected(null); setError('无法读取本租户以外的任务'); }
  };
  const create = (event: FormEvent) => {
    event.preventDefault();
    if (session.role !== 'readwrite') return;
    setBusy(true); setError('');
    void (async () => {
      try {
        const response = await fetch('/api/tasks', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-Daming-CSRF': session.csrfToken },
          body: JSON.stringify({ title, goal, mode: 'fixture' })
        });
        if (!response.ok) throw new Error('tenant_task_create_rejected');
        const body = await response.json() as { taskId: string };
        await refresh(); await open(body.taskId);
        setTitle(''); setGoal('');
      } catch { setError('创建任务失败：仅支持本租户离线演示任务'); }
      finally { setBusy(false); }
    })();
  };

  return (
    <section className="lulu-card" aria-label="租户隔离的离线任务">
      <h2>本租户任务</h2>
      <p className="hint">此处仅运行内置离线规则演示，不调用真实模型、插件或其他租户的工作空间。</p>
      {session.role === 'readwrite' && <form onSubmit={create}>
        <label>任务标题
          <input required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} />
        </label>
        <label>任务目标
          <textarea required maxLength={2000} value={goal} onChange={e => setGoal(e.target.value)} />
        </label>
        <button type="submit" disabled={busy || !title.trim() || !goal.trim()}>
          创建本租户离线任务
        </button>
      </form>}
      {session.role === 'readwrite' && <form onSubmit={event => {
        event.preventDefault();
        setBusy(true); setError(''); setIsolatedProof(null);
        void (async () => {
          try {
            const result = await fetch('/api/identity/sandbox/inspect', {
              method: 'POST', credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json',
                'X-Daming-CSRF': session.csrfToken },
              body: JSON.stringify({ text: isolatedText })
            });
            if (!result.ok) throw new Error('isolation_unavailable');
            setIsolatedProof(await result.json());
          } catch { setError('WSL2 隔离进程未通过验证，执行已拒绝。'); }
          finally { setBusy(false); }
        })();
      }}>
        <h3>独立 Linux 离线沙箱校验</h3>
        <p className="hint">每次执行启动新的 Bubblewrap 进程，不挂载 Windows 磁盘，不联网，不能访问模型或插件。</p>
        <label>待检查文本（只做字符统计）
          <textarea required maxLength={2048} value={isolatedText}
            onChange={e => setIsolatedText(e.target.value)} />
        </label>
        <button disabled={busy || !isolatedText.trim()} type="submit">运行隔离检查</button>
      </form>}
      {session.role === 'readwrite' && session.identity?.memberRole === 'owner' && <div>
        <h3>付费 Agent 执行环境和准入验证</h3>
        <p className="hint">使用本机 Docker Desktop Linux 运行固定离线 Agent；容器不联网、不加载 API Key，也不扣费。验证通过不代表已授权真实模型调用。</p>
        <button type="button" disabled={busy} onClick={() => {
          setError('');
          void (async () => {
            try {
              const response = await fetch('/api/identity/agent-runtime/readiness');
              if (!response.ok) throw new Error('readiness');
              setPaidReadiness(await response.json());
            } catch { setError('付费 Agent 准入检查失败'); }
          })();
        }}>检查账号、预算和付费准入条件</button>
        <form onSubmit={event => {
          event.preventDefault();
          setBusy(true); setError(''); setDockerProof(null);
          void (async () => {
            try {
              const response = await fetch('/api/identity/agent-runtime/probe', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json',
                  'X-Daming-CSRF': session.csrfToken },
                body: JSON.stringify({ text: isolatedText })
              });
              if (!response.ok) throw new Error('docker_runtime');
              setDockerProof(await response.json());
              const readiness = await fetch('/api/identity/agent-runtime/readiness');
              if (readiness.ok) setPaidReadiness(await readiness.json());
            } catch { setError('Docker 隔离执行探针未通过，真实付费派工仍被禁止'); }
            finally { setBusy(false); }
          })();
        }}>
          <p className="hint">使用上方离线文本作为输入，不会执行其中的命令。</p>
          <button type="submit" disabled={busy || !isolatedText.trim()}>运行 Docker Agent 隔离验证</button>
        </form>
        {dockerProof && <p className="hint" role="status">
          Docker 隔离通过：网络阻断、宿主密钥不可见、根文件系统只读；本次外部付费 {dockerProof.chargedMinor} 分。
        </p>}
        {paidReadiness && <div className="hint" role="status">
          <strong>付费 Agent 自动派工：未开放。</strong>
          <p>Docker 隔离探针：{paidReadiness.dockerOfflineIsolationVerified ? '近期通过' : '未通过或已过期'}。</p>
          <p>剩余条件：{paidReadiness.blockers.join('；')}。</p>
        </div>}
      </div>}
      {isolatedProof && <p className="hint" role="status">
        沙箱已验证：网络被阻断、Windows 盘和宿主配置不可见、非特权用户、临时文件系统隔离。
        已检查 {isolatedProof.inspectedCharacters} 字符；真实模型调用和付费派工均未启用。
      </p>}
      <button type="button" disabled={busy} onClick={() => void refresh().catch(() =>
        setError('刷新失败'))}>刷新任务</button>
      {error && <p role="alert" className="hint">{error}</p>}
      <ul>
        {tasks.map(task => <li key={task.taskId}>
          <button type="button" onClick={() => void open(task.taskId)}>
            {task.title} · {task.status}
          </button>
        </li>)}
      </ul>
      {selected && <div>
        <h3>{selected.title}</h3>
        <p className="hint">状态：{selected.status} · 已归属当前租户</p>
        <p>{selected.goal}</p>
      </div>}
      {session.role === 'readwrite' && session.identity?.memberRole === 'owner' &&
        session.mfaEnabled && <PaidAgentBrokerPanel session={session}/>}
    </section>
  );
}
