import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * M5 — Daming provider-plugin contract (the seed of replacing Magpie's plugins).
 * A provider is a plugin that serves one or more models over an OpenAI-shaped
 * chat-completions call. Built-ins wrap OpenAI-compatible upstreams (Ollama, …);
 * future plugins can implement the same interface (and later an `auth.checkin(hook)`).
 */
export interface ProviderResult { readonly status: number; readonly contentType: string; readonly bodyText: string }
export interface ProviderPlugin {
  readonly id: string;
  readonly models: readonly string[];
  /** Base URL for raw streaming passthrough (no trailing slash); optional. */
  readonly streamBaseUrl?: string;
  /** Relative routing weight (default 1). */
  readonly weight?: number;
  /** One non-stream chat-completions call; returns upstream-shaped OpenAI JSON text. Throws on transport error. */
  complete(bodyText: string): Promise<ProviderResult>;
}

function post(url: string, bodyText: string, timeoutMs = 120000, extraHeaders: Record<string, string> = {}): Promise<ProviderResult> {
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? httpsRequest : httpRequest;
  const payload = Buffer.from(bodyText, 'utf8');
  return new Promise((resolve, reject) => {
    const req = lib({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(payload.length), ...extraHeaders }, timeout: timeoutMs }, (r) => {
      const chunks: Buffer[] = [];
      r.on('data', (d: Buffer) => chunks.push(d));
      r.on('end', () => resolve({ status: r.statusCode ?? 502, contentType: String(r.headers['content-type'] ?? 'application/json'), bodyText: Buffer.concat(chunks).toString('utf8') }));
      r.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('upstream_timeout')); });
    req.on('error', reject);
    req.end(payload);
  });
}

/** Built-in plugin for any OpenAI-compatible upstream (Ollama, DeepSeek, a relay, …). */
export function openAICompatiblePlugin(o: { id: string; baseUrl: string; models: readonly string[]; timeoutMs?: number; headers?: Record<string, string>; weight?: number }): ProviderPlugin {
  const base = o.baseUrl.replace(/\/+$/, '');
  return {
    id: o.id, models: o.models,
    // If auth headers are needed, raw stream passthrough can't attach them, so omit
    // streamBaseUrl and let the gateway synthesize SSE from complete() (which has auth).
    ...((o.headers && Object.keys(o.headers).length) ? {} : { streamBaseUrl: base }),
    ...(typeof o.weight === 'number' ? { weight: o.weight } : {}),
    complete: (bodyText: string) => post(base + '/v1/chat/completions', bodyText, o.timeoutMs ?? 120000, o.headers ?? {}),
  };
}

/** Anthropic-Messages-compatible upstream (ZCode/GLM, Anthropic). Accepts an OpenAI chat body, calls /v1/messages, returns OpenAI JSON. */
export function anthropicCompatiblePlugin(o: { id: string; baseUrl: string; models: readonly string[]; timeoutMs?: number; headers?: Record<string, string>; weight?: number }): ProviderPlugin {
  const base = o.baseUrl.replace(/\/+$/, '');
  return {
    id: o.id, models: o.models,
    ...(typeof o.weight === 'number' ? { weight: o.weight } : {}),
    async complete(bodyText: string): Promise<ProviderResult> {
      const b = JSON.parse(bodyText) as Record<string, unknown>;
      const msgs = Array.isArray(b.messages) ? b.messages as Array<Record<string, unknown>> : [];
      let system = ''; const out: Array<{ role: string; content: string }> = [];
      for (const m of msgs) {
        const c = typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>).map((x) => String(x?.text ?? '')).join('') : '');
        if (m.role === 'system') system = system ? system + '\n' + c : c;
        else out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: c });
      }
      const req: Record<string, unknown> = { model: b.model, max_tokens: typeof b.max_tokens === 'number' ? b.max_tokens : 1024, messages: out.length ? out : [{ role: 'user', content: 'hi' }] };
      if (system) req.system = system;
      const r = await post(base + '/v1/messages', JSON.stringify(req), o.timeoutMs ?? 120000, { 'anthropic-version': '2023-06-01', ...(o.headers ?? {}) });
      if (r.status !== 200) return r;
      let text = '', usage = { prompt_tokens: 0, completion_tokens: 0 };
      try { const j = JSON.parse(r.bodyText) as Record<string, unknown>; text = (Array.isArray(j.content) ? (j.content as Array<Record<string, unknown>>).filter((c) => c.type === 'text').map((c) => String(c.text ?? '')).join('') : ''); const u = (j.usage ?? {}) as Record<string, number>; usage = { prompt_tokens: u.input_tokens ?? 0, completion_tokens: u.output_tokens ?? 0 }; } catch { /* ignore */ }
      return { status: 200, contentType: 'application/json', bodyText: JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage }) };
    },
  };
}

