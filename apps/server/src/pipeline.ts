import { randomUUID } from 'node:crypto';
import type {
  AvailableModelsView, ModelBindingView, PipelineCheckResultView, PipelineCheckView, PipelineEventView,
  PipelineNotificationView, PipelineReviewView, PipelineRunView, PipelineStage,
  PipelineStepStatus
} from '@daming/contracts';
import { planCrew } from './crew-planner.ts';

/**
 * 执行链（Architect → Worker sub-agents → Reviewer → rework loop → budget/notify）。
 *
 * 借鉴：Autoloop 的 Planner/Coder/Reviewer 三栏 + iter/metric + push log；
 * T3 的 subagent tree（父级不被子级自动完成）；HiFox 的“只推需要人拍板的事”。
 *
 * 这是纯编排内核：真正的副作用（模型调用）由注入的 executor 完成。
 * 默认 HTTP 走离线 fixture 推演（不触达任何真实模型），真实执行器接入后无需改本内核。
 */

export type PipelineAgent = 'dsh' | 'codex' | 'claude-code';

export interface PipelinePlanStep {
  readonly stepId: string;
  readonly title: string;
  readonly description: string;
  readonly agent: PipelineAgent;
  readonly providerId: string;
  readonly modelId: string;
  readonly dependsOn: readonly string[];
  readonly maxReworks: number;
  /** 分配该步 Agent+模型的理由（能力 / 绑定 / 成本）。 */
  readonly rationale: string;
  /** 成本档：low / mid / high。 */
  readonly costTier: 'low' | 'mid' | 'high';
  /** 评审员为该步生成的评测集（验收契约）。 */
  readonly contract: readonly PipelineCheckView[];
}

export interface PipelinePlan {
  readonly planId: string;
  readonly title: string;
  readonly goal: string;
  readonly planner: 'platform' | 'main-agent';
  readonly reviewerAgent: PipelineAgent;
  readonly steps: readonly PipelinePlanStep[];
  readonly notes: readonly string[];
  readonly createdAt: string;
}

export interface PipelineExecInput {
  readonly step: PipelinePlanStep;
  /** 0-based attempt index. */
  readonly attempt: number;
}
export interface PipelineExecOutput {
  readonly artifacts: Record<string, unknown>;
}
export type PipelineExecutor = (input: PipelineExecInput) => PipelineExecOutput | Promise<PipelineExecOutput>;

/** 评审员裁决函数：可用离线评测集（reviewArtifacts）或真实模型评审；允许异步。 */
export type PipelineReviewFn = (input: {
  readonly step: PipelinePlanStep;
  readonly artifacts: Record<string, unknown>;
  readonly attempt: number;
}) => PipelineReviewView | Promise<PipelineReviewView>;

export interface PipelineNotify {
  readonly event: 'pipeline.passed' | 'pipeline.blocked' | 'pipeline.budget_exhausted' | 'pipeline.reviewer_reject_2';
  readonly text: string;
}

export interface RunPipelineOptions {
  readonly executor: PipelineExecutor;
  readonly budgetMinor: number;
  readonly costPerAttemptMinor: number;
  readonly now?: () => string;
  /** 自定义评审员裁决（真实模式用模型评审）；缺省用 reviewArtifacts 对评测集逐条比对。 */
  readonly review?: PipelineReviewFn;
  /** Called for every recorded notification (Host wiring can forward it to Feishu/WeCom/WeChat/QQ). */
  readonly notify?: (event: PipelineNotify) => void;
}

const CHANNEL_HINT = '飞书 / 企业微信 / 微信 / QQ';

/** 评审员为每个子目标生成评测集：交付物存在 + 内容满足期望（对象做深包含匹配）。 */
export function synthesizeContract(step: {
  title: string; agent: PipelineAgent;
}): PipelineCheckView[] {
  return [
    { id: 'deliverable', label: '交付物存在（' + step.title + '）', kind: 'present', artifactId: 'result' },
    { id: 'accept', label: '内容满足验收：' + step.title, kind: 'json_equals', artifactId: 'result', expected: { ok: true, agent: step.agent, subgoal: step.title } }
  ];
}

