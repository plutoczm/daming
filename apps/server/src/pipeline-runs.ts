import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AvailableModelsView, ModelBindingView, PipelineDiscussionView, PipelineRunView } from '@daming/contracts';
import {
  demoExecutor, planPipeline, reassignPipelineStep, runPipeline, runPipelineFrom,
  type PipelineAgent, type PipelineDemoMode, type PipelinePlan, type PipelineRunSeed
} from './pipeline.ts';
import { AgentRoomStore, fixtureRoomResponder, type RoomMember, type RoomResponder } from './agent-room.ts';
import type { PipelineRuntimeKind, RealPipelineRuntime } from './pipeline-real.ts';

/**
 * 执行链的「留存 + 协作群 + 任意阶段换人重跑」层。
 *
 * - 把一条执行链（plan + run view）持久化，供「换 Agent/模型 → 重跑某阶段」反复推进；
 * - 每步执行/评审结果自动回传到项目专属 Agents 协作群（指挥官 + 参与 Agent + 评审员）；
 * - 编排内核仍是纯的 pipeline.ts（runPipelineFrom + reassignPipelineStep），副作用只在
 *   本层：离线 demoExecutor 或（后续）真实执行器注入。
 */

const AGENT_LABEL: Record<string, string> = { dsh: 'DeepSeek Harness', codex: 'Codex', 'claude-code': 'Claude Code' };

export interface PipelineRunRecord {
  readonly runId: string;
  readonly plan: PipelinePlan;
  readonly view: PipelineRunView;
  readonly budgetMinor: number;
  readonly costPerAttemptMinor: number;
  readonly mode: PipelineDemoMode;
  /** 执行/评审来源：离线 fixture 或真实模型。 */
  readonly executorKind: 'offline' | 'real';
  readonly roomId: string | null;
  readonly updatedAt: string;
}

export class PipelineRunStore {
  private readonly file: string;
  private records: PipelineRunRecord[];
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = join(dataDir, 'pipeline-runs.json');
    try { this.records = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) as PipelineRunRecord[] : []; }
    catch { this.records = []; }
  }
  list(): PipelineRunRecord[] { return [...this.records].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  get(runId: string): PipelineRunRecord | undefined { return this.records.find((record) => record.runId === runId); }
  save(record: PipelineRunRecord): void {
    this.records = [record, ...this.records.filter((item) => item.runId !== record.runId)].slice(0, 30);
    this.persist();
  }
  private persist(): void {
    try { writeFileSync(this.file, JSON.stringify(this.records, null, 2) + '\n', { mode: 0o600 }); } catch { /* best effort */ }
  }
}

export interface CreatePipelineRunInput {
  readonly title: string;
  readonly goal: string;
  readonly subgoals?: readonly string[];
  readonly catalog: AvailableModelsView;
  readonly bindings?: readonly ModelBindingView[];
  readonly maxReworks?: number;
  readonly budgetMinor?: number;
  readonly costPerAttemptMinor?: number;
  readonly mode?: PipelineDemoMode;
  /** 真实运行时（执行/评审/讨论走真实模型）；缺省走离线 demoExecutor。 */
  readonly runtime?: RealPipelineRuntime;
}

/** 规划 + 执行一次执行链，产出可留存的运行记录（尚未关联协作群）。 */
export async function createAndRunPipeline(input: CreatePipelineRunInput): Promise<PipelineRunRecord> {
  const plan = planPipeline({
    title: input.title, goal: input.goal,
    ...(input.subgoals ? { subgoals: input.subgoals } : {}),
    catalog: input.catalog, bindings: input.bindings ?? [],
    ...(typeof input.maxReworks === 'number' ? { maxReworks: input.maxReworks } : {})
  });
  const mode: PipelineDemoMode = input.mode ?? 'rework';
  const budgetMinor = Number.isSafeInteger(input.budgetMinor) ? (input.budgetMinor as number) : 50;
  const costPerAttemptMinor = Number.isSafeInteger(input.costPerAttemptMinor) ? (input.costPerAttemptMinor as number) : 1;
  const runtime = input.runtime;
  const executorKind: PipelineRuntimeKind = runtime ? 'real' : 'offline';
  const view = await runPipeline(plan, {
    executor: runtime ? runtime.executor : demoExecutor(mode),
    ...(runtime ? { review: runtime.review } : {}),
    budgetMinor: mode === 'budget' ? Math.min(budgetMinor, 1) : budgetMinor,
    costPerAttemptMinor
  });
  const runId = plan.planId;
  return {
    runId, plan,
    view: { ...view, runId, executor: executorKind, reviewerKind: runtime ? 'model' : 'contract' },
    budgetMinor, costPerAttemptMinor, mode, executorKind, roomId: null,
    updatedAt: new Date().toISOString()
  };
}

