import type { AgentRuntimeConfig } from './model-binding.ts';

/**
 * S5 → S6 注入桥：把「选模型绑定 Agent」解析出的 AgentRuntimeConfig（一次性 key + 模型 + baseUrl）
 * 映射成三种执行器各自的启动参数形状，供 S6 执行器直接消费。
 * - Codex：model_provider 中继（baseUrl + token + model）
 * - Claude Code：ANTHROPIC_BASE_URL / API_KEY + model
 * - DSH：DEEPSEEK_BASE_URL / API_KEY + model
 * 模型来源完全由 S5 绑定决定；本模块不发起网络请求，也不持久化明文 key。
 */
export class ExecutorInjectionError extends Error {
  constructor(reason: string) { super(reason); }
}
export interface CodexExecutorInjection {
  readonly agent: 'codex';
  readonly model: string;
  readonly modelProvider: 'daming';
  readonly baseUrl: string;
  readonly token: string;
}
export interface ClaudeExecutorInjection {
  readonly agent: 'claude-code';
  readonly model: string;
  readonly baseUrl: string;
  readonly token: string;
  readonly env: Readonly<Record<string, string>>;
}
export interface DshExecutorInjection {
  readonly agent: 'dsh';
  readonly model: string;
  readonly env: Readonly<Record<string, string>>;
}
export type ExecutorInjection = CodexExecutorInjection | ClaudeExecutorInjection | DshExecutorInjection;

function requireStrings(env: Readonly<Record<string, string>>, names: readonly string[]): void {
  for (const name of names) {
    if (typeof env[name] !== 'string' || !env[name]) throw new ExecutorInjectionError('runtime_missing_' + name);
  }
}

export function executorInjection(runtime: AgentRuntimeConfig): ExecutorInjection {
  if (!runtime || typeof runtime !== 'object' || !runtime.env || typeof runtime.env !== 'object') {
    throw new ExecutorInjectionError('runtime_invalid');
  }
  const env = runtime.env;
  if (runtime.agent === 'codex') {
    requireStrings(env, ['MAGPIE_BASE_URL', 'MAGPIE_API_KEY', 'CODEX_MODEL']);
    return { agent: 'codex', model: env.CODEX_MODEL, modelProvider: 'daming', baseUrl: env.MAGPIE_BASE_URL, token: env.MAGPIE_API_KEY };
  }
  if (runtime.agent === 'claude-code') {
    requireStrings(env, ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL']);
    return { agent: 'claude-code', model: env.ANTHROPIC_MODEL, baseUrl: env.ANTHROPIC_BASE_URL, token: env.ANTHROPIC_API_KEY, env: { ...env } };
  }
  if (runtime.agent === 'dsh') {
    requireStrings(env, ['DEEPSEEK_BASE_URL', 'DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL']);
    return { agent: 'dsh', model: env.DEEPSEEK_MODEL, env: { ...env } };
  }
  throw new ExecutorInjectionError('agent_unsupported');
}
