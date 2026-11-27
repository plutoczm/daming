/**
 * 顶层组合治理（P0 治理内核）—— 人只做顶层管理/审核/决策。
 *
 * 设计依据：docs/design-top-level-governance-2026-11-21.md（REQ-014）。
 * 职责：
 *  - 把多个项目里“需要人拍板”的事归为五类（A 契约 / B 验收 / C 预算 / D 不可逆 / E 异常）。
 *  - 其余任务级事项不进人视野（由项目队长/执行 Agent 自治）。
 *  - 组合级收件箱：一句话 + 推荐动作 + 影响 + 超时安全默认。
 *  - 打扰预算：默认静默、按事件级别推送；非关键项超预算并入 digest；决策/错误类（高严重度）不可静默。
 *  - 自动验收门槛：仅 auto 档 + 确定性证据 PASS 才自动（且最终仍须经唯一 Engine 写入，见 REQ-003/009）。
 *
 * 纯逻辑与持久化分离：buildPortfolioDigest 为纯函数；PortfolioGovernanceStore 只管授权档位与打扰计数。
 * 本文件不写任务事实，不联网，不发消息。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AutonomyProfileView, EscalationBucket, EscalationDefaultAction, EscalationItemView,
  EscalationKind, PortfolioDigestView, PortfolioProjectView, PortfolioRiskLevel,
} from '@daming/contracts';

const RISK_ORDER: Record<PortfolioRiskLevel, number> = { low: 0, medium: 1, high: 2 };
const DEADLINE_MS = 24 * 60 * 60 * 1000;

/** 默认授权档位：成熟项目默认 auto（少管）；阈值可在开工时覆盖。 */
export function defaultAutonomyProfile(projectId: string): AutonomyProfileView {
  return {
    projectId, mode: 'auto', spendCapMinor: 500, riskCap: 'medium',
    confidenceFloor: 0.6, autoAccept: true, maxInterruptsPerDay: 2,
  };
}

/** 自动验收门槛：只有 auto 档 + 证据 PASS + 存在待验收决定时才可自动（证据来源为 REQ-009 确定性检查）。 */
export function autoAcceptEligible(project: PortfolioProjectView, profile: AutonomyProfileView): boolean {
  return profile.mode === 'auto' && profile.autoAccept && project.evidencePassed &&
    project.pendingDecisions.some(decision => decision.kind === 'acceptance');
}

function bucketFor(kind: EscalationKind): EscalationBucket {
  if (kind === 'acceptance') return 'awaiting_acceptance';
  if (kind === 'anomaly') return 'at_risk';
  return 'needs_you'; // contract / budget / irreversible
}

/** 一条待拍板项。超时默认动作永远选“保持现状/暂停”，绝不自动做不可逆动作。 */
function makeItem(input: {
  readonly project: PortfolioProjectView;
  readonly kind: EscalationKind;
  readonly severity: PortfolioRiskLevel;
  readonly summary: string;
  readonly recommendation: string;
  readonly impact: string;
  readonly evidence: readonly string[];
  readonly defaultAction: EscalationDefaultAction;
  readonly now: number;
  readonly idKey: string;
}): EscalationItemView {  const { project, kind, severity } = input;
  return {
    itemId: project.projectId + ':' + kind + ':' + input.idKey,
    projectId: project.projectId, projectName: project.name,
    kind, severity, bucket: bucketFor(kind),
    summary: input.summary, recommendation: input.recommendation, impact: input.impact,
    evidence: input.evidence, defaultAction: input.defaultAction, realtime: false,
    createdAt: project.lastActivityAt,
    deadlineAt: new Date(input.now + DEADLINE_MS).toISOString(),
  };
}