function checkLabel(check: PipelineCheckView): string {
  if (check.label) return check.label;
  if (check.kind === 'present') return '交付物存在（' + check.artifactId + '）';
  if (check.kind === 'json_equals') return '内容符合（' + check.artifactId + '）';
  return '规则（' + check.artifactId + '）';
}

/** 架构师规划：复用编队拆分与「按能力/绑定/成本」选 Agent+模型的规则。 */
export function planPipeline(input: {
  title: string;
  goal: string;
  subgoals?: readonly string[];
  catalog: AvailableModelsView;
  bindings?: readonly ModelBindingView[];
  planner?: 'platform' | 'main-agent';
  sequence?: 'parallel' | 'sequential';
  maxReworks?: number;
}): PipelinePlan {
  const maxReworks = Number.isSafeInteger(input.maxReworks) && (input.maxReworks as number) >= 0
    ? Math.min(2, input.maxReworks as number) : 1;
  const crew = planCrew({
    title: input.title, goal: input.goal,
    ...(input.subgoals ? { subgoals: input.subgoals } : {}),
    planner: input.planner ?? 'main-agent',
    sequence: input.sequence === 'sequential' ? 'sequential' : 'parallel',
    catalog: input.catalog, bindings: input.bindings ?? []
  });
  const steps: PipelinePlanStep[] = crew.assignments.map((assignment) => ({
    stepId: assignment.id,
    title: assignment.title,
    description: assignment.description,
    agent: assignment.agent,
    providerId: assignment.providerId,
    modelId: assignment.modelId,
    dependsOn: [...(assignment.dependsOn ?? [])],
    maxReworks,
    rationale: assignment.rationale,
    costTier: assignment.costTier ?? 'mid',
    contract: synthesizeContract({ title: assignment.title, agent: assignment.agent })
  }));
  const reviewerAgent: PipelineAgent = steps.some((step) => step.agent === 'claude-code')
    ? 'claude-code' : steps.at(-1)?.agent ?? 'claude-code';
  const notes = [...crew.notes];
  if (!steps.length) notes.push('没有可拆解的子目标：请在目标里写清一行一个子目标，或写更具体的目标。');
  return {
    planId: crew.planId, title: crew.title, goal: crew.goal, planner: crew.planner,
    reviewerAgent, steps, notes, createdAt: crew.createdAt
  };
}

/**
 * 人工改派：把某一步换成指定 Agent + 模型（可选 provider），并按新 Agent 重新生成评测集，
 * 以便随后 runPipelineFrom 从该阶段真正重跑。返回新的不可变计划（不改原对象）。
 */
export function reassignPipelineStep(
  plan: PipelinePlan,
  stepId: string,
  choice: { agent: PipelineAgent; providerId?: string; modelId?: string }
): PipelinePlan {
  const steps: PipelinePlanStep[] = plan.steps.map((step) => {
    if (step.stepId !== stepId) return step;
    const agent = choice.agent;
    const providerId = choice.providerId ?? step.providerId;
    const modelId = choice.modelId ?? step.modelId;
    return {
      ...step,
      agent,
      providerId,
      modelId,
      rationale: '人工改派 · ' + agentLabel(agent) + ' · ' + (providerId || '—') + '/' + (modelId || '—'),
      contract: synthesizeContract({ title: step.title, agent })
    } satisfies PipelinePlanStep;
  });
  const reviewerAgent: PipelineAgent = steps.some((step) => step.agent === 'claude-code') ? 'claude-code' : plan.reviewerAgent;
  return { ...plan, steps, reviewerAgent };
}

function canon(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']';
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return '{' + entries.map(([key, item]) => JSON.stringify(key) + ':' + canon(item)).join(',') + '}';
}
/** 深包含匹配：expected 的每个键都要在 artifact 里深度相等（artifact 可有额外键）。 */
function matches(artifact: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== 'object') return canon(artifact) === canon(expected);
  if (Array.isArray(expected)) {
    if (!Array.isArray(artifact) || artifact.length !== expected.length) return false;
    return expected.every((item, index) => matches(artifact[index], item));
  }
  if (artifact === null || typeof artifact !== 'object' || Array.isArray(artifact)) return false;
  return Object.entries(expected as Record<string, unknown>).every(([key, item]) =>
    matches((artifact as Record<string, unknown>)[key], item));
}

