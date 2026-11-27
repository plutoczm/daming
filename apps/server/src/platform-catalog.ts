/**
 * 平台目录（P0）：供应商配置 + Agent 档案 + LLM 切换。均为 Daming 自有、配置驱动，
 * 不依赖 Magpie 桌面 App。供应商密钥只以环境变量名（apiKeyEnv）表达，不落明文。
 *
 * providers.json 与 `config/providers.example.json` 同构，可被 daming-gateway 直接加载
 * （DAMING_GATEWAY_PROVIDERS_FILE 指向它）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentProfileView, AgentTarget, ProviderApi, ProviderConfigView } from '@daming/contracts';

const APIS: readonly ProviderApi[] = ['openai-completions', 'openai-responses', 'anthropic-messages'];
const RUNTIMES: readonly AgentTarget[] = ['dsh', 'codex', 'claude-code'];
const ID = /^[a-z0-9][a-z0-9._-]{1,39}$/i;
const ENV = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 运行 Harness 由模型供应商决定：Codex/OpenAI 系 → Codex CLI，Claude/Anthropic → Claude Code。
 * 其余供应商（DeepSeek/WorkBuddy/Ollama/Qwen 等）返回 undefined，保留档案既有的 runtime
 * （通常为 dsh）。避免「选了 Codex 的模型却仍绑 Claude Code」。
 */
export function runtimeForProvider(providerId: string | undefined): AgentTarget | undefined {
  if (!providerId) return undefined;
  const id = providerId.toLowerCase();
  if (id === 'codex' || id === 'openai') return 'codex';
  if (id === 'claude' || id === 'claude-code' || id === 'anthropic') return 'claude-code';
  return undefined;
}

/** 去掉 modelId 里重复的供应商前缀（历史数据里存过 `codex/gpt-6.2-sol` 这类带前缀值）。 */
function cleanModelId(providerId: string | undefined, modelId: string | undefined): string | undefined {
  if (!modelId) return modelId;
  if (providerId && modelId.startsWith(providerId + '/')) return modelId.slice(providerId.length + 1);
  return modelId;
}

export class PlatformCatalogError extends Error {
  readonly status: number;
  constructor(status: number, reason: string) { super(reason); this.status = status; }
}

function str(value: unknown, field: string, max = 400): string {
  if (typeof value !== 'string' || !value.trim()) throw new PlatformCatalogError(400, 'missing_' + field);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new PlatformCatalogError(400, 'too_long_' + field);
  return trimmed;
}

function normalizeProvider(raw: unknown): ProviderConfigView {
  if (!raw || typeof raw !== 'object') throw new PlatformCatalogError(400, 'invalid_provider');
  const input = raw as Record<string, unknown>;
  const id = str(input.id, 'provider_id', 40);
  if (!ID.test(id)) throw new PlatformCatalogError(400, 'invalid_provider_id');
  const api = input.api;
  if (typeof api !== 'string' || !APIS.includes(api as ProviderApi)) throw new PlatformCatalogError(400, 'invalid_provider_api');
  const baseUrl = str(input.baseUrl, 'base_url', 500);
  if (!/^https?:\/\//i.test(baseUrl)) throw new PlatformCatalogError(400, 'invalid_base_url');
  if (!Array.isArray(input.models) || input.models.length === 0) throw new PlatformCatalogError(400, 'missing_models');
  const models = [...new Set((input.models as unknown[]).map((m) => str(m, 'model', 120)))];
  let apiKeyEnv: string | undefined;
  if (input.apiKeyEnv !== undefined) {
    const env = str(input.apiKeyEnv, 'api_key_env', 80);
    if (!ENV.test(env)) throw new PlatformCatalogError(400, 'invalid_api_key_env');
    apiKeyEnv = env;
  }
  let headers: Record<string, string> | undefined;
  if (input.headers !== undefined) {
    if (!input.headers || typeof input.headers !== 'object' || Array.isArray(input.headers)) throw new PlatformCatalogError(400, 'invalid_headers');
    headers = {};
    for (const [key, value] of Object.entries(input.headers as Record<string, unknown>)) {
      headers[key] = str(value, 'header', 500);
    }
  }
  let weight: number | undefined;
  if (input.weight !== undefined) {
    if (typeof input.weight !== 'number' || !Number.isFinite(input.weight) || input.weight <= 0) throw new PlatformCatalogError(400, 'invalid_weight');
    weight = input.weight;
  }
  return { id, api: api as ProviderApi, baseUrl, models, ...(apiKeyEnv ? { apiKeyEnv } : {}), ...(headers ? { headers } : {}), ...(weight ? { weight } : {}) };
}

interface ProviderFile { defaultModel?: string; providers: ProviderConfigView[]; }

export class ProviderStore {
  readonly file: string;
  private data: ProviderFile;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = join(dataDir, 'providers.json');
    try {
      const parsed = (existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : null) as Partial<ProviderFile> | null;
      this.data = parsed && Array.isArray(parsed.providers)
        ? { ...(typeof parsed.defaultModel === 'string' ? { defaultModel: parsed.defaultModel } : {}), providers: parsed.providers }
        : { providers: [] };
    } catch { this.data = { providers: [] }; }
  }
  private persist(): void {
    try { writeFileSync(this.file, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 }); } catch { /* best effort */ }
  }
  list(): ProviderConfigView[] { return [...this.data.providers]; }
  defaultModel(): string | null { return this.data.defaultModel ?? null; }
  add(raw: unknown): ProviderConfigView {
    const provider = normalizeProvider(raw);
    const others = this.data.providers.filter((item) => item.id !== provider.id);
    this.data.providers = [...others, provider];
    if (!this.data.defaultModel && provider.models.length) this.data.defaultModel = provider.models[0];
    this.persist();
    return provider;
  }
  remove(id: string): boolean {
    const before = this.data.providers.length;
    this.data.providers = this.data.providers.filter((item) => item.id !== id);
    if (this.data.providers.length === before) return false;
    this.persist();
    return true;
  }
}