/** OpenAI-Responses-compatible upstream. Accepts an OpenAI chat body, calls /v1/responses, returns OpenAI chat JSON. */
export function openAIResponsesPlugin(o: { id: string; baseUrl: string; models: readonly string[]; timeoutMs?: number; headers?: Record<string, string>; weight?: number }): ProviderPlugin {
  const base = o.baseUrl.replace(/\/+$/, '');
  return {
    id: o.id, models: o.models,
    ...(typeof o.weight === 'number' ? { weight: o.weight } : {}),
    async complete(bodyText: string): Promise<ProviderResult> {
      const b = JSON.parse(bodyText) as Record<string, unknown>;
      const msgs = Array.isArray(b.messages) ? b.messages as Array<Record<string, unknown>> : [];
      const last = [...msgs].reverse().find((m) => m && m.role === 'user');
      const prompt = last && typeof last.content === 'string' ? last.content : (typeof b.input === 'string' ? b.input : 'hi');
      const req: Record<string, unknown> = { model: b.model, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }] };
      if (typeof b.max_tokens === 'number') req.max_output_tokens = b.max_tokens;
      const r = await post(base + '/v1/responses', JSON.stringify(req), o.timeoutMs ?? 120000, o.headers ?? {});
      if (r.status !== 200) return r;
      let text = '', usage = { prompt_tokens: 0, completion_tokens: 0 };
      try { const j = JSON.parse(r.bodyText) as Record<string, unknown>; text = typeof j.output_text === 'string' ? j.output_text : (Array.isArray(j.output) ? (j.output as Array<Record<string, unknown>>).flatMap((o2) => Array.isArray(o2.content) ? (o2.content as Array<Record<string, unknown>>) : []).map((c) => String(c.text ?? '')).join('') : ''); const u = (j.usage ?? {}) as Record<string, number>; usage = { prompt_tokens: u.input_tokens ?? 0, completion_tokens: u.output_tokens ?? 0 }; } catch { /* ignore */ }
      return { status: 200, contentType: 'application/json', bodyText: JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage }) };
    },
  };
}

/**
 * Weighted smooth round-robin routing + health circuit-breaker.
 * - candidates(model): healthy plugins serving the model, weighted round-robin order;
 *   cooling-down (recently failed) plugins are pushed to the end as last-resort.
 * - markFailure(id): cool the plugin down for `cooldownMs`; markSuccess(id): clear.
 */
export class ProviderRegistry {
  private readonly plugins: ProviderPlugin[] = [];
  private readonly current = new Map<string, number>();
  private readonly cooldownUntil = new Map<string, number>();
  private readonly cooldownMs: number;
  constructor(options: { cooldownMs?: number } = {}) { this.cooldownMs = options.cooldownMs ?? 20000; }
  register(plugin: ProviderPlugin): void {
    if (!plugin || typeof plugin.id !== 'string' || !plugin.id || typeof plugin.complete !== 'function') throw new Error('provider_plugin_invalid');
    if (this.plugins.some((p) => p.id === plugin.id)) throw new Error('provider_plugin_duplicate');
    this.plugins.push(plugin);
  }
  all(): readonly ProviderPlugin[] { return [...this.plugins]; }
  models(): string[] { const s = new Set<string>(); for (const p of this.plugins) for (const m of p.models) s.add(m); return [...s]; }
  markFailure(id: string, nowMs: number = Date.now()): void { this.cooldownUntil.set(id, nowMs + this.cooldownMs); }
  markSuccess(id: string): void { this.cooldownUntil.delete(id); }
  private healthy(p: ProviderPlugin, nowMs: number): boolean { const u = this.cooldownUntil.get(p.id); return u === undefined || nowMs >= u; }
  private weight(p: ProviderPlugin): number { return typeof p.weight === 'number' && p.weight > 0 ? p.weight : 1; }
  candidates(model: string, nowMs: number = Date.now()): ProviderPlugin[] {
    const serving = this.plugins.filter((p) => p.models.length === 0 || p.models.includes(model));
    if (!serving.length) return [];
    const healthy = serving.filter((p) => this.healthy(p, nowMs));
    const pool = healthy.length ? healthy : serving;
    let total = 0, best = pool[0], bestW = -Infinity;
    for (const p of pool) {
      const w = this.weight(p);
      const cw = (this.current.get(p.id) ?? 0) + w;
      this.current.set(p.id, cw); total += w;
      if (cw > bestW) { bestW = cw; best = p; }
    }
    this.current.set(best.id, (this.current.get(best.id) ?? 0) - total);
    const rest = pool.filter((p) => p.id !== best.id);
    const cooling = serving.filter((p) => !pool.includes(p));
    return [best, ...rest, ...cooling];
  }
}
