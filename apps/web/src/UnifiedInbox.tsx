import type { EscalationItemView, PortfolioDigestView, TaskSummaryView } from '@daming/contracts';
import { STATUS_LABELS, shortId } from './format.ts';

const KIND_LABEL: Record<EscalationItemView['kind'], string> = {
  contract: '契约', acceptance: '验收', budget: '预算', irreversible: '不可逆', anomaly: '异常',
};
const BUCKET_LABEL: Record<EscalationItemView['bucket'], string> = {
  needs_you: '需拍板', at_risk: '风险', awaiting_acceptance: '待验收', healthy: '健康',
};
const DEFAULT_LABEL: Record<EscalationItemView['defaultAction'], string> = {
  hold: '保持现状', pause: '暂停', advance: '推进', reject: '驳回',
};

type DecideAction = 'approve' | 'reject' | 'defer';

interface ProjectGroup {
  readonly key: string;
  readonly name: string;
  readonly items: EscalationItemView[];
}

function EscalationRow({ item, canWrite, onDecide }: {
  item: EscalationItemView;
  canWrite: boolean;
  onDecide: (itemId: string, action: DecideAction) => void;
}) {
  return (
    <div className="inbox-row" style={{ alignItems: 'flex-start', display: 'grid', gap: 4 }}>
      <span className={`status-pill status-${item.severity === 'high' ? 'blocked' : 'reviewing'}`}>
        {KIND_LABEL[item.kind]} · {BUCKET_LABEL[item.bucket]}
      </span>
      <span className="inbox-row-title">{item.summary}</span>
      <span className="inbox-row-goal">
        推荐：{item.recommendation}　影响：{item.impact}　超时默认：{DEFAULT_LABEL[item.defaultAction]}
      </span>
      {canWrite && (
        <span style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="link-btn" onClick={() => onDecide(item.itemId, 'approve')}>批准 / 结案</button>
          <button type="button" className="link-btn" onClick={() => onDecide(item.itemId, 'reject')}>驳回</button>
          <button type="button" className="link-btn" onClick={() => onDecide(item.itemId, 'defer')}>稍后</button>
        </span>
      )}
    </div>
  );
}

function TaskRow({ task, onOpenTask }: { task: TaskSummaryView; onOpenTask: (taskId: string) => void }) {
  return (
    <button type="button" className="inbox-row" onClick={() => onOpenTask(task.taskId)}>
      <span className={`status-pill status-${task.status}`}>{STATUS_LABELS[task.status]}</span>
      <span className="inbox-row-title">{task.title}</span>
      <span className="inbox-row-goal">{task.goal}</span>
      <span className="inbox-id">{shortId(task.taskId)}</span>
    </button>
  );
}

/**
 * 收件箱（合并了原「组合收件箱」）：一屏看全部项目，按项目分组，每个项目一个独立小收件箱。
 * 项目级待拍板项来自组合治理汇总；平台任务待办单列为「任务待办」组。
 */
export function UnifiedInbox({ digest, tasks, canWrite, onDecide, onOpenTask }: {
  digest: PortfolioDigestView | null;
  tasks: readonly TaskSummaryView[];
  canWrite: boolean;
  onDecide: (itemId: string, action: DecideAction) => void;
  onOpenTask: (taskId: string) => void;
}) {
  const map = new Map<string, ProjectGroup>();
  for (const item of [...(digest?.realtime ?? []), ...(digest?.digest ?? [])]) {
    const key = item.projectId || item.projectName || 'unknown';
    const group = map.get(key) ?? { key, name: item.projectName || item.projectId || '未命名项目', items: [] };
    group.items.push(item);
    map.set(key, group);
  }
  const groups = [...map.values()];
  const totals = digest?.totals;

  const kpis = [
    { label: '项目', value: totals?.projects ?? groups.length },
    { label: '需拍板', value: totals?.needsYou ?? 0 },
    { label: '风险', value: totals?.atRisk ?? 0 },
    { label: '待验收', value: totals?.awaitingAcceptance ?? 0 },
    { label: '任务待办', value: tasks.length },
  ];

  return (
    <section className="page-stack inbox-page" id="inbox" data-reveal>
      <header className="page-head">
        <div>
          <h2>收件箱</h2>
          <p className="hint">一屏管所有项目：按项目分组，每个项目一个独立小收件箱；只放需要你拍板、风险、待验收与卡住的任务。{digest ? `（${digest.dayKey}）` : ''}</p>
        </div>
      </header>

      <div className="kpi-grid">
        {kpis.map((kpi) => (
          <div className="kpi" key={kpi.label}>
            <span className="label">{kpi.label}</span>
            <div className="value">{kpi.value}</div>
          </div>
        ))}
      </div>

      {groups.map((group) => (
        <article className="status-card inbox-project" key={group.key}>
          <div className="card-title">
            <h3>{group.name} <span className="count">{group.items.length}</span></h3>
            <span className="hint">项目小收件箱</span>
          </div>
          <div className="inbox-full">
            {group.items.map((item) => (
              <EscalationRow item={item} key={item.itemId} canWrite={canWrite} onDecide={onDecide} />
            ))}
          </div>
        </article>
      ))}

      <article className="status-card inbox-project">
        <div className="card-title">
          <h3>任务待办 <span className="count">{tasks.length}</span></h3>
          <span className="hint">待审批 / 验收中 / 阻塞</span>
        </div>
        <div className="inbox-full">
          {tasks.map((task) => <TaskRow task={task} key={task.taskId} onOpenTask={onOpenTask} />)}
          {!tasks.length && <p className="hint">没有待审批、待验收或阻塞的任务。</p>}
        </div>
      </article>

      {!groups.length && !tasks.length && (
        <div className="empty-card">
          <div className="empty-art" aria-hidden="true"><span className="empty-orb" /><span className="empty-ring" /></div>
          <h3>收件箱是空的</h3>
          <p>没有需要你拍板的事，Agent 正在后台推进。</p>
        </div>
      )}

      {(digest?.autoHandled.length || digest?.notes.length) ? (
        <div className="status-card">
          <div className="card-title"><h3>系统替你做了</h3><span className="hint">审计可回看</span></div>
          <div className="status-rows">
            {digest?.autoHandled.map((line, index) => (
              <div className="status-row" key={'auto-' + index}><span>{line}</span></div>
            ))}
            {digest?.notes.map((line, index) => (
              <div className="status-row" key={'note-' + index}><span className="hint">{line}</span></div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