/** 收集单个项目里“需要人”的全部升级项（不含实时/digest 路由，由 buildPortfolioDigest 决定）。 */
export function collectEscalations(project: PortfolioProjectView, profile: AutonomyProfileView, now: number): EscalationItemView[] {
  const items: EscalationItemView[] = [];
  const add = (
    kind: EscalationKind, severity: PortfolioRiskLevel, summary: string, recommendation: string,
    impact: string, evidence: readonly string[], defaultAction: EscalationDefaultAction, idKey: string,
  ) => {
    items.push(makeItem({ project, kind, severity, summary, recommendation, impact, evidence, defaultAction, now, idKey }));
  };

  // C 预算
  if (project.budget) {
    const { spentMinor, capMinor, unknown } = project.budget;
    if (unknown) {
      add('budget', 'high', '账单未知待核对，需人工核对后放行',
        '暂停该笔支出；核对官方账单或标记未知后，再决定放行或退款',
        '未知结果若自动重放可能重复计费', ['budget.unknown=true'], 'hold', 'unknown');
    } else if (capMinor !== null && spentMinor > capMinor) {
      add('budget', 'high', '超预算：已花 ' + spentMinor + ' 分 / 上限 ' + capMinor + ' 分',
        '暂停新增支出；确认加预算或收缩范围后再继续',
        '继续执行会突破现金硬限额', ['spent=' + spentMinor, 'cap=' + capMinor], 'hold', 'over');
    }
  }

  // E 异常
  if (project.consecutiveFailures >= 2) {
    add('anomaly', 'high', '连续失败 ' + project.consecutiveFailures + ' 次',
      '检查失败原因：选择重试 / 改范围 / 止损（暂停）',
      '继续无效重试会烧额度并拖延', ['consecutiveFailures=' + project.consecutiveFailures], 'pause', 'failures');
  }
  if (project.stalledMinutes >= 30) {
    add('anomaly', 'medium', '停滞 ' + project.stalledMinutes + ' 分钟无进展',
      '查看是否卡在依赖/权限；必要时改派或延长时限',
      '长期停滞占用工位无产出', ['stalledMinutes=' + project.stalledMinutes], 'hold', 'stall');
  }
  for (const blocker of project.blockers) {
    add('anomaly', blocker.severity, '阻塞：' + blocker.id,
      '解除阻塞或改派；低风险可先由项目队长自动处理',
      '阻塞期间该项目无法推进', ['blocker=' + blocker.id], 'hold', 'blocker:' + blocker.id);
  }

  // D 不可逆（未经预授权的发布/合并/删除/付款）
  for (const op of project.irreversiblePending ?? []) {
    add('irreversible', 'high', '不可逆操作待授权：' + op.summary,
      '确认目标无误后再授权（发布/合并主干/删除/付款不可撤销）',
      '不可逆动作一旦执行无法回滚', ['irreversible=' + op.id], 'hold', 'irreversible:' + op.id);
  }

  // A 契约 / B 验收（来自 pendingDecisions）
  for (const decision of project.pendingDecisions) {
    if (decision.kind === 'acceptance') {
      if (autoAcceptEligible(project, profile)) continue; // 证据 PASS + auto 档 → 自动验收，不进人视野
      add('acceptance', 'medium', '待验收：' + decision.question,
        '核对交付证据后一键验收；证据不足则退回返工',
        '未验收则下游无法在上游结果上继续', ['decision=' + decision.decisionId], 'hold', 'acceptance:' + decision.decisionId);
    } else if (decision.kind === 'proposal') {
      add('contract', 'high', '需确认变更：' + decision.question,
        '批准此范围/计划变更，或驳回保持现状（spec 不可被自行降低）',
        '变更会改 plan/验收，须人工确认后不可静默应用', ['decision=' + decision.decisionId], 'hold', 'contract:' + decision.decisionId);
    } else {
      add('anomaly', 'medium', '需补充信息：' + decision.question,
        '按默认假设继续，或补充澄清（低风险可自动按假设推进）',
        '阻塞式提问会占用该项目执行位', ['decision=' + decision.decisionId], 'hold', 'clarification:' + decision.decisionId);
    }
  }
  return items;
}

/**
 * 组合级收件箱：聚合所有项目的升级项，按严重度排序，套用打扰预算后分到 realtime / digest。
 * 高严重度（以及任何不可逆）为“生命线”，永不静默；其余受 maxInterruptsPerDay 约束，超出的降噪进 digest。
 */