/** 带续跑种子从 fromIndex 起重跑：保留前若干步已通过状态，重新执行目标阶段及之后。 */
async function rerunFrom(record: PipelineRunRecord, plan: PipelinePlan, fromIndexRaw: number, runtime?: RealPipelineRuntime): Promise<PipelineRunView> {
  const total = plan.steps.length;
  const fromIndex = Math.max(0, Math.min(fromIndexRaw < 0 ? total : fromIndexRaw, total));
  const seed: PipelineRunSeed = {
    statuses: record.view.steps.slice(0, fromIndex).map((step) => ({
      status: step.status, attempts: step.attempts, lastReview: step.lastReview
    })),
    // 每次重跑给这一段一个新的执行预算窗口，避免上一轮已花额度把重跑瞬间截断。
    spentMinor: 0,
    iteration: 0
  };
  return runPipelineFrom(plan, {
    executor: runtime ? runtime.executor : demoExecutor(record.mode),
    ...(runtime ? { review: runtime.review } : {}),
    budgetMinor: record.budgetMinor,
    costPerAttemptMinor: record.costPerAttemptMinor,
    fromIndex, seed
  });
}

/** 把某一步换成指定 Agent + 模型，并从该阶段真正重跑（已执行阶段保留，目标及之后重跑）。 */
export async function reassignAndRerun(record: PipelineRunRecord, stepId: string, choice: {
  agent: PipelineAgent; providerId?: string; modelId?: string;
}, runtime?: RealPipelineRuntime): Promise<PipelineRunRecord> {
  const plan = reassignPipelineStep(record.plan, stepId, choice);
  const index = plan.steps.findIndex((step) => step.stepId === stepId);
  const fromIndex = index < 0 ? 0 : index;
  const view = await rerunFrom(record, plan, fromIndex, runtime);
  const executorKind: PipelineRuntimeKind = runtime ? 'real' : record.executorKind;
  return {
    ...record, plan, executorKind,
    view: { ...view, runId: record.runId, roomId: record.roomId, executor: executorKind, reviewerKind: runtime ? 'model' : record.view.reviewerKind },
    updatedAt: new Date().toISOString()
  };
}

/** 不改分配，直接重跑指定阶段及之后（例如评审不通过后想再跑一次）。 */
export async function rerunPipelineStage(record: PipelineRunRecord, stepId: string, runtime?: RealPipelineRuntime): Promise<PipelineRunRecord> {
  const index = record.plan.steps.findIndex((step) => step.stepId === stepId);
  const fromIndex = index < 0 ? 0 : index;
  const view = await rerunFrom(record, record.plan, fromIndex, runtime);
  return {
    ...record,
    view: { ...view, runId: record.runId, roomId: record.roomId, executor: record.executorKind, reviewerKind: runtime ? 'model' : record.view.reviewerKind },
    updatedAt: new Date().toISOString()
  };
}

/**
 * 把执行链每一步的执行/评审结果回传到项目专属协作群，并把讨论回传挂到各步骤视图上。
 * 首次会创建群（指挥官 + 各阶段 Agent + 评审员）；重跑时复用同一群继续追加。
 */
