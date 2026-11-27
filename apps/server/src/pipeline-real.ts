import type { PipelineCheckResultView, PipelineReviewView } from '@daming/contracts';
import { fixtureRoomResponder, type RoomResponder } from './agent-room.ts';
import type { PipelineExecutor, PipelinePlanStep, PipelineReviewFn } from './pipeline.ts';

/**
 * 执行链「真实模式」适配器：把执行、评审、协作群讨论都接到真实模型上。
 *
 * - 真实模型经 Daming 自托管 gateway（OpenAI 兼容 /v1/chat/completions）调用；
 * - 评审采用「交付物存在 + 独立模型裁决」，不再依赖离线 demoExecutor 的 json_equals 假对象；
 * - 讨论回传由真实模型按成员角色发言，失败时回退到离线 fixture 发言器，不静默丢消息；
 * - 本层只做协议适配，不持有账本/任务状态；真实计费与治理仍由 Host 的 gateway/executor 负责。
 */

export type PipelineRuntimeKind = 'offline' | 'real';

/** 真实文本端口：一个最小「给提示词 → 拿文本」的抽象，底层可为自托管 gateway 或嵌入式引擎。 */
export interface ModelTextPort {
  readonly kind: string;
  chat(prompt: string): Promise<string>;
}

export interface RealPipelineRuntime {
  readonly kind: 'real';
  readonly executor: PipelineExecutor;
  readonly review: PipelineReviewFn;
  readonly discussion: RoomResponder;
}

export interface GatewayEndpoint {
  readonly baseUrl: string;
  readonly model: string;
  readonly token?: string;
  /** 上传前对提示词做脱敏（Daming 自有网关出口的统一脱敏钩子）。 */
  readonly mask?: (text: string) => string;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '\n…（已截断）';
}

function asText(artifacts: Record<string, unknown>): string {
  const value = artifacts.result;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

/** 自托管 Daming gateway 的文本端口（OpenAI 兼容 chat/completions）。 */
export function gatewayTextPort(endpoint: GatewayEndpoint): ModelTextPort {
  const base = endpoint.baseUrl.replace(/\/+$/, '');
  return {
    kind: 'gateway:' + endpoint.model,
    async chat(prompt: string): Promise<string> {
      const outbound = endpoint.mask ? endpoint.mask(prompt) : prompt;
      const response = await fetch(base + '/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(endpoint.token ? { authorization: 'Bearer ' + endpoint.token } : {})
        },
        body: JSON.stringify({
          model: endpoint.model,
          messages: [{ role: 'user', content: outbound }],
          temperature: 0.2,
          max_tokens: 900
        })
      });
      if (!response.ok) throw new Error('gateway_http_' + response.status);
      const data = await response.json() as { choices?: { message?: { content?: string } }[] };
      const text = data.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) throw new Error('gateway_empty_response');
      return text;
    }
  };
}

function execPrompt(step: PipelinePlanStep, goal: string): string {
  const lines = [
    '你是执行链中的执行 Agent（' + step.agent + '），负责一个子目标。',
    '整体目标：' + goal,
    '子目标：' + step.title,
    '说明：' + step.description
  ];
  lines.push('请直接产出可交付的结果正文（作为交付物 result）；聚焦可用、可验收的内容，不要写客套话。');
  return lines.join('\n');
}

function reviewPrompt(step: PipelinePlanStep, artifacts: Record<string, unknown>): string {
  return [
    '你是独立评审员（不参与执行），请按验收标准审核交付物。',
    '只回复一行结论：PASS 或 FAIL，并在后面用不超过 120 字说明关键理由。',
    '子目标：' + step.title,
    '验收说明：' + step.description,
    '交付物：',
    truncate(asText(artifacts), 4000)
  ].join('\n');
}

function discussionPrompt(member: { name: string; runtime: string }, context: { userText: string; transcript: string }): string {
  return [
    '你在「大铭」执行链的项目 Agent 工作群里，成员：' + member.name + '（runtime=' + member.runtime + '）。',
    '最近消息：' + (context.userText || '（无）'),
    '群聊记录：',
    truncate(context.transcript || '（空）', 2000),
    '请用简体中文发言：聚焦下一步行动或风险，不超过 80 字，不要自称 AI。'
  ].join('\n');
}

/** 真实执行器：调用真实模型生成该步骤的交付物文本。 */
export function makeModelExecutor(port: ModelTextPort, goal: string): PipelineExecutor {
  return async ({ step }) => {
    const text = await port.chat(execPrompt(step, goal));
    return { artifacts: { result: text } };
  };
}

/** 真实评审员：交付物存在 + 独立模型裁决（PASS/FAIL）。 */
export function makeModelReviewer(port: ModelTextPort): PipelineReviewFn {
  return async ({ step, artifacts, attempt }): Promise<PipelineReviewView> => {
    const results: PipelineCheckResultView[] = [];
    const body = asText(artifacts);
    const has = typeof artifacts.result !== 'undefined' && artifacts.result !== null && body.trim().length > 0;
    results.push({ id: 'deliverable', label: '交付物存在（' + step.title + '）', kind: 'present', passed: has, ...(has ? {} : { reason: 'missing_artifact:result' }) });
    if (!has) return { verdict: 'fail', reasons: ['missing_artifact:result'], results, attempt };
    let reply = '';
    try {
      reply = await port.chat(reviewPrompt(step, artifacts));
    } catch (error) {
      return { verdict: 'fail', reasons: ['review_model_error:' + (error as Error).message], results, attempt };
    }
    const head = reply.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
    const ok = head.startsWith('PASS');
    results.push({ id: 'model', label: '模型评审', kind: 'test', passed: ok, ...(ok ? {} : { reason: 'model_reject' }) });
    return {
      verdict: ok ? 'pass' : 'fail',
      reasons: ok ? [] : ['model_reject:' + truncate(reply.replace(/\s+/g, ' ').trim(), 200)],
      results,
      attempt
    };
  };
}

/** 真实讨论发言器：让真实模型按成员角色发言；失败时回退到离线 fixture，不丢消息。 */
export function makeModelDiscussion(port: ModelTextPort): RoomResponder {
  return async (member, context) => {
    try {
      const text = await port.chat(discussionPrompt(member, context));
      return '【' + member.name + '】' + text.trim();
    } catch {
      return fixtureRoomResponder(member, context);
    }
  };
}

/** 组装真实运行时（执行 + 评审 + 讨论都走真实模型端口）。 */
export function createRealPipelineRuntime(port: ModelTextPort, goal: string): RealPipelineRuntime {
  return {
    kind: 'real',
    executor: makeModelExecutor(port, goal),
    review: makeModelReviewer(port),
    discussion: makeModelDiscussion(port)
  };
}