export function buildPortfolioDigest(input: {
  readonly projects: readonly PortfolioProjectView[];
  readonly profiles: Readonly<Record<string, AutonomyProfileView>>;
  readonly now: number;
  readonly interruptUsed?: Readonly<Record<string, number>>;
  readonly suppressed?: ReadonlySet<string>;
}): PortfolioDigestView {
  const { projects, profiles, now } = input;
  const suppressed = input.suppressed;
  const priorUsed = input.interruptUsed ?? {};
  const dayKey = new Date(now).toISOString().slice(0, 10);
  const realtime: EscalationItemView[] = [];
  const digest: EscalationItemView[] = [];
  const autoHandled: string[] = [];
  const notes: string[] = [];
  const used: Record<string, number> = { ...priorUsed };
  const totals = { projects: projects.length, needsYou: 0, atRisk: 0, awaitingAcceptance: 0, healthy: 0 };

  for (const project of projects) {
    const profile = profiles[project.projectId] ?? defaultAutonomyProfile(project.projectId);
    if (project.accepted) { totals.healthy += 1; continue; }
    if (autoAcceptEligible(project, profile)) {
      autoHandled.push('自动验收：' + project.name + ' 确定性证据已 PASS，按 auto 档自动验收（决定仍经唯一 Engine 写入）');
    }
    const items = collectEscalations(project, profile, now)
      .filter((item) => !(suppressed && suppressed.has(item.itemId)));
    if (items.length === 0) { totals.healthy += 1; continue; }
    items.sort((a, b) => RISK_ORDER[b.severity] - RISK_ORDER[a.severity]);
    let projectUsed = used[project.projectId] ?? 0;
    for (const item of items) {
      const critical = item.kind === 'irreversible' || item.severity === 'high';
      // 验收项一律并入 digest（仍是投递，不是静默）：批量审阅更省心，符合“少管”。
      let real = critical && item.kind !== 'acceptance';
      if (!real && item.kind !== 'acceptance') {
        if (projectUsed < profile.maxInterruptsPerDay) real = true;
        else notes.push('降噪：' + project.name + ' 今日打扰已达 ' + profile.maxInterruptsPerDay + ' 次，该项并入 digest');
      }
      if (real) { projectUsed += 1; realtime.push({ ...item, realtime: true }); }
      else digest.push({ ...item, realtime: false });
      if (item.bucket === 'needs_you') totals.needsYou += 1;
      else if (item.bucket === 'at_risk') totals.atRisk += 1;
      else if (item.bucket === 'awaiting_acceptance') totals.awaitingAcceptance += 1;
    }
    used[project.projectId] = projectUsed;
  }

  const bySeverity = (a: EscalationItemView, b: EscalationItemView) =>
    RISK_ORDER[b.severity] - RISK_ORDER[a.severity] || a.createdAt.localeCompare(b.createdAt);
  realtime.sort(bySeverity);
  digest.sort(bySeverity);
  return { dayKey, generatedAt: new Date(now).toISOString(), totals, realtime, digest, autoHandled, notes };
}

/** JSON 持久化：授权档位 + 每日打扰计数（0600；不含任何密钥）。 */
interface GovernanceData {
  profiles: Record<string, AutonomyProfileView>;
  interrupts: Record<string, Record<string, number>>;
}

export class PortfolioGovernanceStore {
  private readonly file: string;
  private data: GovernanceData;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = join(dataDir, 'portfolio-governance.json');
    try {
      const parsed = (existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : null) as Partial<GovernanceData> | null;
      this.data = parsed && parsed.profiles && parsed.interrupts
        ? { profiles: parsed.profiles, interrupts: parsed.interrupts }
        : { profiles: {}, interrupts: {} };
    } catch {
      this.data = { profiles: {}, interrupts: {} };
    }
  }
  private persist(): void {
    try { writeFileSync(this.file, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 }); } catch { /* best effort */ }
  }
  getProfile(projectId: string): AutonomyProfileView {
    return this.data.profiles[projectId] ?? defaultAutonomyProfile(projectId);
  }
  listProfiles(): AutonomyProfileView[] { return Object.values(this.data.profiles); }
  setProfile(profile: AutonomyProfileView): void { this.data.profiles[profile.projectId] = profile; this.persist(); }
  interruptsFor(dayKey: string): Record<string, number> { return { ...(this.data.interrupts[dayKey] ?? {}) }; }
  recordInterrupts(dayKey: string, counts: Record<string, number>): void { this.data.interrupts[dayKey] = counts; this.persist(); }
}

/** 组合治理入口：读档位/计数 → 生成 digest → 回写当日已用打扰。 */
export class PortfolioGovernance {
  private readonly store: PortfolioGovernanceStore;
  constructor(store: PortfolioGovernanceStore) { this.store = store; }
  digest(projects: readonly PortfolioProjectView[], now: number = Date.now()): PortfolioDigestView {
    const profiles: Record<string, AutonomyProfileView> = {};
    for (const project of projects) profiles[project.projectId] = this.store.getProfile(project.projectId);
    const dayKey = new Date(now).toISOString().slice(0, 10);
    const prior = this.store.interruptsFor(dayKey);
    const result = buildPortfolioDigest({ projects, profiles, now, interruptUsed: prior });
    const next: Record<string, number> = { ...prior };
    for (const item of result.realtime) next[item.projectId] = (next[item.projectId] ?? 0) + 1;
    this.store.recordInterrupts(dayKey, next);
    return result;
  }
}
