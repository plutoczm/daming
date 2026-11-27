import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AvailableModelView, AvailableModelsView, ModelBindingView } from '@daming/contracts';

export type CrewAgent = 'dsh' | 'codex' | 'claude-code';
export type CrewTaskMode = 'dsh' | 'real' | 'claude' | 'local';

export interface CrewAssignment {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly agent: CrewAgent;
  readonly providerId: string;
  readonly modelId: string;
  readonly mode: CrewTaskMode;
  readonly rationale: string;
  /** 成本档：low / mid / high（按可派工模型的计费方式与剩余额度推算）。 */
  readonly costTier?: 'low' | 'mid' | 'high';
  readonly ready: boolean;
  /** Planned predecessors (advisory: dispatch still creates every ready task). */
  readonly dependsOn?: readonly string[];
}

/** Durable dispatch receipt: which child task a crew assignment became. */
export interface CrewDispatchRecord {
  readonly assignmentId: string;
  readonly taskId: string;
  readonly agent: CrewAgent;
  readonly modelId: string;
  readonly mode: CrewTaskMode;
  readonly bound: boolean;
  readonly at: string;
}

export interface CrewSkipRecord {
  readonly assignmentId: string;
  readonly reason: string;
  readonly at: string;
}

export interface CrewPlan {
  readonly planId: string;
  readonly title: string;
  readonly goal: string;
  readonly planner: 'platform' | 'main-agent';
  readonly createdAt: string;
  readonly assignments: readonly CrewAssignment[];
  readonly notes: readonly string[];
  readonly dispatchedAt?: string;
  readonly dispatches?: readonly CrewDispatchRecord[];
  readonly skipped?: readonly CrewSkipRecord[];
}

const AGENT_LABEL: Record<CrewAgent, string> = {
  dsh: 'DeepSeek Harness', codex: 'Codex', 'claude-code': 'Claude Code'
};
const MODE: Record<CrewAgent, CrewTaskMode> = { dsh: 'dsh', codex: 'real', 'claude-code': 'claude' };
const COST_LABEL: Record<'low' | 'mid' | 'high', string> = { low: '低', mid: '中', high: '高' };

const KEYWORDS: { agent: CrewAgent; words: readonly string[] }[] = [
  { agent: 'dsh', words: ['需求', '调研', '研究', '分析', '规划', '拆解', '文档', '方案', '架构', '理解', '澄清'] },
  { agent: 'codex', words: ['实现', '开发', '代码', '编码', '修复', '构建', '重构', '接口', '前端', '后端', '数据库', '脚本', '部署'] },
  { agent: 'claude-code', words: ['测试', '验收', '审查', '复核', '检查', '文档润色', '总结', '交付', '质量'] }
];

const PREFERENCE: Record<CrewAgent, readonly string[]> = {
  dsh: ['deepseek-v4-pro', 'kimi-k3.1-pro', 'deepseek-v4.1-flash', 'qwen3:8b', 'glm-5.3'],
  codex: ['gpt-6.1-sol', 'gpt-6.2-sol', 'deepseek-v4.1-flash'],
  'claude-code': ['deepseek-v4.1-flash', 'deepseek-v4-pro', 'kimi-k3.1-pro', 'claude-sonnet-4.5', 'claude-haiku-4.5']
};

function agentFor(text: string, index: number): CrewAgent {
  const hit = KEYWORDS.find((entry) => entry.words.some((word) => text.includes(word)));
  if (hit) return hit.agent;
  return (['dsh', 'codex', 'claude-code'] as const)[index % 3];
}

function modelsFor(catalog: AvailableModelsView) {
  return catalog.models.filter((model) => model.dispatchable);
}

type CostTier = 'low' | 'mid' | 'high';
/** 成本档：按计费方式（订阅/额度 vs 现金）与剩余额度推算，用于「按能力/绑定/成本」分配展示。 */
function costTierOf(model: Pick<AvailableModelView, 'billing' | 'quota' | 'sourceKind'> | undefined): CostTier {
  if (!model) return 'mid';
  const billing = String((model as { billing?: unknown }).billing ?? '');
  const remaining = model.quota?.remainingPercent;
  if (billing === 'cash') return 'high';
  if (billing === 'subscription' || billing === 'quota') {
    return typeof remaining === 'number' && remaining < 20 ? 'high' : 'low';
  }
  if (model.sourceKind === 'official_api') return 'mid';
  return 'mid';
}

function chooseModel(agent: CrewAgent, catalog: AvailableModelsView, bindings: readonly ModelBindingView[]): {
  providerId: string; modelId: string; why: string; costTier: CostTier;
} {
  const available = modelsFor(catalog);
  const bound = bindings.find((binding) => binding.agent === agent && binding.status === 'active' &&
    available.some((model) => model.modelId === binding.modelId));
  if (bound) {
    const model = available.find((item) => item.modelId === bound.modelId);
    return { providerId: bound.providerId, modelId: bound.modelId, why: '沿用该 Agent 当前绑定', costTier: costTierOf(model) };
  }
  for (const token of PREFERENCE[agent]) {
    const found = available.find((model) => model.modelId.toLowerCase().includes(token));
    if (found) return { providerId: found.providerId, modelId: found.modelId, why: `按能力偏好匹配 ${found.providerId}`, costTier: costTierOf(found) };
  }
  const first = available[0];
  if (first) return { providerId: first.providerId, modelId: first.modelId, why: '目录中第一个可派工模型', costTier: costTierOf(first) };
  return { providerId: '', modelId: '', why: '当前没有可派工模型，需先在供应商页接入', costTier: 'mid' };
}

