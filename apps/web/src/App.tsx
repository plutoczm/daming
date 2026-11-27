import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { IdentityPanel } from './IdentityPanel.tsx';
import { TenantTasks } from './TenantTasks.tsx';
import { ProjectsPanel } from './ProjectsPanel.tsx';
import { ProvidersPanel } from './ProvidersPanel.tsx';
import { AgentsPanel } from './AgentsPanel.tsx';
import { NotificationsPanel } from './NotificationsPanel.tsx';
import { CrewPanel } from './CrewPanel.tsx';
import { PipelinePanel } from './PipelinePanel.tsx';
import { AgentRoomPanel } from './AgentRoomPanel.tsx';
import { UnifiedInbox } from './UnifiedInbox.tsx';
import { CommanderPanel } from './CommanderPanel.tsx';
import { GatewayObservabilityPanel } from './GatewayObservabilityPanel.tsx';
import { MaskingPanel } from './MaskingPanel.tsx';
import { RoutingGraphPanel } from './RoutingGraphPanel.tsx';
import { PlatformStatusPanel } from './PlatformStatusPanel.tsx';
import { SettingsPanel } from './SettingsPanel.tsx';
import { HelpPanel } from './HelpPanel.tsx';
import { notifyRefresh, useAdaptiveResource, useLiveConnection } from './live-refresh.ts';
import { useCountUp, usePointerSheen, useScrollProgress, useScrollReveal } from './motion.ts';
import { Icon } from './icons.tsx';
import type { IconName } from './icons.tsx';
import { useTheme } from './theme.ts';
import { ThemeSegments } from './ThemeSegments.tsx';
import { TaskBoard } from './TaskBoard.tsx';
import { ToastViewport, useToasts } from './Toast.tsx';
import { RealCodexPanel, TaskDetail } from './TaskDetailView.tsx';
import { STATUS_LABELS, money, shortId } from './format.ts';
import { useFocusTrap } from './focus.ts';
import type {
  AutoloopStateView, CreateTaskResult, DeepSeekBalanceView, LuluStatusView, LuluSubmitView, MagpieOperationView, MagpiePreparationView, MagpieReadView, MagpieStatusView, RealCodexRunView, SessionView, TaskDeliveryView, ProjectPreviewView, ProjectAgentStatusView, ProjectPricingView, PortfolioDigestView, TaskDetailView,
  TaskSummaryView
} from '@daming/contracts';

// Left-rail information architecture, modelled after T3 Code's control plane,
// HiFox's task/inbox workspace and Magpie's grouped settings sidebar.
type NavItem = { id: string; label: string; icon: IconName };
const NAV_SECTIONS: ReadonlyArray<{ group: string; items: ReadonlyArray<NavItem> }> = [
  { group: '工作区', items: [
    { id: 'overview', label: '总览', icon: 'overview' },
    { id: 'inbox', label: '收件箱', icon: 'inbox' },
    { id: 'projects', label: '项目', icon: 'projects' }
  ] },
  { group: '运行', items: [
    { id: 'providers', label: '供应商', icon: 'providers' },
    { id: 'agents', label: 'Agent', icon: 'agents' },
    { id: 'routing', label: '路由', icon: 'routing' },
    { id: 'pipeline', label: '执行链', icon: 'crew' },
    { id: 'room', label: '协作群', icon: 'crew' }
  ] },
  { group: '系统', items: [
    { id: 'gateway', label: '网关观测', icon: 'gateway' },
    { id: 'masking', label: '脱敏', icon: 'gateway' },
    { id: 'notifications', label: '通知', icon: 'notifications' },
    { id: 'platform', label: '平台状态', icon: 'platform' }
  ] }
];
const NAV_FLAT: ReadonlyArray<NavItem> = NAV_SECTIONS.flatMap((group) => group.items);

type LocalQuotaCard = {
  provider: string; name: string; plan: string; user: string; checkedAt: string;
  windows: { name: string; used: number; remainingPercent: number; resetsAt?: string; display?: string }[];
};

const LIVE_LABELS: Record<string, string> = { connecting: '连接中', live: '实时', fallback: '轮询兜底', paused: '后台暂停' };