function normalizeAgent(raw: unknown): AgentProfileView {
  if (!raw || typeof raw !== 'object') throw new PlatformCatalogError(400, 'invalid_agent');
  const input = raw as Record<string, unknown>;
  const agentId = str(input.agentId, 'agent_id', 40);
  if (!ID.test(agentId)) throw new PlatformCatalogError(400, 'invalid_agent_id');
  const name = str(input.name, 'agent_name', 80);
  const runtime = input.runtime;
  if (typeof runtime !== 'string' || !RUNTIMES.includes(runtime as AgentTarget)) throw new PlatformCatalogError(400, 'invalid_agent_runtime');
  const providerId = input.providerId === undefined ? undefined : str(input.providerId, 'provider_id', 40);
  const modelId = input.modelId === undefined ? undefined : str(input.modelId, 'model_id', 120);
  const instructions = input.instructions === undefined ? undefined : str(input.instructions, 'instructions', 4000);
  return {
    agentId, name, runtime: runtime as AgentTarget,
    ...(providerId ? { providerId } : {}), ...(modelId ? { modelId } : {}), ...(instructions ? { instructions } : {}),
    createdAt: new Date().toISOString(),
  };
}

interface AgentFile { agents: AgentProfileView[]; }

export class AgentProfileStore {
  private readonly file: string;
  private data: AgentFile;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = join(dataDir, 'agents.json');
    try {
      const parsed = (existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : null) as Partial<AgentFile> | null;
      const agents = parsed && Array.isArray(parsed.agents) ? parsed.agents : [];
      // 归一：若已绑定供应商，则 runtime 跟随供应商推导（修正历史上 provider 与 runtime 不一致的档案）。
      let changed = false;
      const normalized = agents.map((agent) => {
        const derived = runtimeForProvider(agent.providerId);
        const cleanedModel = cleanModelId(agent.providerId, agent.modelId);
        const nextRuntime = derived ?? agent.runtime;
        if (nextRuntime !== agent.runtime || cleanedModel !== agent.modelId) {
          changed = true;
          return { ...agent, runtime: nextRuntime, ...(cleanedModel !== undefined ? { modelId: cleanedModel } : {}) };
        }
        return agent;
      });
      this.data = { agents: normalized };
      if (changed) this.persist();
    } catch { this.data = { agents: [] }; }
  }
  private persist(): void {
    try { writeFileSync(this.file, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 }); } catch { /* best effort */ }
  }
  list(): AgentProfileView[] { return [...this.data.agents].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  get(agentId: string): AgentProfileView | undefined { return this.data.agents.find((item) => item.agentId === agentId); }
  add(raw: unknown): AgentProfileView {
    const base = normalizeAgent(raw);
    const derived = runtimeForProvider(base.providerId);
    const cleaned = cleanModelId(base.providerId, base.modelId);
    const agent: AgentProfileView = {
      ...base,
      ...(derived ? { runtime: derived } : {}),
      ...(cleaned !== undefined ? { modelId: cleaned } : {})
    };
    const existing = this.get(agent.agentId);
    const other = this.data.agents.filter((item) => item.agentId !== agent.agentId);
    // 保留原 createdAt（更新档案时不重置）
    this.data.agents = [...other, existing ? { ...agent, createdAt: existing.createdAt } : agent];
    this.persist();
    return this.get(agent.agentId)!;
  }
  remove(agentId: string): boolean {
    const before = this.data.agents.length;
    this.data.agents = this.data.agents.filter((item) => item.agentId !== agentId);
    if (this.data.agents.length === before) return false;
    this.persist();
    return true;
  }
  setModel(agentId: string, providerId: string, modelId: string): AgentProfileView {
    const agent = this.get(agentId);
    if (!agent) throw new PlatformCatalogError(404, 'agent_not_found');
    const provider = str(providerId, 'provider_id', 40);
    const derived = runtimeForProvider(provider);
    const model = cleanModelId(provider, str(modelId, 'model_id', 120)) ?? '';
    const updated: AgentProfileView = { ...agent, providerId: provider, modelId: model, ...(derived ? { runtime: derived } : {}) };
    this.data.agents = this.data.agents.map((item) => item.agentId === agentId ? updated : item);
    this.persist();
    return updated;
  }
}
