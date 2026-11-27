/**
 * 网关观测（P0）：逐请求用量落库 + 请求明细 + 上下文构成 + 脱敏汇总。
 * 对齐 Magpie 的「请求明细 / 上下文窗口 / 脱敏看板」。配置驱动、JSONL 持久化，不联网。
 *
 * 数据由网关（或 Agent driver）在每次请求后 append 一条；Host 读它渲染观测页。
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  GatewayContextCategory, GatewayContextCompositionView, GatewayObservabilityView,
  GatewayRequestView, GatewaySummaryView,
} from '@daming/contracts';

const CATEGORIES: readonly GatewayContextCategory[] = ['system', 'tools', 'skills', 'memory', 'files', 'tool_results', 'conversation', 'other'];

export class GatewayObsError extends Error {
  readonly status: number;
  constructor(status: number, reason: string) { super(reason); this.status = status; }
}

function num(value: unknown, field: string, opts: { min?: number; int?: boolean } = {}): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new GatewayObsError(400, 'invalid_' + field);
  if (opts.min !== undefined && value < opts.min) throw new GatewayObsError(400, 'invalid_' + field);
  return opts.int ? Math.round(value) : value;
}
function str(value: unknown, field: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim()) throw new GatewayObsError(400, 'missing_' + field);
  return value.trim().slice(0, max);
}

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,79}$/;

function normalizeRequest(raw: unknown): GatewayRequestView {
  if (!raw || typeof raw !== 'object') throw new GatewayObsError(400, 'invalid_request');
  const input = raw as Record<string, unknown>;
  const status = input.status === 'error' ? 'error' : 'ok';
  const taskId = input.taskId === undefined ? undefined : str(input.taskId, 'task_id', 80);
  if (taskId !== undefined && !TASK_ID.test(taskId)) throw new GatewayObsError(400, 'invalid_task_id');
  const contextParts = Array.isArray(input.contextParts) ? (input.contextParts as unknown[]).map((part) => {
    if (!part || typeof part !== 'object') throw new GatewayObsError(400, 'invalid_context_part');
    const item = part as Record<string, unknown>;
    const category = CATEGORIES.includes(item.category as GatewayContextCategory) ? item.category as GatewayContextCategory : 'other';
    return { label: str(item.label, 'label', 80), category, tokens: num(item.tokens, 'tokens', { min: 0, int: true }) };
  }) : undefined;
  return {
    requestId: str(input.requestId, 'request_id', 80),
    at: str(input.at, 'at', 40),
    agent: str(input.agent, 'agent', 40),
    providerId: str(input.providerId, 'provider_id', 40),
    modelId: str(input.modelId, 'model_id', 120),
    status,
    latencyMs: num(input.latencyMs, 'latency_ms', { min: 0 }),
    ...(input.firstTokenMs !== undefined ? { firstTokenMs: num(input.firstTokenMs, 'first_token_ms', { min: 0 }) } : {}),
    ...(input.outputTokenPerSec !== undefined ? { outputTokenPerSec: num(input.outputTokenPerSec, 'output_token_per_sec', { min: 0 }) } : {}),
    inputTokens: num(input.inputTokens, 'input_tokens', { min: 0, int: true }),
    outputTokens: num(input.outputTokens, 'output_tokens', { min: 0, int: true }),
    ...(input.cacheHitPercent !== undefined ? { cacheHitPercent: Math.max(0, Math.min(100, num(input.cacheHitPercent, 'cache_hit_percent'))) } : {}),
    ...(input.costMinor !== undefined ? { costMinor: num(input.costMinor, 'cost_minor', { min: 0 }) } : {}),
    maskedCount: input.maskedCount === undefined ? 0 : num(input.maskedCount, 'masked_count', { min: 0, int: true }),
    ...(input.error !== undefined ? { error: str(input.error, 'error', 300) } : {}),
    ...(input.contextLimitTokens !== undefined ? { contextLimitTokens: num(input.contextLimitTokens, 'context_limit_tokens', { min: 1, int: true }) } : {}),
    ...(contextParts ? { contextParts } : {}),
    ...(taskId ? { taskId } : {}),
    attribution: taskId ? 'task' : 'unattributed',
  };
}

export function summarize(records: readonly GatewayRequestView[]): GatewaySummaryView {
  const requests = records.length;
  const errors = records.filter((record) => record.status === 'error').length;
  const latency = requests ? records.reduce((sum, record) => sum + record.latencyMs, 0) / requests : 0;
  const cacheValues = records.map((record) => record.cacheHitPercent).filter((value): value is number => typeof value === 'number');
  const cacheHitPercentAvg = cacheValues.length ? cacheValues.reduce((a, b) => a + b, 0) / cacheValues.length : 0;
  const totalCostMinor = records.reduce((sum, record) => sum + (record.costMinor ?? 0), 0);
  const maskedTotal = records.reduce((sum, record) => sum + record.maskedCount, 0);
  return {
    requests, errors,
    avgLatencyMs: Math.round(latency * 10) / 10,
    cacheHitPercentAvg: Math.round(cacheHitPercentAvg * 10) / 10,
    totalCostMinor: Math.round(totalCostMinor * 100) / 100,
    maskedTotal,
  };
}

export function contextComposition(record: GatewayRequestView): GatewayContextCompositionView {
  const parts = record.contextParts ?? [];
  const used = parts.reduce((sum, part) => sum + part.tokens, 0) || record.inputTokens;
  const limit = record.contextLimitTokens ?? null;
  const remainingPercent = limit ? Math.max(0, Math.min(100, Math.round((1 - used / limit) * 1000) / 10)) : null;
  return {
    requestId: record.requestId, usedTokens: used, limitTokens: limit, remainingPercent,
    cacheHitPercent: record.cacheHitPercent ?? null,
    parts: parts.map((part) => ({ label: part.label, category: part.category, tokens: part.tokens, percent: used ? Math.round((part.tokens / used) * 1000) / 10 : 0 }))
      .sort((a, b) => b.tokens - a.tokens),
  };
}

export class RequestLogStore {
  private readonly file: string;
  private records: GatewayRequestView[];
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = join(dataDir, 'requests.jsonl');
    this.records = [];
    if (existsSync(this.file)) {
      for (const line of readFileSync(this.file, 'utf8').split('\n')) {
        const text = line.trim();
        if (!text) continue;
        try {
          const parsed = JSON.parse(text) as GatewayRequestView & { attribution?: unknown };
          // Older rows predate the attribution field: derive it from taskId only.
          this.records.push({ ...parsed, attribution: parsed.taskId ? 'task' : 'unattributed' });
        } catch { /* skip corrupt line */ }
      }
    }
    if (this.records.length > 2000) this.records = this.records.slice(-2000);
  }
  append(raw: unknown): GatewayRequestView {
    const record = normalizeRequest(raw);
    this.records.push(record);
    if (this.records.length > 2000) this.records = this.records.slice(-2000);
    try { appendFileSync(this.file, JSON.stringify(record) + '\n', { mode: 0o600 }); } catch { /* best effort */ }
    return record;
  }
  list(limit = 60): GatewayRequestView[] {
    return [...this.records].sort((a, b) => b.at.localeCompare(a.at)).slice(0, Math.max(1, Math.min(500, limit)));
  }
  get(requestId: string): GatewayRequestView | undefined { return this.records.find((record) => record.requestId === requestId); }
  /** Only rows that the gateway itself attributed to this task; never inferred. */
  recordsForTask(taskId: string): GatewayRequestView[] {
    return this.records.filter((record) => record.taskId === taskId);
  }
  clear(): void {
    this.records = [];
    try { writeFileSync(this.file, '', { mode: 0o600 }); } catch { /* best effort */ }
  }
  view(limit = 60): GatewayObservabilityView {
    const requests = this.list(limit);
    return { generatedAt: new Date().toISOString(), summary: summarize(this.records), requests };
  }
}