function splitGoal(goal: string, subgoals?: readonly string[]): string[] {
  const supplied = (subgoals ?? []).map((item) => item.trim()).filter(Boolean);
  if (supplied.length) return supplied;
  const lines = goal.split(/\r?\n|[；;]/).map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, '').trim()).filter(Boolean);
  if (lines.length > 1) return lines;
  const text = goal.trim();
  if (/简单|单步|一句话/.test(text) && text.length < 60) return [text];
  return [
    '澄清需求、边界与验收标准',
    '实现核心产出',
    '验证与测试',
    '复核并整理交付'
  ];
}

/** Platform planner: splits a goal, then assigns the best Agent + supplier model from the real catalog. */
export function planCrew(input: {
  title: string; goal: string; subgoals?: readonly string[]; planner?: 'platform' | 'main-agent';
  catalog: AvailableModelsView; bindings?: readonly ModelBindingView[];
  /** `sequential` records advisory dependencies between subgoals; it never serialises the engine. */
  sequence?: 'parallel' | 'sequential';
}): CrewPlan {
  const title = input.title.trim() || '未命名编队';
  const goal = input.goal.trim();
  const subgoals = splitGoal(goal, input.subgoals);
  const bindings = input.bindings ?? [];
  const sequential = input.sequence === 'sequential';
  const assignments = subgoals.map((text, index) => {
    const agent = agentFor(text, index);
    const choice = chooseModel(agent, input.catalog, bindings);
    return {
      id: 'sub-' + (index + 1),
      title: text.slice(0, 80),
      description: text,
      agent,
      providerId: choice.providerId,
      modelId: choice.modelId,
      mode: MODE[agent],
      ready: !!choice.modelId,
      costTier: choice.costTier,
      rationale: AGENT_LABEL[agent] + ' · ' + choice.why + ' · 成本 ' + COST_LABEL[choice.costTier],
      ...(sequential && index > 0 ? { dependsOn: ['sub-' + index] } : {})
    } satisfies CrewAssignment;
  });
  const notes: string[] = [];
  if (!assignments.some((item) => item.ready)) notes.push('还没有接入可派工模型；请先到「供应商」页接入 Codex / WorkBuddy / Ollama 等。');
  if (input.planner === 'main-agent') notes.push('主 Agent 模式：当前先用平台规则拆分；接入模型后可替换为模型生成的子目标。');
  if (sequential) notes.push('顺序依赖只是计划建议：Host 仍会并行创建子任务，不会强制串行执行。');
  return {
    planId: randomUUID(), title, goal, planner: input.planner ?? 'platform',
    createdAt: new Date().toISOString(), assignments, notes
  };
}

/** Small JSON-backed plan list; the plan itself is the durable artifact for review/dispatch. */
export class CrewPlanStore {
  private readonly file: string;
  private plans: CrewPlan[];
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = join(dataDir, 'crew-plans.json');
    try { this.plans = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) as CrewPlan[] : []; }
    catch { this.plans = []; }
  }
  list(): CrewPlan[] { return [...this.plans].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  get(planId: string): CrewPlan | undefined { return this.plans.find((plan) => plan.planId === planId); }
  save(plan: CrewPlan): void {
    this.plans = [plan, ...this.plans.filter((item) => item.planId !== plan.planId)].slice(0, 50);
    this.persist();
  }
  /**
   * Record a dispatch outcome. Dispatches are append-only receipts: the plan is
   * persisted before the route answers, so history survives a reload and the UI can
   * rebuild the parent → child task tree from storage instead of React state.
   */
  recordDispatch(planId: string, records: readonly CrewDispatchRecord[], skipped: readonly CrewSkipRecord[]): CrewPlan {
    const plan = this.get(planId);
    if (!plan) throw new Error('crew_plan_not_found');
    const seen = new Set((plan.dispatches ?? []).map((item) => item.assignmentId + ':' + item.taskId));
    const merged = [...(plan.dispatches ?? [])];
    for (const record of records) {
      const key = record.assignmentId + ':' + record.taskId;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(record);
    }
    const skipMerged = [...(plan.skipped ?? [])];
    for (const entry of skipped) {
      if (skipMerged.some((existing) => existing.assignmentId === entry.assignmentId && existing.reason === entry.reason)) continue;
      skipMerged.push(entry);
    }
    const updated: CrewPlan = {
      ...plan,
      dispatchedAt: records.length ? (records[0]?.at ?? new Date().toISOString()) : plan.dispatchedAt,
      dispatches: merged,
      skipped: skipMerged
    };
    this.save(updated);
    return updated;
  }
  private persist(): void {
    try { writeFileSync(this.file, JSON.stringify(this.plans, null, 2) + '\n', { mode: 0o600 }); } catch { /* best effort */ }
  }
}