/** 评审员裁决：逐条评测集比对交付物，并给出每一项的通过/不通过与原因。 */
export function reviewArtifacts(contract: readonly PipelineCheckView[], artifacts: Record<string, unknown>, attempt: number): PipelineReviewView {
  const reasons: string[] = [];
  const results: PipelineCheckResultView[] = [];
  let fail = false;
  for (const check of contract) {
    const label = checkLabel(check);
    const has = Object.hasOwn(artifacts, check.artifactId);
    if (!has) {
      fail = true; const reason = 'missing_artifact:' + check.artifactId; reasons.push(reason);
      results.push({ id: check.id, label, kind: check.kind, passed: false, reason });
      continue;
    }
    if (check.kind === 'present') { results.push({ id: check.id, label, kind: check.kind, passed: true }); continue; }
    if (check.kind === 'json_equals') {
      if (!matches(artifacts[check.artifactId], check.expected)) {
        fail = true; const reason = 'content_mismatch:' + check.id; reasons.push(reason);
        results.push({ id: check.id, label, kind: check.kind, passed: false, reason });
      } else { results.push({ id: check.id, label, kind: check.kind, passed: true }); }
      continue;
    }
    // test: 交付物存在且（若给了 expected）满足匹配，否则视为未通过
    if (check.expected !== undefined && !matches(artifacts[check.artifactId], check.expected)) {
      fail = true; const reason = 'test_failed:' + check.id; reasons.push(reason);
      results.push({ id: check.id, label, kind: check.kind, passed: false, reason });
    } else { results.push({ id: check.id, label, kind: check.kind, passed: true }); }
  }
  return { verdict: fail ? 'fail' : 'pass', reasons, results, attempt };
}

/**
 * 运行一条执行链：逐步执行子目标，评审不通过就返工（≤maxReworks），
 * 全通过 → passed；额度不足 → budget_exhausted；返工用尽仍不通过 → blocked。
 * 通知遵循“少打扰”：仅在通过 / 额度耗尽 / 返工用尽 / 连续 2 次评审否决时推送。
 */
