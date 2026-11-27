import { anthropicCompatiblePlugin, openAICompatiblePlugin, openAIResponsesPlugin } from './plugins.ts';
import type { ProviderPlugin } from './plugins.ts';

/**
 * M1 — config-driven model supply. Add ANY provider by config (no code change):
 * OpenAI-compatible, OpenAI-Responses, or Anthropic-Messages wire. Keys resolve from env.
 * This is the HiFox/T3 "BYOK compatible endpoint (base + key + model)" model.
 */
export type ProviderApi = 'openai-completions' | 'openai-responses' | 'anthropic-messages';
export interface ProviderConfig {
  readonly id: string;
  readonly api?: ProviderApi;
  readonly baseUrl: string;
  readonly models: readonly string[];
  /** Name of the env var holding the key (e.g. DEEPSEEK_API_KEY). */
  readonly apiKeyEnv?: string;
  /** How to present the key: Authorization: Bearer (default) or x-api-key (Anthropic). */
  readonly apiKeyHeader?: 'authorization' | 'x-api-key';
  readonly weight?: number;
  readonly headers?: Readonly<Record<string, string>>;
}
export interface GatewayConfig {
  readonly providers: readonly ProviderConfig[];
  readonly defaultModel?: string;
  readonly apiKey?: string;
}

const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const APIS: ProviderApi[] = ['openai-completions', 'openai-responses', 'anthropic-messages'];

export function pluginsFromConfig(cfg: GatewayConfig, env: NodeJS.ProcessEnv = process.env): ProviderPlugin[] {
  if (!cfg || !Array.isArray(cfg.providers) || cfg.providers.length === 0 || cfg.providers.length > 32) throw new Error('gateway_config_invalid');
  const seen = new Set<string>();
  return cfg.providers.map((p) => {
    if (!p || !ID.test(p.id) || seen.has(p.id)) throw new Error('gateway_provider_id_invalid');
    seen.add(p.id);
    const api = p.api ?? 'openai-completions';
    if (!APIS.includes(api)) throw new Error('gateway_provider_api_unsupported');
    if (typeof p.baseUrl !== 'string' || !/^https?:\/\//.test(p.baseUrl)) throw new Error('gateway_provider_baseurl_invalid');
    if (!Array.isArray(p.models) || p.models.length === 0 || p.models.length > 64) throw new Error('gateway_provider_models_invalid');
    const headers: Record<string, string> = { ...(p.headers ?? {}) };
    if (p.apiKeyEnv !== undefined) {
      const key = env[p.apiKeyEnv];
      if (typeof key !== 'string' || !key) throw new Error('gateway_provider_key_missing:' + p.id);
      if (p.apiKeyHeader === 'x-api-key') headers['x-api-key'] = key; else headers.authorization = 'Bearer ' + key;
    }
    const common = { id: p.id, baseUrl: p.baseUrl, models: p.models, headers, ...(typeof p.weight === 'number' ? { weight: p.weight } : {}) };
    if (api === 'anthropic-messages') return anthropicCompatiblePlugin(common);
    if (api === 'openai-responses') return openAIResponsesPlugin(common);
    return openAICompatiblePlugin(common);
  });
}

export function parseGatewayConfig(json: string): GatewayConfig {
  let parsed: unknown;
  const clean = json.replace(/^\uFEFF/, '');
  try { parsed = JSON.parse(clean); } catch { throw new Error('gateway_config_json_invalid'); }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as GatewayConfig).providers)) throw new Error('gateway_config_invalid');
  return parsed as GatewayConfig;
}

export function gatewayConfigModels(cfg: GatewayConfig): string[] {
  const s = new Set<string>();
  for (const p of cfg.providers ?? []) for (const m of p.models ?? []) s.add(m);
  return [...s];
}