// A date line instead of an English eyebrow: the overview should feel like
// today's desk, not a dashboard template.
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function todayLabel(): string {
  const now = new Date();
  return `${now.getMonth() + 1} 月 ${now.getDate()} 日 · ${WEEKDAYS[now.getDay()]}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    let reason = `HTTP ${response.status}`;
    try {
      const body = await response.json() as { reason?: string };
      reason = body.reason ?? reason;
    } catch {
      // keep the status-based reason
    }
    throw new Error(reason);
  }
  return await response.json() as T;
}

export function App() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [tasks, setTasks] = useState<TaskSummaryView[]>([]);
  const [portfolio, setPortfolio] = useState<PortfolioDigestView | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetailView | null>(null);
  const [title, setTitle] = useState('整理本周研究');
  const [goal, setGoal] = useState('汇总本周资料，形成一份可复核的研究摘要。');
  const [runMode, setRunMode] = useState<'fixture' | 'local' | 'project' | 'real' | 'dsh'>('local');
  const [projectFilePaths, setProjectFilePaths] = useState('apps/server/src/task-board.ts');
  const [projectStatus, setProjectStatus] = useState<ProjectAgentStatusView | null>(null);
  const [projectPricing, setProjectPricing] = useState<ProjectPricingView | null>(null);
  const [projectPreview, setProjectPreview] = useState<ProjectPreviewView | null>(null);
  const [projectError, setProjectError] = useState('');
  const [localDelivery, setLocalDelivery] = useState<TaskDeliveryView | null>(null);
  const [localDeliveryError, setLocalDeliveryError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [activeSection, setActiveSection] = useState<string>(() => {
    const hash = window.location.hash.replace(/^#/, '');
    return hash && (NAV_FLAT.some((item) => item.id === hash) || hash === 'settings' || hash === 'help') ? hash : 'overview';
  });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [viewFlash, setViewFlash] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLElement | null>(null);
  const paletteRef = useRef<HTMLDivElement | null>(null);
  const { toasts, push: pushToast, dismiss: dismissToast } = useToasts();
  const { preference: themePreference, setPreference: setThemePreference } = useTheme();
  const [localQuotaCards, setLocalQuotaCards] = useState<LocalQuotaCard[]>([]);
  const [luluStatus, setLuluStatus] = useState<LuluStatusView | null>(null);
  const [deepseekBalance, setDeepseekBalance] = useState<DeepSeekBalanceView | null>(null);
  const [magpieStatus, setMagpieStatus] = useState<MagpieStatusView | null>(null);
  const [magpieSnapshot, setMagpieSnapshot] = useState<Record<string, MagpieReadView> | null>(null);
  const [magpieOperations, setMagpieOperations] = useState<MagpieOperationView[]>([]);
  const [magpieBusy, setMagpieBusy] = useState('');
  const [magpieError, setMagpieError] = useState('');
  const [autoloop, setAutoloop] = useState<AutoloopStateView | null>(null);
  const [autoloopBusy, setAutoloopBusy] = useState(false);
  const [autoloopAgent, setAutoloopAgent] = useState('echo');
  const [luluPlatform, setLuluPlatform] = useState('wechat');
  const [luluConversation, setLuluConversation] = useState('local-demo');
  const [luluMessage, setLuluMessage] = useState('对方说：周末有空吗？');
  const [luluBusy, setLuluBusy] = useState(false);
  const [luluResult, setLuluResult] = useState<LuluSubmitView | null>(null);
  const [codexPrompt, setCodexPrompt] = useState('回复 OK。不要运行命令，不要修改文件。');
  const [codexRunId, setCodexRunId] = useState<string | null>(null);
  const [codexRun, setCodexRun] = useState<RealCodexRunView | null>(null);
  const [codexBusy, setCodexBusy] = useState(false);
  const sharedView = !!session && (!session.identity || session.identity.rootAdministrator);
  const localMode = session?.localMode === true;
  const liveConnection = useLiveConnection(sharedView);
  const changeSession = (next: SessionView | null) => {
    setSession(next); setTasks([]); setSelectedId(null); setDetail(null); setError('');
  };
  const withViewTransition = (update: () => void) => {
    const doc = document as Document & { startViewTransition?: (callback: () => void) => void };
    if (typeof doc.startViewTransition === 'function') doc.startViewTransition(update);
    else update();
  };
  const openTaskDrawer = (taskId: string) => {
    withViewTransition(() => { setSelectedId(taskId); setDrawerOpen(true); });
  };
  const closeTaskDrawer = () => {
    withViewTransition(() => setDrawerOpen(false));
  };
  const jumpTo = (id: string) => {
    withViewTransition(() => {
      setActiveSection(id);
      setPaletteOpen(false);
      setPaletteQuery('');
      setViewFlash(true);
    });
    window.setTimeout(() => setViewFlash(false), 460);
    requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };
  // Dialogs own the keyboard while open: focus moves in, Tab stays inside, Esc closes
  // and focus returns to the control that opened it.
  useFocusTrap(drawerOpen, drawerRef, { onClose: closeTaskDrawer, initialFocus: '.drawer-close' });
  useFocusTrap(paletteOpen, paletteRef, { onClose: () => setPaletteOpen(false), initialFocus: 'input' });

  // Command palette (Ctrl/Cmd+K), the fast jump layer T3 Code and DSH both use.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Hash routing: keeps deep links and remote pages stable across reloads.
  useEffect(() => {
    const onHash = () => {
      const hash = window.location.hash.replace(/^#/, '');
      if (hash && (NAV_FLAT.some((item) => item.id === hash) || hash === 'settings' || hash === 'help')) setActiveSection(hash);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    if (window.location.hash !== '#' + activeSection) window.history.replaceState(null, '', '#' + activeSection);
  }, [activeSection]);

  // Native application menu actions (File / View / Help / Settings).
  useEffect(() => {
    const off = window.daming?.onMenu?.((payload) => {
      if (payload.action === 'navigate' && payload.page) setActiveSection(payload.page);
      else if (payload.action === 'settings') setActiveSection('settings');
      else if (payload.action === 'help') setActiveSection('help');
      else if (payload.action === 'open-folder') {
        setActiveSection('projects');
        window.dispatchEvent(new CustomEvent('daming-open-folder'));
      }
    });
    return () => { if (off) off(); };
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const current = await request<SessionView>('/api/session');
        if (active) setSession(current);
      } catch {
        if (active) setError('未认证：请使用 pnpm start:web 打印的带 token 链接打开任务板。');
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!session) return;
    let active = true;
    void fetch('/api/magpie/local-quotas', { credentials: 'same-origin' })
      .then((response) => response.ok ? response.json() : { cards: [] })
      .then((data: { cards?: LocalQuotaCard[] }) => { if (active) setLocalQuotaCards(data.cards ?? []); })
      .catch(() => { if (active) setLocalQuotaCards([]); });
    return () => { active = false; };
  }, [session?.csrfToken]);

  useAdaptiveResource({
    enabled: sharedView, identity: 'project-status', scope: 'tasks', intervalMs: 120000,
    fetcher: (signal) => request<ProjectAgentStatusView>('/api/project/status', { signal }),
    onData: setProjectStatus,
    onError: () => setProjectStatus(null)
  });
  useAdaptiveResource({
    enabled: sharedView, identity: 'project-pricing', scope: 'tasks', intervalMs: 3600000,
    fetcher: (signal) => request<ProjectPricingView>('/api/project/pricing', { signal }),
    onData: setProjectPricing,
    onError: () => setProjectPricing(null)
  });

  useAdaptiveResource({
    enabled: sharedView, identity: 'tasks-list', scope: 'tasks',
    intervalMs: () => tasks.some((task) => ['queued', 'running', 'reviewing'].includes(task.status)) ? 10000 : 20000,
    fetcher: (signal) => request<{ tasks: TaskSummaryView[] }>('/api/tasks', { signal }),
    onData: (data) => {
      setTasks(data.tasks);
      setSelectedId((current) => current ?? data.tasks[0]?.taskId ?? null);
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : '任务列表加载失败')
  });

  useAdaptiveResource({
    enabled: sharedView, identity: 'portfolio-digest', scope: 'portfolio', scopes: ['tasks', 'missions'], intervalMs: 60000,
    fetcher: (signal) => request<PortfolioDigestView>('/api/portfolio/digest', { signal }),
    onData: setPortfolio,
    onError: () => setPortfolio(null)
  });

  useAdaptiveResource({
    enabled: sharedView, identity: 'lulu-status', scope: 'lulu', intervalMs: 30000,
    fetcher: (signal) => request<LuluStatusView>('/api/lulu/status', { signal }),
    onData: setLuluStatus,
    onError: () => setLuluStatus(null)
  });

  useAdaptiveResource({
    enabled: sharedView, identity: 'deepseek-balance', scope: 'magpie', intervalMs: 120000,
    fetcher: (signal) => request<DeepSeekBalanceView>('/api/deepseek/balance', { signal }),
    onData: setDeepseekBalance,
    onError: () => setDeepseekBalance(null)
  });

  useAdaptiveResource({
    enabled: sharedView, identity: 'magpie-status', scope: 'magpie', intervalMs: 30000,
    fetcher: (signal) => request<MagpieStatusView>('/api/magpie/status', { signal }),
    onData: setMagpieStatus,
    onError: () => setMagpieStatus(null)
  });

  useAdaptiveResource({
    enabled: sharedView && !!magpieStatus?.configured, identity: 'magpie-snapshot', scope: 'magpie',
    intervalMs: 90000,
    fetcher: async (signal) => {
      // The management view uses only these four read APIs; avoid polling unused endpoints.
      const aliases = ['models', 'providers', 'quotas', 'plugins'] as const;
      const results = await Promise.allSettled(aliases.map(async (alias) =>
        [alias, await request<MagpieReadView>(`/api/magpie/read/${alias}`, { signal })] as const
      ));
      const entries = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
      return entries.length ? Object.fromEntries(entries) : null;
    },
    onData: (snapshot) => setMagpieSnapshot((previous) => snapshot ? { ...previous, ...snapshot } : previous),
    onError: () => undefined
  });

  useAdaptiveResource({
    enabled: sharedView, identity: 'magpie-receipts', scope: 'magpie',
    intervalMs: 30000,
    fetcher: (signal) => request<{ operations: MagpieOperationView[] }>('/api/magpie/operations', { signal }),
    onData: (data) => setMagpieOperations(data.operations),
    onError: () => undefined
  });

  useAdaptiveResource({
    enabled: sharedView, identity: 'autoloop-state', scope: 'autoloop',
    intervalMs: () => autoloop?.totals.running ? 5000 : 20000,
    fetcher: (signal) => request<AutoloopStateView>('/api/autoloop/state', { signal }),
    onData: setAutoloop,
    onError: () => setAutoloop(null)
  });

  useEffect(() => { setDetail(null); setLocalDelivery(null); setLocalDeliveryError(''); setProjectPreview(null); setProjectError(''); }, [selectedId]);

  useAdaptiveResource({
    enabled: sharedView && !!selectedId, identity: selectedId ?? '', scope: 'tasks',
    intervalMs: () => detail && ['queued', 'running', 'reviewing'].includes(detail.status) ? 2500 : 15000,
    fetcher: (signal) => request<TaskDetailView>(`/api/tasks/${encodeURIComponent(selectedId!)}`, { signal }),
    onData: (current) => setDetail((previous) =>
      previous && JSON.stringify(previous) === JSON.stringify(current) ? previous : current
    ),
    onError: () => setDetail(null)
  });

  useAdaptiveResource({
    enabled: sharedView && !!codexRunId && (!codexRun || codexRun.status === 'running'),
    identity: codexRunId ?? '', scope: 'codex', intervalMs: 2500,
    fetcher: (signal) => request<RealCodexRunView>(`/api/real/codex/${encodeURIComponent(codexRunId!)}`, { signal }),
    onData: (current) => {
      setCodexRun(current);
      if (current.status !== 'running') setCodexBusy(false);
    },
    onError: (cause) => {
      setCodexBusy(false);
      setError(cause instanceof Error ? cause.message : 'Codex 执行读取失败');
    }
  });

  useAdaptiveResource({
    enabled: sharedView && !!selectedId && detail?.status === 'completed' && detail?.plan?.category === 'task7-local-delivery',
    identity: selectedId ?? '', scope: 'tasks', intervalMs: 60000,
    fetcher: (signal) => request<TaskDeliveryView>(`/api/tasks/${encodeURIComponent(selectedId!)}/delivery`, { signal }),
    onData: (artifact) => { setLocalDelivery(artifact); setLocalDeliveryError(''); },
    onError: (cause) => { setLocalDelivery(null); setLocalDeliveryError(cause instanceof Error ? cause.message : '交付验证失败'); }
  });

  useAdaptiveResource({
    enabled: sharedView && !!selectedId && detail?.status === 'completed' && detail?.plan?.category === 'task8-project-agent-preview',
    identity: selectedId ?? '', scope: 'tasks', intervalMs: 60000,
    fetcher: (signal) => request<ProjectPreviewView>(`/api/tasks/${encodeURIComponent(selectedId!)}/project-preview`, { signal }),
    onData: (preview) => { setProjectPreview(preview); setProjectError(''); },
    onError: (cause) => { setProjectPreview(null); setProjectError(cause instanceof Error ? cause.message : '项目副本核验失败'); }
  });

  const stats = useMemo(() => ({
    running: tasks.filter((task) => ['queued', 'running', 'reviewing'].includes(task.status)).length,
    completed: tasks.filter((task) => task.status === 'completed').length,
    blocked: tasks.filter((task) => task.status === 'blocked').length
  }), [tasks]);
  const inboxTasks = useMemo(
    () => tasks.filter((task) => ['awaiting_approval', 'reviewing', 'blocked'].includes(task.status)),
    [tasks]
  );
  const pendingDecisions = inboxTasks.length + (portfolio?.totals.needsYou ?? 0);
  const activeAgentCount = autoloop?.agents.length ?? 3;
  const paletteItems = NAV_FLAT.filter((item) =>
    !paletteQuery.trim() || item.label.includes(paletteQuery.trim()) || item.id.includes(paletteQuery.trim().toLowerCase())
  );
  const scrollProgress = useScrollProgress();
  usePointerSheen();
  const contentRef = useScrollReveal<HTMLDivElement>([tasks.length, session?.csrfToken, activeSection]);
  const pendingDisplay = useCountUp(pendingDecisions);
  const tasksDisplay = useCountUp(tasks.length);
  const agentsDisplay = useCountUp(activeAgentCount);
  const platformProviders = magpieSnapshot?.providers?.items ?? [];
  const selectedTask = tasks.find((task) => task.taskId === selectedId) ?? null;

  useEffect(() => {
    if (error) pushToast(error, 'bad');
  }, [error, pushToast]);

  const createTask = async (event: FormEvent) => {
    event.preventDefault();
    if (!session || session.role !== 'readwrite') return;
    setBusy(true);
    setError('');
    try {
      const result = await request<CreateTaskResult>('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Daming-CSRF': session.csrfToken },
        body: JSON.stringify({ title, goal, mode: runMode,
          ...(runMode === 'project' ? { filePaths: projectFilePaths.split(/\r?\n/).map((item) => item.trim()).filter(Boolean), limitMinor: 200 } : {})
        })
      });
      setSelectedId(result.taskId);
      setDrawerOpen(true);
      pushToast('任务已创建：' + result.taskId.slice(0, 8), 'ok');
      notifyRefresh('tasks');
      setTitle('');
      setGoal('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建任务失败');
    } finally {
      setBusy(false);
    }
  };

  const runMagpieAction = async (action: string, body: Record<string, unknown> = {}) => {
    if (!session || session.role !== 'readwrite' || magpieBusy || !magpieStatus?.configured) return;
    const confirmation = action === 'plugin-update'
      ? '将下载并执行第三方插件更新，可能修改本机文件。确认这次操作吗？'
      : action === 'plugin-add' ? '确认安装第三方 npm 插件 ' + String(body.spec) + '？请确保信任其来源。'
      : action === 'plugin-toggle' ? (body.off ? '确认停用插件 ' : '确认启用插件 ') + String(body.spec) + '？'
      : action === 'workbuddy-checkin' ? '将向已有 WorkBuddy 账号发起真实签到，结果可能含验证码要求。确认执行吗？'
      : action === 'refresh-quotas' ? '确认请求供应商刷新额度数据吗？'
      : '确认执行 ' + action + ' 吗？';
    if (!window.confirm(confirmation)) return;
    setMagpieBusy(action);
    setMagpieError('');
    try {
      const prepared = await request<MagpiePreparationView>(`/api/magpie/operations/prepare/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Daming-CSRF': session.csrfToken },
        body: JSON.stringify(body)
      });
      const receipt = await request<MagpieOperationView>(`/api/magpie/operations/${prepared.operation.id}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Daming-CSRF': session.csrfToken },
        body: JSON.stringify({ approvalToken: prepared.approvalToken })
      });
      if (receipt.status === 'unknown' || receipt.status === 'executing') {
        setMagpieError('操作结果未确认；已保存回执。请先核对供应商状态，不要重复操作。');
      } else if (receipt.status === 'partial' || receipt.status === 'failed' || receipt.status === 'needs_attention') {
        setMagpieError('操作返回部分成功、失败或需要人工处理，详情见下方回执。');
      } else if (receipt.status === 'cancelled') {
        setMagpieError('Windows 本机授权已拒绝，本次没有向供应商发送操作。');
      } else if (receipt.status === 'no_accounts') {
        setMagpieError('本次没有可签到账号，未产生领取结果。');
      }
    } catch (cause) {
      setMagpieError((cause instanceof Error ? cause.message : 'Magpie 操作失败') + '。可查看下方回执核实是否已执行。');
    } finally {
      notifyRefresh('magpie');
      setMagpieBusy('');
    }
  };

  const reconcileMagpieOperation = async (id: string, resolution: 'succeeded' | 'not_executed') => {
    if (!session || session.role !== 'readwrite') return;
    const evidence = window.prompt('请先在供应商/插件后台核对，然后写下核验依据（不要输入密钥或账号信息）：');
    if (!evidence || evidence.trim().length < 8) return;
    if (!window.confirm(resolution === 'succeeded' ? '确认外部操作已经执行成功？' : '确认外部操作确实没有执行？')) return;
    try {
      await request(`/api/magpie/operations/${id}/reconcile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Daming-CSRF': session.csrfToken },
        body: JSON.stringify({ resolution, evidence })
      });
      pushToast('人工核验已提交', 'ok');
      notifyRefresh('magpie');
    } catch (cause) {
      setMagpieError(cause instanceof Error ? cause.message : '人工核验提交失败');
    }
  };

  const triggerAutoloop = async () => {
    if (!session || session.role !== 'readwrite' || autoloopBusy) return;
    setAutoloopBusy(true);
    setError('');
    try {
      const selected = autoloop?.agents.find((agent) => agent.id === autoloopAgent);
      const type = selected && selected.use !== 'echo' ? `task.requested.${selected.use}` : 'task.requested';
      await request('/api/autoloop/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Daming-CSRF': session.csrfToken },
        body: JSON.stringify({ id: `ui-${Date.now()}`, type, subject: 'task-board', summary: `任务板触发的 Autoloop 事件（${selected?.name ?? 'Echo 演示 Agent'}）` })
      });
      pushToast('Autoloop 事件已触发', 'ok');
      notifyRefresh('autoloop');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Autoloop 事件触发失败');
    } finally {
      setAutoloopBusy(false);
    }
  };

  const submitLulu = async (event: FormEvent) => {
    event.preventDefault();
    if (!session || session.role !== 'readwrite' || luluBusy) return;
    setLuluBusy(true);
    setError('');
    setLuluResult(null);
    try {
      const result = await request<LuluSubmitView>('/api/lulu/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Daming-CSRF': session.csrfToken },
        body: JSON.stringify({ platform: luluPlatform, conversationId: luluConversation, message: luluMessage })
      });
      setLuluResult(result);
      pushToast('Lulu 提交：' + result.status, result.status === 'completed' ? 'ok' : 'warn');
      notifyRefresh('lulu');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Lulu 提交失败');
    } finally {
      setLuluBusy(false);
    }
  };

  const approveTask = async () => {
    if (!session || session.role !== 'readwrite' || !selectedId) return;
    setError('');
    try {
      await request(`/api/tasks/${encodeURIComponent(selectedId)}/approve`, {
        method: 'POST', headers: { 'X-Daming-CSRF': session.csrfToken }
      });
      pushToast('任务已批准，进入执行/验收', 'ok');
      notifyRefresh('tasks');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '批准任务失败');
    }
  };

  const cancelTask = async () => {
    if (!session || session.role !== 'readwrite' || !selectedId) return;
    try {
      await request(`/api/tasks/${encodeURIComponent(selectedId)}/cancel`, {
        method: 'POST', headers: { 'X-Daming-CSRF': session.csrfToken }
      });
      pushToast('任务已取消', 'info');
      notifyRefresh('tasks');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '取消任务失败');
    }
  };

  const decidePortfolio = async (itemId: string, action: 'approve' | 'reject' | 'defer') => {
    if (!session || session.role !== 'readwrite') return;
    setError('');
    try {
      await request('/api/portfolio/decide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Daming-CSRF': session.csrfToken },
        body: JSON.stringify({ itemId, action })
      });
      pushToast(action === 'approve' ? '已批准并结案' : action === 'reject' ? '已驳回' : '已稍后', 'ok');
      notifyRefresh('portfolio');
      notifyRefresh('tasks');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '组合项操作失败');
    }
  };

  const startCodex = async (event: FormEvent) => {
    event.preventDefault();
    if (!session || session.role !== 'readwrite') return;
    setCodexBusy(true);
    setError('');
    try {
      const result = await request<{ runId: string }>('/api/real/codex', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Daming-CSRF': session.csrfToken },
        body: JSON.stringify({ prompt: codexPrompt })
      });
      setCodexRunId(result.runId);
      setCodexRun(null);
      pushToast('Codex 已启动', 'ok');
      notifyRefresh('codex');
    } catch (cause) {
      setCodexBusy(false);
      setError(cause instanceof Error ? cause.message : 'Codex 启动失败');
    }
  };

  if (!session) {
    return (
      <main className="login-page">
        <div className="login-card">
          <p className="eyebrow">DAMING / LOCAL HOST</p>
          <h1>大铭任务板</h1>
          <p>{error || '正在验证持久身份…'}</p>
          <IdentityPanel session={session} onAuthenticated={changeSession} />
        </div>
      </main>
    );
  }

  if (session.identity && !session.mfaEnabled) {
    return <main className="login-page"><div className="login-card">
      <h1>启用多因素认证</h1>
      <IdentityPanel session={session} onAuthenticated={changeSession} />
    </div></main>;
  }

  // Invited tenant members are intentionally kept away from the legacy
  // global task, plugin and Magpie admin surfaces until those are tenant-aware.
  if (session.identity && !session.identity.rootAdministrator) {
    return <main className="login-page"><div className="login-card">
      <h1>我的租户空间</h1>
      <IdentityPanel session={session} onAuthenticated={changeSession} />
      <TenantTasks session={session} />
      <p className="hint">跨租户全局任务板、插件后台和真实模型执行仍由本机根管理员独立控制。</p>
    </div></main>;
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <aside className="app-rail" aria-label="主导航">
        <div className="rail-brand">
          <img className="rail-logo" src="/brand/mark-256.png" alt="" aria-hidden="true" />
          <div><b>daming</b></div>
        </div>
        <nav className="rail-nav-wrap">
          {NAV_SECTIONS.map((group) => (
            <div className="rail-group-wrap" key={group.group}>
              <div className="rail-group">{group.group}</div>
              <div className="rail-nav">
                {group.items.map((item) => (
                  <button type="button" key={item.id}
                    className={activeSection === item.id ? 'active' : ''}
                    aria-current={activeSection === item.id ? 'page' : undefined}
                    onClick={() => jumpTo(item.id)}>
                    <Icon name={item.icon} className="ic" />
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>
        <div className="rail-foot">
          <div className="rail-actions">
            <button type="button" onClick={() => jumpTo('settings')}><Icon name="settings" className="ic" />设置</button>
            <button type="button" onClick={() => jumpTo('help')}><Icon name="help" className="ic" />帮助</button>
          </div>
          <div className="rail-version">
            <span className={`dot ${liveConnection === 'live' ? 'ok' : liveConnection === 'paused' ? 'warn' : 'idle'}`} />
            {liveConnection === 'live' ? '实时同步' : '轮询兜底'}
          </div>
        </div>
      </aside>

      <div className="app-main">
        <div className="scroll-progress" aria-hidden="true"><span style={{ transform: `scaleX(${scrollProgress})` }} /></div>
        <header className="topbar">
          <div className="topbar-title">
            <nav className="topbar-crumb" aria-label="位置">
              <span className="crumb-brand">大铭</span>
              <span className="crumb-sep" aria-hidden="true">/</span>
              <h1>{activeSection === 'overview' ? '总览' : (NAV_FLAT.find((item) => item.id === activeSection)?.label ?? (activeSection === 'settings' ? '设置' : activeSection === 'help' ? '帮助' : '总览'))}</h1>
            </nav>
          </div>
        </header>

        <main id="main-content" ref={contentRef} className={`app-content ${viewFlash ? 'view-flash' : ''}`} tabIndex={-1}>
          {error && <div className="error-banner" role="alert">{error}</div>}
          {!localMode && <IdentityPanel session={session} onAuthenticated={changeSession} />}
          {activeSection === 'overview' && (
          <section id="overview" className="overview" aria-label="总览" data-reveal>
            <div className="aurora" aria-hidden="true"><span /><span /><span /></div>
            <div className="overview-head">
              <div>
                <p className="page-kicker"><span className="kicker-dot" aria-hidden="true" />{todayLabel()}</p>
                <h2>今天的运行面</h2>
                <p className="page-lede">Agent 在后台推进；只有需要你拍板的事会进收件箱。</p>
              </div>
            </div>
            <div className="kpi-grid">
              <div className="kpi accent">
                <span className="label">待拍板</span>
                <div className="value">{pendingDisplay}</div>
                <span className="delta">收件箱 · 审批 / 验收 / 阻塞</span>
              </div>
              <div className="kpi">
                <span className="label">任务总数</span>
                <div className="value">{tasksDisplay}</div>
                <span className="delta">进行中 {stats.running} · 已完成 {stats.completed}</span>
              </div>
              <div className="kpi">
                <span className="label">Agent</span>
                <div className="value">{agentsDisplay}</div>
                <span className="delta">可用 Runtime · DSH / Codex / Claude</span>
              </div>
              <div className="kpi">
                <span className="label">实时状态</span>
                <div className="value kpi-inline"><span className={`dot ${liveConnection === 'live' ? 'ok' : liveConnection === 'paused' ? 'warn' : 'idle'}`} />{liveConnection === 'live' ? '实时' : liveConnection === 'paused' ? '暂停' : '兜底'}</div>
                <span className="delta">网关 {magpieStatus?.configured ? '已连接' : '未连接'} · DeepSeek {deepseekBalance?.available ? '可用' : '未知'}</span>
              </div>
            </div>
            <div className="overview-cols">
              <div className="inbox-card" id="inbox">
                <div className="card-title">
                  <h3>收件箱 <span className="count">{inboxTasks.length}</span></h3>
                  <button type="button" className="link-btn" onClick={() => jumpTo('projects')}>查看全部项目</button>
                </div>
                <ul className="inbox-list">
                  {inboxTasks.slice(0, 6).map((task) => (
                    <li key={task.taskId}>
                      <button type="button" className="inbox-item" onClick={() => openTaskDrawer(task.taskId)}>
                        <span className={`status-pill status-${task.status}`}>{STATUS_LABELS[task.status]}</span>
                        <span className="inbox-title">{task.title}</span>
                        <span className="inbox-id">{shortId(task.taskId)}</span>
                      </button>
                    </li>
                  ))}
                  {!inboxTasks.length && (
                    <li className="inbox-empty inbox-empty--art">
                      <svg viewBox="0 0 44 44" width="44" height="44" aria-hidden="true">
                        <defs>
                          <linearGradient id="inbox-halo" x1="0" y1="0" x2="1" y2="1">
                            <stop offset="0" stopColor="#eef0ff" />
                            <stop offset="1" stopColor="#e0f7fb" />
                          </linearGradient>
                        </defs>
                        <circle cx="22" cy="22" r="21" fill="url(#inbox-halo)" stroke="#d9dcff" strokeWidth="1" />
                        <circle cx="22" cy="22" r="14" fill="none" stroke="#a5b4fc" strokeWidth="1.4" />
                        <path d="M15 22.5l4.6 4.6L29.5 17" fill="none" stroke="#4f46e5" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      <span>没有需要拍板的事，Agent 正在后台推进。</span>
                    </li>
                  )}
                </ul>
                <div className="inbox-foot">
                  <span><b>{stats.completed}</b>已完成</span>
                  <span><b>{stats.running}</b>进行中</span>
                  <span><b>{inboxTasks.length}</b>待拍板</span>
                </div>
              </div>
              <div className="status-card">
                <div className="card-title"><h3>运行面</h3></div>
                <div className="status-rows">
                  <div className="status-row"><span><span className={`dot ${liveConnection === 'live' ? 'ok' : 'warn'}`} />实时流</span><strong>{LIVE_LABELS[liveConnection] ?? liveConnection}</strong></div>
                  <div className="status-row"><span><span className={`dot ${magpieStatus?.configured ? 'ok' : 'idle'}`} />模型网关</span><strong>{magpieStatus?.configured ? '已连接' : magpieStatus?.running ? '运行中' : '不可用'}</strong></div>
                  <div className="status-row"><span><span className={`dot ${deepseekBalance?.available ? 'ok' : 'idle'}`} />DeepSeek 余额</span><strong>{deepseekBalance?.available ? money(deepseekBalance.totalMinor) : '—'}</strong></div>
                  <div className="status-row"><span><span className={`dot ${luluStatus?.health === 'online' ? 'ok' : 'idle'}`} />Lulu</span><strong>{luluStatus?.enabled ? (luluStatus.health === 'online' ? '在线' : '不可用') : '未配置'}</strong></div>
                </div>
              </div>
            </div>
            <div className="overview-quick" aria-label="快捷入口">
              {[
                { id: 'inbox', icon: 'inbox' as IconName, label: '收件箱', sub: `${inboxTasks.length} 待拍板` },
                { id: 'projects', icon: 'projects' as IconName, label: '项目', sub: `spec + 计划 · ${tasks.length} 任务` },
                { id: 'providers', icon: 'providers' as IconName, label: '供应商', sub: '模型与额度' },
                { id: 'agents', icon: 'agents' as IconName, label: 'Agent', sub: 'DSH / Codex / Claude' },
                { id: 'pipeline', icon: 'crew' as IconName, label: '执行链', sub: '指挥官·评审·返工' },
                { id: 'room', icon: 'crew' as IconName, label: '协作群', sub: 'Agent 工作群' },
                { id: 'notifications', icon: 'notifications' as IconName, label: '通知', sub: '飞书 / 微信 / Webhook' },
                { id: 'gateway', icon: 'gateway' as IconName, label: '网关观测', sub: '请求与上下文' }
              ].map((q) => (
                <button type="button" className="quick-tile" key={q.id} onClick={() => jumpTo(q.id)}>
                  <span className="quick-ic" aria-hidden="true"><Icon name={q.icon} /></span>
                  <span className="quick-tx"><strong>{q.label}</strong><em>{q.sub}</em></span>
                  <span className="quick-arrow" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h13" /><path d="M12 5l7 7-7 7" /></svg>
                  </span>
                </button>
              ))}
            </div>
          </section>
          )}

          {activeSection === 'inbox' && (
            <UnifiedInbox
              digest={portfolio}
              tasks={inboxTasks}
              canWrite={session.role === 'readwrite'}
              onDecide={(id, action) => { void decidePortfolio(id, action); }}
              onOpenTask={openTaskDrawer}
            />
          )}

          {activeSection === 'gateway' && (
            <GatewayObservabilityPanel session={session} />
          )}

          {activeSection === 'masking' && (
            <MaskingPanel session={session} />
          )}

          {activeSection === 'routing' && (
            <RoutingGraphPanel session={session} />
          )}

          {activeSection === 'projects' && (
          <>
          <ProjectsPanel session={session} />
          <section className="layout tasks-layout" id="projects" data-reveal aria-label="项目工作区">
        <aside className="sidebar">
          <div className="lulu-card balance-card">
            <div className="lulu-card-title"><span className="eyebrow">GATEWAY</span><strong>模型网关</strong></div>
            <p className="hint">供应商、模型、账号与额度都在「平台状态」统一查看与管理；网关由大铭自持。</p>
            <button type="button" className="ghost-btn" onClick={() => jumpTo('platform')}>打开平台状态</button>
          </div>
          <div className={`lulu-card balance-card ${deepseekBalance?.available ? 'lulu-online' : ''}`}>
            <div className="lulu-card-title">
              <span className="eyebrow">DEEPSEEK BALANCE</span>
              <strong>{deepseekBalance ? (deepseekBalance.available ? '官方余额可用' : '余额不可用') : '查询中…'}</strong>
            </div>
            {deepseekBalance?.totalMinor !== null && deepseekBalance?.totalMinor !== undefined && (
              <p className="hint">总余额 {money(deepseekBalance.totalMinor)} · 赠送 {money(deepseekBalance.grantedMinor)} · 充值 {money(deepseekBalance.toppedUpMinor)}</p>
            )}
            {deepseekBalance?.reason && <p className="hint">原因：{deepseekBalance.reason}</p>}
          </div>
          <div className={`lulu-card ${luluStatus?.health === 'online' ? 'lulu-online' : ''}`}>
            <div className="lulu-card-title">
              <span className="eyebrow">LULU</span>
              <strong>{luluStatus?.enabled ? (luluStatus.health === 'online' ? 'Lulu 在线' : 'Lulu 不可用') : 'Lulu 未配置'}</strong>
            </div>
            {luluStatus?.fastModel && <p className="hint">对话模型：{luluStatus.fastModel}</p>}
            {luluStatus?.memoryModel && <p className="hint">记忆模型：{luluStatus.memoryModel}</p>}
            {luluStatus?.reason && <p className="hint">原因：{luluStatus.reason}</p>}
            <form className="lulu-submit-form" onSubmit={submitLulu}>
              <label htmlFor="lulu-platform">平台</label>
              <input id="lulu-platform" value={luluPlatform} onChange={(event) => setLuluPlatform(event.target.value)} maxLength={40} disabled={session.role !== 'readwrite' || luluBusy || !luluStatus?.enabled} />
              <label htmlFor="lulu-conversation">会话 ID</label>
              <input id="lulu-conversation" value={luluConversation} onChange={(event) => setLuluConversation(event.target.value)} maxLength={200} disabled={session.role !== 'readwrite' || luluBusy || !luluStatus?.enabled} />
              <label htmlFor="lulu-message">对方消息</label>
              <textarea id="lulu-message" value={luluMessage} onChange={(event) => setLuluMessage(event.target.value)} rows={3} maxLength={4000} disabled={session.role !== 'readwrite' || luluBusy || !luluStatus?.enabled} />
              <button type="submit" disabled={session.role !== 'readwrite' || luluBusy || !luluStatus?.enabled}>{luluBusy ? '提交中…' : '提交到 Lulu（本人批准）'}</button>
              {luluResult && (
                <div className={`lulu-result lulu-result-${luluResult.status}`}>
                  <strong>{luluResult.status}</strong>
                  {luluResult.reason && <span> · {luluResult.reason}</span>}
                  {luluResult.evidence !== undefined && <pre>{JSON.stringify(luluResult.evidence, null, 2)}</pre>}
                </div>
              )}
            </form>
          </div>
          <form className="codex-card" onSubmit={startCodex}>
            <div className="codex-card__head">
              <span className="eyebrow">CODEX REAL</span>
              <span className={`mini-status ${codexRun?.status === 'completed' ? 'ok' : codexRun?.status === 'failed' ? 'bad' : ''}`}>{codexRun ? codexRun.status : 'read-only probe'}</span>
            </div>
            <p className="hint">真实 Codex 只读探针，临时工作目录，不修改文件。</p>
            <textarea value={codexPrompt} onChange={(event) => setCodexPrompt(event.target.value)} rows={3} maxLength={60000} disabled={session.role !== 'readwrite' || codexBusy} />
            <button type="submit" disabled={session.role !== 'readwrite' || codexBusy}>{codexBusy ? 'Codex 执行中…' : '运行真实 Codex'}</button>
          </form>
          <form className="create-card" onSubmit={createTask}>
            <div className="section-title">新建任务</div>
            <label htmlFor="task-title">标题</label>
            <input id="task-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} disabled={session.role !== 'readwrite' || busy} />
            <label htmlFor="task-goal">目标</label>
            <textarea id="task-goal" value={goal} onChange={(event) => setGoal(event.target.value)} maxLength={2000} rows={4} disabled={session.role !== 'readwrite' || busy} />
            <label htmlFor="task-mode">Agent / 执行方式</label>
            <select id="task-mode" value={runMode} onChange={(event) => setRunMode(event.target.value as 'fixture' | 'local' | 'project' | 'real' | 'dsh')} disabled={session.role !== 'readwrite' || busy}>
              <option value="local">本地交付（真实文件，规则型 Worker）</option>
              <option value="real">真实 Codex（只读）</option>
              <option value="dsh">真实 DSH（只读，DeepSeek）</option>
            </select>
            {runMode === 'local' && <p className="hint">需要手动审批；只写入大铭隔离目录的固定报告文件，不调用模型、不联网。它是真实的本地文件交付，不是模拟。</p>}
            <button type="submit" disabled={session.role !== 'readwrite' || busy}>{busy ? '创建中…' : '创建待审批任务'}</button>
            {session.role !== 'readwrite' && <p className="hint">当前为只读会话，不能创建任务。</p>}
          </form>

        </aside>

        <section className="board-pane" aria-label="任务看板区域">
          <TaskBoard tasks={tasks} selectedId={selectedId} onSelect={openTaskDrawer} />
        </section>
      </section>
          </>
          )}

          {activeSection === '__legacy_platform' && (
            <section className="page-stack" id="platform-legacy" data-reveal>
              <header className="page-head">
                <div><h2>平台状态</h2></div>
                <button type="button" className="ghost-btn" disabled={magpieBusy !== ''} onClick={() => void runMagpieAction('refresh-quotas')}>{magpieBusy === 'refresh-quotas' ? '刷新中…' : '刷新额度'}</button>
              </header>
              <div className="platform-hero">
                <span className={`platform-orb ${magpieStatus?.configured ? 'online' : ''}`} />
                <div className="platform-hero-main">
                  <strong>Daming 网关</strong>
                  <span>{magpieStatus?.configured ? '已连接 · 真实账号' : magpieStatus?.running ? '运行中 · 管理后台未就绪' : '不可用'}</span>
                </div>
                <div className="platform-hero-stat"><span>模型</span><strong>{magpieSnapshot?.models?.count ?? '—'}</strong></div>
                <div className="platform-hero-stat"><span>供应商</span><strong>{new Set(localQuotaCards.map((card) => card.provider)).size || platformProviders.length || '—'}</strong></div>
                <div className="platform-hero-stat"><span>额度卡</span><strong>{localQuotaCards.length || '—'}</strong></div>
              </div>
              <div className="quota-grid">
                {localQuotaCards.map((card) => (
                  <article className="quota-card" key={card.provider + card.user}>
                    <div className="quota-head"><strong>{card.name || card.provider}</strong><span className="state-pill state-ok">{card.plan || '已连接'}</span></div>
                    <p className="quota-detail">{card.user || card.provider}</p>
                    {card.windows.map((window) => (
                      <div className="quota-window" key={window.name}>
                        <div className="quota-window-head"><span>{window.name}</span><em>{window.display ?? '剩余 ' + Math.round(window.remainingPercent) + '%'}</em></div>
                        <div className="quota-track"><span style={{ width: Math.max(0, Math.min(100, window.remainingPercent)) + '%' }} /></div>
                        {window.resetsAt && <div className="quota-foot"><span>{new Date(window.resetsAt).toLocaleString()} 重置</span></div>}
                      </div>
                    ))}
                  </article>
                ))}
                {!localQuotaCards.length && <p className="hint">额度读取中…如果长时间为空，请在网关管理里检查账号。</p>}
              </div>
              <div className="platform-lower">
                <div className="platform-accounts">
                  <div className="card-title"><h3>账号与供应商</h3><span className="hint">{new Set(localQuotaCards.map((card) => card.provider)).size} 个</span></div>
                  {localQuotaCards.map((card) => (
                    <div className="platform-account-row" key={card.provider + card.user}>
                      <span className="dot ok" />
                      <strong>{card.provider}</strong>
                      <span>{card.user || card.name}</span>
                    </div>
                  ))}
                  {!localQuotaCards.length && <p className="hint">正在从网关读取账号…</p>}
                </div>
                <div className="platform-side">
                  <div className="status-panel">
                    <div className="status-panel-head"><span className={`panel-dot ${luluStatus?.health === 'online' ? 'online' : ''}`} /><h3>Lulu</h3><span className={`state-pill ${luluStatus?.enabled ? 'state-ok' : 'state-idle'}`}>{luluStatus?.enabled ? (luluStatus.health === 'online' ? '在线' : '不可用') : '未配置'}</span></div>
                  </div>
                  <div className="status-panel">
                    <div className="status-panel-head"><span className="panel-dot" /><h3>受管 Host</h3><span className="state-pill state-ok">单一写者</span></div>
                  </div>
                </div>
              </div>
              {magpieError && <p className="hint reconcile-error">{magpieError}</p>}
            </section>
          )}

          {activeSection === 'platform' && <PlatformStatusPanel session={session} />}

          {activeSection === 'providers' && <ProvidersPanel session={session} />}
          {activeSection === 'agents' && <AgentsPanel session={session} />}
          {activeSection === 'pipeline' && (
            <div className="page-stack pipeline-page">
              <CommanderPanel session={session} />
              <PipelinePanel session={session} />
              <CrewPanel session={session} onOpenTask={openTaskDrawer} />
            </div>
          )}
          {activeSection === 'room' && <AgentRoomPanel session={session} />}
          {activeSection === 'notifications' && <NotificationsPanel session={session} />}
          {activeSection === 'settings' && (
            <SettingsPanel
              session={session}
              onNavigate={jumpTo}
              themePreference={themePreference}
              onThemeChange={setThemePreference}
            />
          )}
          {activeSection === 'help' && <HelpPanel />}
        </main>
      </div>

      {drawerOpen && (
        <div className="drawer-backdrop" role="presentation"
          onMouseDown={(event) => { if (event.target === event.currentTarget) closeTaskDrawer(); }}>
          <aside className="task-drawer" role="dialog" aria-modal="true" aria-label="任务详情" tabIndex={-1} ref={drawerRef}>
            <header className="drawer-head">
              <div className="drawer-title">
                <p className="eyebrow">TASK DETAIL</p>
                <h2>{selectedTask?.title ?? '任务详情'}</h2>
                {selectedTask && <span className="drawer-id">{selectedTask.taskId}</span>}
              </div>
              <button type="button" className="drawer-close" onClick={closeTaskDrawer} aria-label="关闭任务详情">×</button>
            </header>
            <div className="drawer-body">
              {codexRun && <RealCodexPanel run={codexRun} />}
              {detail?.plan?.category === 'task7-local-delivery' && (
                <section className="panel local-delivery-panel" aria-label="本地交付成果">
                  <div className="panel-heading"><h3>本地交付成果</h3><span>{detail.status === 'completed' ? '文件已通过独立验收' : '等待任务审批和验收'}</span></div>
                  {detail.status !== 'completed' && <p className="hint">规则型 Worker 会先并行整理目标及权限约束，再生成报告并核对磁盘文件。</p>}
                  {localDeliveryError && <p className="error-banner" role="alert">交付文件校验失败：{localDeliveryError}</p>}
                  {localDelivery?.taskId === detail.taskId && (
                    <div>
                      <p className="hint">{localDelivery.filename} · 已核对隔离工作区中的文件内容</p>
                      <pre className="local-delivery-content">{localDelivery.content}</pre>
                      <button type="button" onClick={() => void navigator.clipboard.writeText(localDelivery.content)}>复制报告正文</button>
                    </div>
                  )}
                </section>
              )}
              {detail?.plan?.category === 'task8-project-agent-preview' && (
                <section className="panel project-preview-panel" aria-label="项目副本变更预览">
                  <div className="panel-heading"><h3>Codex → DSH 变更预览</h3><span>原项目保持只读</span></div>
                  {detail.status !== 'completed' && <p className="hint">等待审批和双模型审查。模型只提供建议，Host 仅在白名单副本中应用一次替换。</p>}
                  {projectError && <p role="alert" className="error-banner">变更预览核验失败：{projectError}</p>}
                  {projectPreview?.taskId === detail.taskId && (
                    <div className="project-preview-result">
                      <p><strong>文件：</strong>{projectPreview.filename}</p>
                      <p><strong>DSH 复核：</strong>{projectPreview.reviewerNote}</p>
                      <p><strong>源文件状态：</strong>{projectPreview.originalUnchanged ? '与快照一致' : '源文件已有变化，禁止合并'}</p>
                      <p className="hint">变更仅保存在副本；尚未提供合并原项目的功能。</p>
                      <div className="project-diff">
                        <div><strong>变更前</strong><pre>{projectPreview.before}</pre></div>
                        <div><strong>变更后（副本）</strong><pre>{projectPreview.after}</pre></div>
                      </div>
                    </div>
                  )}
                </section>
              )}
              {detail ? (
                <TaskDetail detail={detail} canCancel={session.role === 'readwrite'} onCancel={cancelTask} onApprove={approveTask} csrfToken={session.csrfToken} />
              ) : (
                <div className="empty-detail">
                  <p className="eyebrow">TASK DETAIL</p>
                  <h2>正在加载任务详情…</h2>
                  <p>任务创建后将在这里展示规划、Worker 路由理由、预算、审批和审计证据。</p>
                </div>
              )}
            </div>
          </aside>
        </div>
      )}

      {paletteOpen && (
        <div className="palette-backdrop" role="presentation"
          onMouseDown={(event) => { if (event.target === event.currentTarget) setPaletteOpen(false); }}>
          <div className="palette" role="dialog" aria-modal="true" aria-label="命令面板" ref={paletteRef}>
            <input autoFocus value={paletteQuery} aria-label="搜索或跳转"
              onChange={(event) => setPaletteQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && paletteItems[0]) jumpTo(paletteItems[0].id); }}
              placeholder="搜索页面、任务、审批…" />
            <ul>
              {paletteItems.map((item) => (
                <li key={item.id}>
                  <button type="button" className={activeSection === item.id ? 'on' : ''} onClick={() => jumpTo(item.id)}>
                    <Icon name={item.icon} className="ic" /><span>{item.label}</span>
                  </button>
                </li>
              ))}
              {!paletteItems.length && <li className="inbox-empty">没有匹配项</li>}
            </ul>
            <p className="hint">Enter 跳转 · Esc 关闭 · Ctrl K 再次打开</p>
          </div>
        </div>
      )}

      <ToastViewport toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