interface MutableStep {
  stepId: string; title: string; description: string; agent: PipelineAgent;
  providerId: string; modelId: string; dependsOn: string[]; maxReworks: number;
  rationale: string; costTier: 'low' | 'mid' | 'high';
  attempts: number; status: PipelineStepStatus;
  contract: readonly PipelineCheckView[]; lastReview: PipelineReviewView | null;
}
/** 续跑种子：保留前若干步已通过的执行结果，只从 fromIndex 起重跑。 */
export interface PipelineRunSeed {
  readonly statuses: readonly { readonly status: PipelineStepStatus; readonly attempts: number; readonly lastReview: PipelineReviewView | null }[];
  readonly spentMinor: number;
  readonly iteration: number;
}
export interface RunPipelineFromOptions extends RunPipelineOptions {
  readonly fromIndex?: number;
  readonly seed?: PipelineRunSeed;
}
export async function runPipeline(plan: PipelinePlan, options: RunPipelineOptions): Promise<PipelineRunView> {
  return runPipelineFrom(plan, options);
}
/** 从 fromIndex 起（可带续跑种子）运行执行链；用于「换 Agent/模型后重跑某阶段」。 */
export async function runPipelineFrom(plan: PipelinePlan, options: RunPipelineFromOptions): Promise<PipelineRunView> {
  const now = options.now ?? (() => new Date().toISOString());
  const createdAt = plan.createdAt;
  const events: PipelineEventView[] = [];
  const notifications: PipelineNotificationView[] = [];
  const pushEvent = (stage: string, actor: string, text: string) => events.push({ at: now(), stage, actor, text });
  const pushNotify = (event: PipelineNotify['event'], text: string) => {
    notifications.push({ event, channelHint: CHANNEL_HINT, text });
    options.notify?.({ event, text });
  };

  const fromIndex = Math.max(0, Math.min(options.fromIndex ?? 0, plan.steps.length));
  const seed = options.seed;
  let stage: PipelineStage = fromIndex > 0 ? 'rework' : 'architect';
  let iteration = seed?.iteration ?? 0;
  let spentMinor = seed?.spentMinor ?? 0;
  const cost = Math.max(0, options.costPerAttemptMinor);
  const budget = Math.max(0, options.budgetMinor);
  const steps: MutableStep[] = plan.steps.map((step) => ({
    stepId: step.stepId, title: step.title, description: step.description,
    agent: step.agent, providerId: step.providerId, modelId: step.modelId,
    dependsOn: [...step.dependsOn], maxReworks: step.maxReworks,
    rationale: step.rationale, costTier: step.costTier, attempts: 0,
    status: 'pending' as PipelineStepStatus, contract: step.contract, lastReview: null
  }));
  if (seed) {
    for (let index = 0; index < fromIndex && index < steps.length; index += 1) {
      const prior = seed.statuses[index];
      if (!prior) continue;
      steps[index]!.status = prior.status;
      steps[index]!.attempts = prior.attempts;
      steps[index]!.lastReview = prior.lastReview;
    }
  }

  if (fromIndex === 0) {
    pushEvent('architect', '架构师', '拆解为 ' + plan.steps.length + ' 个子目标，按能力/绑定/成本分配 Agent·模型；评审员为每步生成评测集。');
  } else {
    pushEvent('rework', '架构师', '从「' + (steps[fromIndex]?.title ?? '') + '」重跑：保留前 ' + fromIndex + ' 个已通过子目标，重新执行本阶段及之后。');
  }

  let stop = false;
  for (let index = fromIndex; index < plan.steps.length && !stop; index += 1) {
    const step = plan.steps[index]!;
    const view = steps[index]!;
    let attempt = 0;
    let rejects = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (budget > 0 && spentMinor + cost > budget) {
        stage = 'budget_exhausted';
        view.status = attempt === 0 ? 'failed' : 'failed';
        pushEvent('budget_exhausted', '额度', '额度不足：已用 ' + spentMinor + ' / ' + budget + ' 分，停止在「' + step.title + '」。');
        pushNotify('pipeline.budget_exhausted',
          '【大铭·执行链】「' + plan.title + '」额度已耗尽（' + spentMinor + '/' + budget + ' 分），已在「' + step.title + '」停止。需要你补充额度或调整预算。');
        stop = true;
        break;
      }
      spentMinor += cost;
      iteration += 1;
      view.attempts = attempt + 1;
      view.status = 'reviewing';
      pushEvent('executing', agentLabel(step.agent), '执行「' + step.title + '」（第 ' + (attempt + 1) + ' 次）· ' + step.providerId + '/' + step.modelId);
      const output = await options.executor({ step, attempt });
      const review = options.review
        ? await options.review({ step, artifacts: output.artifacts, attempt: attempt + 1 })
        : reviewArtifacts(step.contract, output.artifacts, attempt + 1);
      view.lastReview = review;
      if (review.verdict === 'pass') {
        view.status = 'passed';
        pushEvent('passed', '评审员', '「' + step.title + '」通过评审（评测 ' + step.contract.length + ' 项）。');
        break;
      }
      rejects += 1;
      pushEvent('reviewing', '评审员', '「' + step.title + '」未通过：' + review.reasons.join('、'));
      if (rejects === 2) {
        pushNotify('pipeline.reviewer_reject_2',
          '【大铭·执行链】「' + plan.title + '」子目标「' + step.title + '」连续 2 次评审否决：' + review.reasons.join('、') + '。仍在返工中。');
      }
      if (attempt < step.maxReworks) {
        view.status = 'rework';
        attempt += 1;
        pushEvent('rework', '架构师', '打回「' + step.title + '」返工（上限 ' + step.maxReworks + ' 次）。');
        continue;
      }
      view.status = 'failed';
      stage = 'blocked';
      pushEvent('blocked', '评审员', '「' + step.title + '」返工用尽仍未通过，执行链阻塞。');
      pushNotify('pipeline.blocked',
        '【大铭·执行链】「' + plan.title + '」评审未通过且返工用尽（' + step.title + '）：' + review.reasons.join('、') + '。需要你介入决定改需求或换模型。');
      stop = true;
      break;
    }
  }

  if (!stop) {
    stage = 'passed';
    pushEvent('passed', '架构师', '全部 ' + plan.steps.length + ' 个子目标通过评审；' + iteration + ' 次尝试，花费 ' + spentMinor + '/' + budget + ' 分。');
    pushNotify('pipeline.passed',
      '【大铭·执行链】「' + plan.title + '」已通过评审：' + plan.steps.length + ' 个子目标全部交付，共 ' + iteration + ' 次尝试，花费 ' + spentMinor + '/' + budget + ' 分。');
  }

  return {
    pipelineId: plan.planId, title: plan.title, goal: plan.goal, stage, iteration,
    budgetMinor: budget, spentMinor, costPerAttemptMinor: cost,
    architect: { planner: plan.planner, notes: [...plan.notes] },
    reviewer: { agent: plan.reviewerAgent, checks: plan.steps.reduce((sum, step) => sum + step.contract.length, 0) },
    steps, events, notifications,
    createdAt, updatedAt: now()
  };
}

