/**
 * 真实项目 → 组合视图适配（P0.5）。
 *
 * 真源是 ProjectInputStore 的四件套快照（REQ-001）：spec/plan_baseline/plan_runtime/progress。
 * 这里把它的信号映射为治理内核可消费的 PortfolioProjectView：
 *  - spec 与 plan 冲突（requiresHumanArbitration）→ 契约类升级（A，需人裁决）
 *  - progress.status = blocked → 异常（E，阻塞）
 *  - progress.status = doing 且长时间未更新 → 异常（E，停滞）
 *  - 预算/证据/连续失败暂不在此来源中，置安全默认（null / false / 0）——绝不臆造。
 *
 * 纯函数：不写状态、不联网。
 */
import type { PortfolioProjectView, PortfolioRiskLevel } from '@daming/contracts';
import type { FrozenProjectInput, ProgressSnapshot } from './project-input.ts';

const STALL_THRESHOLD_MIN = 30;

export function projectInputToPortfolioView(input: {
  readonly projectId: string;
  readonly name?: string;
  readonly frozen: FrozenProjectInput;
  readonly progress: ProgressSnapshot | undefined;
  readonly now: number;
}): PortfolioProjectView {
  const { projectId, frozen, progress, now } = input;
  const pendingDecisions: { decisionId: string; kind: 'clarification' | 'proposal' | 'acceptance'; question: string }[] = [];
  if (frozen.requiresHumanArbitration) {
    pendingDecisions.push({
      decisionId: 'conflict:' + projectId, kind: 'proposal',
      question: 'spec 与 plan 存在冲突，需裁决（spec 优先，plan 不得降低验收）',
    });
  }
  const blockers: { id: string; severity: PortfolioRiskLevel }[] = [];
  if (progress?.status === 'blocked') blockers.push({ id: 'progress:blocked', severity: 'medium' });

  const doing = progress?.status === 'doing';
  const stalledMinutes = doing && progress
    ? Math.max(0, Math.floor((now - Date.parse(progress.updatedAt)) / 60000))
    : 0;

  return {
    projectId,
    name: input.name ?? projectId,
    goal: frozen.spec[0]?.text ?? projectId,
    accepted: false,
    pendingDecisions,
    blockers,
    stalledMinutes: stalledMinutes >= STALL_THRESHOLD_MIN ? stalledMinutes : 0,
    consecutiveFailures: 0,
    budget: null,
    evidencePassed: false,
    lastActivityAt: progress?.updatedAt ?? frozen.frozenAt,
  };
}