export async function syncPipelineRoom(store: AgentRoomStore, record: PipelineRunRecord, responder: RoomResponder = fixtureRoomResponder): Promise<{
  roomId: string;
  discussions: Record<string, PipelineDiscussionView[]>;
}> {
  const members: RoomMember[] = [{ agentId: 'commander', name: '指挥官', runtime: 'dsh' }];
  const seen = new Set<string>(['dsh']);
  for (const step of record.plan.steps) {
    if (seen.has(step.agent)) continue;
    seen.add(step.agent);
    members.push({ agentId: step.agent, name: AGENT_LABEL[step.agent] ?? step.agent, runtime: step.agent });
  }
  const reviewer = record.plan.reviewerAgent;
  if (!seen.has(reviewer)) {
    seen.add(reviewer);
    members.push({ agentId: reviewer, name: AGENT_LABEL[reviewer] ?? reviewer, runtime: reviewer });
  }
  let roomId = record.roomId;
  let room = roomId ? store.get(roomId) : undefined;
  if (!room) {
    const created = store.create({ title: '执行链 · ' + record.plan.title, members });
    roomId = created.roomId;
  } else {
    for (const member of members) {
      if (!room.members.some((existing) => existing.agentId === member.agentId)) {
        room = store.addMember(roomId!, member) ?? room;
      }
    }
  }
  if (!roomId) return { roomId: '', discussions: {} };

  store.postMessage(roomId, {
    role: 'agent', name: '指挥官', agentId: 'commander',
    text: '收到执行链「' + record.plan.title + '」：拆为 ' + record.plan.steps.length + ' 阶段，按能力/绑定/成本分配 Agent 与模型，完成情况我在群里汇报。'
  });

  const at = new Date().toISOString();
  const discussions: Record<string, PipelineDiscussionView[]> = {};
  const execMember = (agent: string): RoomMember => members.find((m) => m.agentId === agent) ?? members[0]!;
  const reviewerMember = execMember(reviewer);
  for (const step of record.view.steps) {
    const lines: PipelineDiscussionView[] = [];
    const exec = execMember(step.agent);
    const execText = '【' + exec.name + '】「' + step.title + '」用 ' + (step.providerId || '—') + '/' + (step.modelId || '—') +
      '（成本 ' + (step.costTier ?? 'mid') + ' 档）产出，结果：' +
      (step.status === 'passed' ? '已通过评审' : step.status === 'failed' ? '未通过评审' : '执行中') + '。';
    const reviewText = step.lastReview
      ? '【' + reviewerMember.name + '·评审】「' + step.title + '」' + (step.lastReview.verdict === 'pass' ? '通过' : '不通过：' + step.lastReview.reasons.join('、')) + '。'
      : '【' + reviewerMember.name + '·评审】「' + step.title + '」待评测。';
    for (const message of [
      { role: 'agent' as const, name: exec.name, agentId: exec.agentId, text: execText },
      { role: 'agent' as const, name: reviewerMember.name, agentId: reviewerMember.agentId, text: reviewText }
    ]) {
      lines.push({ at, ...message });
      store.postMessage(roomId, message);
    }
    if (step.status !== 'passed') {
      for (const member of [members[0]!, exec, reviewerMember]) {
        const text = await responder(member, { userText: step.title, transcript: lines.map((line) => line.name + ': ' + line.text).join('\n') });
        lines.push({ at, role: 'agent', name: member.name, agentId: member.agentId, text });
        store.postMessage(roomId, { role: 'agent', name: member.name, agentId: member.agentId, text });
      }
    }
    discussions[step.stepId] = lines;
  }
  return { roomId, discussions };
}

/** 把协作群讨论回传挂到运行视图，并记录 roomId（供持久化后再读时直接展示）。 */
export function attachRoomDiscussions(record: PipelineRunRecord, roomId: string, discussions: Record<string, PipelineDiscussionView[]>): PipelineRunRecord {
  return {
    ...record,
    roomId,
    view: {
      ...record.view,
      runId: record.runId,
      roomId,
      steps: record.view.steps.map((step) => ({ ...step, discussion: discussions[step.stepId] ?? [] }))
    },
    updatedAt: new Date().toISOString()
  };
}

/** 稳定短 id（用于日志/去重，不参与业务主键）。 */
export function shortRunId(runId: string): string {
  return createHash('sha1').update(runId).digest('hex').slice(0, 8);
}