function agentLabel(agent: PipelineAgent): string {
  return agent === 'dsh' ? 'DeepSeek Harness' : agent === 'codex' ? 'Codex' : 'Claude Code';
}

export type PipelineDemoMode = 'pass' | 'rework' | 'blocked' | 'budget';

/**
 * 离线 fixture 推演执行器：不触达任何真实模型，只用于演示整条闭环（含一次返工）。
 * 真实执行链接入后，用真实 executor 替换即可，内核不变。
 */
export function demoExecutor(mode: PipelineDemoMode): PipelineExecutor {
  return ({ step, attempt }) => {
    const base = { agent: step.agent, subgoal: step.title, attempt: attempt + 1 };
    if (mode === 'pass') return { artifacts: { result: { ok: true, ...base } } };
    if (mode === 'rework') {
      // 第一步第一次故意不合格，评审否决后返工通过；其余直接通过。
      const ok = step.stepId !== 'sub-1' || attempt > 0;
      return { artifacts: { result: { ok, ...base } } };
    }
    if (mode === 'blocked') return { artifacts: { result: { ok: false, ...base } } };
    return { artifacts: { result: { ok: false, ...base } } }; // budget 模式同样一直不合格，但会被额度先截断
  };
}

export interface SimulatePipelineInput {
  title: string;
  goal: string;
  subgoals?: readonly string[];
  catalog: AvailableModelsView;
  bindings?: readonly ModelBindingView[];
  maxReworks?: number;
  budgetMinor?: number;
  costPerAttemptMinor?: number;
  mode?: PipelineDemoMode;
}

/** HTTP 用的便捷入口：规划 + 离线推演，返回完整视图。 */
export async function simulatePipeline(input: SimulatePipelineInput): Promise<PipelineRunView> {
  const plan = planPipeline({
    title: input.title, goal: input.goal,
    ...(input.subgoals ? { subgoals: input.subgoals } : {}),
    catalog: input.catalog, bindings: input.bindings ?? [],
    ...(typeof input.maxReworks === 'number' ? { maxReworks: input.maxReworks } : {})
  });
  const mode: PipelineDemoMode = input.mode ?? 'rework';
  const budgetMinor = Number.isSafeInteger(input.budgetMinor) ? (input.budgetMinor as number) : 50;
  const costPerAttemptMinor = Number.isSafeInteger(input.costPerAttemptMinor) ? (input.costPerAttemptMinor as number) : 1;
  return runPipeline(plan, {
    executor: demoExecutor(mode),
    budgetMinor: mode === 'budget' ? Math.min(budgetMinor, 1) : budgetMinor,
    costPerAttemptMinor
  });
}
