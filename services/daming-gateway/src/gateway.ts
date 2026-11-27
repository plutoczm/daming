import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { openAICompatiblePlugin, ProviderRegistry } from './plugins.ts';
import type { ProviderPlugin } from './plugins.ts';
import { maskText, unmaskText } from './mask.ts';

/**
 * Daming-owned model gateway (M1) + plugin-driven supply (M5) + routing (M3) + usage (M4).
 * OpenAI: /v1/chat/completions, /v1/responses, /v1/models. Anthropic: /v1/messages.
 * Providers are ProviderPlugins (built-in OpenAI-compatible + custom).
 */
import { scanAccounts } from '../../accounts/src/index.ts';
import { listPlugins } from './plugin-framework.ts';

export interface GatewayProvider { readonly id: string; readonly baseUrl: string; readonly models?: readonly string[] }
export interface GatewayOptions {
  readonly providers?: readonly GatewayProvider[];
  readonly plugins?: readonly ProviderPlugin[];
  readonly upstreamBaseUrl?: string;
  readonly models?: readonly string[];
  readonly defaultModel?: string;
  readonly apiKey?: string;
  readonly usageFile?: string;
  readonly pluginsDir?: string;
  readonly maxBodyBytes?: number;
}
export interface GatewayHandle { readonly url: string; readonly server: Server; close(): Promise<void> }

interface Composition { system: number; tools: number; conversation: number }
interface UsageTotals { requests: number; inputTokens: number; outputTokens: number; cachedTokens: number; composition: Composition; byModel: Record<string, { requests: number; inputTokens: number; outputTokens: number; cachedTokens: number }> }

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => { size += d.length; if (size > limit) { reject(new Error('body_too_large')); req.destroy(); } else chunks.push(d); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function json(res: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(body.length) });
  res.end(body);
}
function html(res: ServerResponse, status: number, body: string): void {
  const buf = Buffer.from(body, 'utf8');
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(buf.length) });
  res.end(buf);
}
function esc(s: unknown): string { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string)); }
function adminHtml(u: UsageTotals, recent: readonly RecentRow[], opts: GatewayOptions): string {
  const scan = scanAccounts();
  const plugins = opts.pluginsDir ? listPlugins(opts.pluginsDir) : [];
  const models = opts.models ?? [];
  const accRows = scan.accounts.map((a) => `<tr><td>${esc(a.provider)}</td><td>${esc(a.id)}</td><td>${a.hasAccess ? 'Y' : 'N'}</td><td>${a.hasRefresh ? 'Y' : 'N'}</td><td>${esc(a.type || '')}</td><td>${a.expiresAt ? new Date(a.expiresAt * (a.expiresAt < 1e12 ? 1000 : 1)).toISOString().slice(0, 19) : ''}</td><td>${esc(a.accountId || '')}</td></tr>`).join('');
  const plRows = plugins.map((p) => `<tr><td>${p.enabled ? '✓' : '✗'}</td><td>${esc(p.manifest?.id || p.name)}</td><td>${esc(p.manifest?.kind || '')}</td><td>${esc((p.manifest?.models || []).join(','))}</td></tr>`).join('');
  const cacheRatio = u.inputTokens > 0 ? (u.cachedTokens / u.inputTokens * 100).toFixed(1) : '0.0';
  return '<!doctype html><html><head><meta charset="utf-8"><title>Daming Admin</title><style>body{font-family:system-ui,-apple-system,sans-serif;margin:24px;color:#111}table{border-collapse:collapse;margin:8px 0}td,th{border:1px solid #ddd;padding:4px 8px;font-size:13px;text-align:left}h1{font-size:20px}h2{font-size:15px;margin-top:22px}.k{color:#555}a{color:#2563eb}</style></head><body>'
    + '<h1>Daming Admin</h1>'
    + `<p class="k">Models: <b>${u.requests}</b> req · in <b>${u.inputTokens}</b> · out <b>${u.outputTokens}</b> · cache hit <b>${cacheRatio}%</b> · <a href="/dashboard">usage dashboard</a> · <a href="/v1/models">/v1/models</a></p>`
    + `<h2>Accounts (${scan.accounts.length})</h2><table><tr><th>provider</th><th>id</th><th>access</th><th>refresh</th><th>type</th><th>expires</th><th>accountId</th></tr>${accRows || '<tr><td colspan="7">none</td></tr>'}</table>`
    + `<h2>Plugins (${plugins.length})</h2><table><tr><th>on</th><th>id</th><th>kind</th><th>models</th></tr>${plRows || '<tr><td colspan="4">none</td></tr>'}</table>`
    + `<h2>Model catalog (${models.length})</h2><p class="k">${esc(models.join(', ')) || '(default)'}</p>`
    + '</body></html>';
}
interface RecentRow { at: string; endpoint: string; model: string; provider: string; input: number; output: number; cached: number; taskId?: string; agentId?: string }
/** Attribution headers are optional: absent means "unattributed", never guessed from the model. */
function attributionOf(req: { headers: Record<string, string | string[] | undefined> }): { taskId?: string; agentId?: string } {
  const read = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.trim();
  const taskId = read(req.headers['x-daming-task-id']);
  const agentId = read(req.headers['x-daming-agent-id']);
  return {
    ...(taskId && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,79}$/.test(taskId) ? { taskId } : {}),
    ...(agentId && /^[A-Za-z0-9][A-Za-z0-9._-]{1,39}$/.test(agentId) ? { agentId } : {})
  };
}
function dashboardHtml(u: UsageTotals, recent: readonly RecentRow[]): string {
  const cacheRatio = u.inputTokens > 0 ? (u.cachedTokens / u.inputTokens * 100).toFixed(1) : '0.0';
  const ct = u.composition.system + u.composition.tools + u.composition.conversation;
  const pc = (x: number) => ct > 0 ? (x / ct * 100).toFixed(1) : '0.0';
  const rows = Object.entries(u.byModel).map(([m, v]) => `<tr><td>${esc(m)}</td><td>${v.requests}</td><td>${v.inputTokens}</td><td>${v.outputTokens}</td><td>${v.cachedTokens}</td></tr>`).join('');
  const rr = recent.slice(-100).reverse().map((r) => `<tr><td>${esc(r.at)}</td><td>${esc(r.endpoint)}</td><td>${esc(r.model)}</td><td>${esc(r.provider)}</td><td>${r.input}</td><td>${r.output}</td><td>${r.cached}</td><td>${esc(r.taskId ?? '—')}</td></tr>`).join('');
  return '<!doctype html><html><head><meta charset="utf-8"><title>Daming Usage</title><style>body{font-family:system-ui,-apple-system,sans-serif;margin:24px;color:#111}table{border-collapse:collapse;margin:8px 0}td,th{border:1px solid #ddd;padding:4px 8px;font-size:13px;text-align:left}h1{font-size:18px}h2{font-size:14px;margin-top:20px}.k{color:#555}</style></head><body>'
    + '<h1>Daming Gateway · Usage</h1>'
    + `<p class="k">Requests <b>${u.requests}</b> · Input <b>${u.inputTokens}</b> · Output <b>${u.outputTokens}</b> · Cached <b>${u.cachedTokens}</b> · <b>Cache hit ${cacheRatio}%</b></p>`
    + `<p class="k">Prompt composition (est): system <b>${pc(u.composition.system)}%</b> · tools <b>${pc(u.composition.tools)}%</b> · conversation <b>${pc(u.composition.conversation)}%</b></p>`
    + '<h2>By model</h2><table><tr><th>model</th><th>requests</th><th>input</th><th>output</th><th>cached</th></tr>' + (rows || '<tr><td colspan="5">no requests yet</td></tr>') + '</table>'
    + '<h2>Recent</h2><table><tr><th>at</th><th>endpoint</th><th>model</th><th>provider</th><th>input</th><th>output</th><th>cached</th><th>task</th></tr>' + (rr || '<tr><td colspan="8">none</td></tr>') + '</table>'
    + '<p class="k">任务归属只认 <code>X-Daming-Task-Id</code> 请求头；没有该头的请求显示 —。</p>'
    + '</body></html>';
}
function num(v: unknown): number { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }
function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'text').map((b) => String((b as { text?: string }).text ?? '')).join('');
  return '';
}
function compChars(body: Record<string, unknown>): Composition {
  let system = 0, tools = 0, conv = 0;
  if (Array.isArray(body.messages)) for (const m of body.messages as Array<Record<string, unknown>>) { const t = textOfContent(m.content).length; if (m.role === 'system') system += t; else conv += t; }
  if (body.system !== undefined) system += textOfContent(body.system).length;
  if (Array.isArray(body.tools)) tools += JSON.stringify(body.tools).length;
  if (typeof body.input === 'string') conv += body.input.length;
  else if (Array.isArray(body.input)) for (const m of body.input as Array<Record<string, unknown>>) conv += textOfContent(m.content).length;
  return { system, tools, conversation: conv };
}
function scaleComp(ch: Composition, total: number): Composition {
  const sum = ch.system + ch.tools + ch.conversation;
  if (sum <= 0) return { system: 0, tools: 0, conversation: total };
  const r = (x: number) => Math.round((x / sum) * total);
  return { system: r(ch.system), tools: r(ch.tools), conversation: r(ch.conversation) };
}

export function createGatewayServer(options: GatewayOptions = {}): GatewayHandle {
  const registry = new ProviderRegistry();
  if (options.plugins && options.plugins.length) for (const p of options.plugins) registry.register(p);
  else if (options.providers && options.providers.length) for (const p of options.providers) registry.register(openAICompatiblePlugin({ id: p.id, baseUrl: p.baseUrl, models: p.models ?? [] }));
  else registry.register(openAICompatiblePlugin({ id: 'ollama', baseUrl: options.upstreamBaseUrl ?? 'http://localhost:11434', models: options.models ?? ['qwen3:8b'] }));
  const modelList = options.models ?? registry.models();
  const defaultModel = options.defaultModel ?? modelList[0] ?? 'qwen3:8b';
  const apiKey = options.apiKey;
  const maskingEnabled = process.env.DAMING_GATEWAY_MASK === '1';
  const maskRequest = (text: string): ReturnType<typeof maskText> => (maskingEnabled ? maskText(text) : { masked: text, findings: [], mapping: {} });
  const limit = options.maxBodyBytes ?? 4 * 1024 * 1024;
  const usage: UsageTotals = { requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, composition: { system: 0, tools: 0, conversation: 0 }, byModel: {} };
  const recent: RecentRow[] = [];

  function logUsage(endpoint: string, model: string, providerId: string, u: { input: number; output: number; cached: number }, comp?: Composition, attribution: { taskId?: string; agentId?: string } = {}): void {
    usage.requests++; usage.inputTokens += u.input; usage.outputTokens += u.output; usage.cachedTokens += u.cached;
    if (comp) { usage.composition.system += comp.system; usage.composition.tools += comp.tools; usage.composition.conversation += comp.conversation; }
    const m = usage.byModel[model] ?? (usage.byModel[model] = { requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 });
    m.requests++; m.inputTokens += u.input; m.outputTokens += u.output; m.cachedTokens += u.cached;
    recent.push({
      at: new Date().toISOString(), endpoint, model, provider: providerId, input: u.input, output: u.output, cached: u.cached,
      ...(attribution.taskId ? { taskId: attribution.taskId } : {}),
      ...(attribution.agentId ? { agentId: attribution.agentId } : {})
    });
    if (recent.length > 500) recent.shift();
    if (options.usageFile) { try { appendFileSync(options.usageFile, JSON.stringify({ at: new Date().toISOString(), endpoint, model, provider: providerId, ...u, ...attribution }) + '\n'); } catch { /* ignore */ } }
  }
  function toChat(model: string, body: Record<string, unknown>): Record<string, unknown> {
    let messages: Array<{ role: string; content: string }> = [];
    if (Array.isArray(body.messages)) messages = (body.messages as Array<Record<string, unknown>>).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user', content: textOfContent(m.content) }));
    else if (typeof body.input === 'string') messages = [{ role: 'user', content: body.input }];
    else if (Array.isArray(body.input)) messages = (body.input as Array<Record<string, unknown>>).map((m) => ({ role: String(m.role ?? 'user'), content: textOfContent(m.content) }));
    const max = body.max_output_tokens ?? body.max_tokens;
    return { model, messages, stream: false, ...(typeof max === 'number' ? { max_tokens: max } : {}) };
  }
  function parseChat(parsed: Record<string, unknown>): { text: string; finish: unknown; input: number; output: number; cached: number } {
    const choice = (Array.isArray(parsed.choices) ? parsed.choices[0] : undefined) as Record<string, unknown> | undefined;
    const msg = (choice?.message ?? {}) as Record<string, unknown>;
    const u = (parsed.usage ?? {}) as Record<string, unknown>;
    const details = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
    return { text: typeof msg.content === 'string' ? msg.content : '', finish: choice?.finish_reason, input: num(u.prompt_tokens), output: num(u.completion_tokens), cached: num(details.cached_tokens ?? u.cached_tokens) };
  }
  async function completeVia(plugin: ProviderPlugin, bodyText: string): Promise<{ plugin: ProviderPlugin; status: number; contentType: string; bodyText: string }> {
    const r = await plugin.complete(bodyText);
    return { plugin, ...r };
  }

  const server = createServer(async (req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    try {
      if (req.method === 'GET' && url === '/health') return json(res, 200, { ok: true, plugins: registry.all().map((p) => p.id) });
      if (url.startsWith('/v1/') && apiKey) {
        if (String(req.headers.authorization ?? '') !== 'Bearer ' + apiKey) return json(res, 401, { error: { type: 'unauthorized', message: 'missing or wrong bearer key' } });
      }
      if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) return json(res, 200, { object: 'list', data: modelList.map((id) => ({ id, object: 'model', owned_by: 'daming' })) });
      if (req.method === 'GET' && url === '/api/usage/summary') return json(res, 200, usage);
      if (req.method === 'GET' && url === '/api/usage/recent') return json(res, 200, { recent: recent.slice(-200) });
      if (req.method === 'GET' && (url === '/dashboard' || url === '/')) return html(res, 200, dashboardHtml(usage, recent));
      if (req.method === 'GET' && url === '/api/accounts') return json(res, 200, scanAccounts());
      if (req.method === 'GET' && url === '/api/plugins') return json(res, 200, options.pluginsDir ? { dir: options.pluginsDir, plugins: listPlugins(options.pluginsDir) } : { plugins: [] });
      if (req.method === 'GET' && url === '/admin') return html(res, 200, adminHtml(usage, recent, options));

      if (req.method === 'POST' && url === '/v1/chat/completions') {
        const bodyText = await readBody(req, limit);
        const body = JSON.parse(bodyText) as Record<string, unknown>;
        const model = String(body.model ?? defaultModel);
        const attribution = attributionOf(req);
        const candidates = registry.candidates(model);
        if (body.stream === true) {
          const p = candidates[0];
          if (p && p.streamBaseUrl) {
            const u = new URL(p.streamBaseUrl.replace(/\/+$/, '') + '/v1/chat/completions');
            const lib = u.protocol === 'https:' ? httpsRequest : httpRequest;
            const payload = Buffer.from(bodyText, 'utf8');
            const up = lib({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(payload.length) }, timeout: 120000 }, (upRes) => {
              res.writeHead(upRes.statusCode ?? 502, { 'content-type': String(upRes.headers['content-type'] ?? 'application/json'), 'cache-control': 'no-store' });
              upRes.pipe(res);
            });
            up.on('error', () => { if (!res.headersSent) json(res, 502, { error: 'upstream_error' }); });
            up.end(payload);
            return;
          }
          // plugin without a stream base: complete (non-stream) then synthesize an OpenAI SSE.
          const nb = { ...body, stream: false } as Record<string, unknown>; delete nb.stream_options;
          const nbMask = maskRequest(JSON.stringify(nb));
          const r = await completeVia(p, nbMask.masked);
          if (r.status !== 200) { res.writeHead(r.status, { 'content-type': 'application/json' }); return void res.end(r.bodyText); }
          let c: { text: string; input: number; output: number; cached: number; finish: string };
          try { c = parseChat(JSON.parse(r.bodyText) as Record<string, unknown>) as { text: string; input: number; output: number; cached: number; finish: string }; } catch { c = { text: '', input: 0, output: 0, cached: 0, finish: 'stop' }; }
          c.text = unmaskText(c.text, nbMask.mapping);
          registry.markSuccess(p.id);
          logUsage('chat.completions', model, p.id, { input: c.input, output: c.output, cached: c.cached }, scaleComp(compChars(body), c.input), attribution);
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
          const w = (o: unknown) => res.write('data: ' + JSON.stringify(o) + '\n\n');
          w({ choices: [{ index: 0, delta: { role: 'assistant', content: c.text }, finish_reason: null }] });
          w({ choices: [{ index: 0, delta: {}, finish_reason: c.finish === 'length' ? 'length' : 'stop' }], usage: { prompt_tokens: c.input, completion_tokens: c.output, total_tokens: c.input + c.output } });
          res.write('data: [DONE]\n\n'); return void res.end();
        }
        let last: { plugin: ProviderPlugin; status: number; contentType: string; bodyText: string } | undefined;
        const maskedChat = maskRequest(bodyText);
        for (const p of candidates) { try { const r = await completeVia(p, maskedChat.masked); if (r.status === 200) { registry.markSuccess(p.id); last = r; break; } registry.markFailure(p.id); last = r; } catch { registry.markFailure(p.id); } }
        if (!last) return json(res, 502, { error: 'all_providers_failed' });
        try { const c = parseChat(JSON.parse(last.bodyText) as Record<string, unknown>); if (last.status === 200) logUsage('chat.completions', model, last.plugin.id, { input: c.input, output: c.output, cached: c.cached }, scaleComp(compChars(body), c.input), attribution); } catch { /* ignore */ }
        const outText = last.status === 200 ? unmaskText(last.bodyText, maskedChat.mapping) : last.bodyText;
        res.writeHead(last.status, { 'content-type': last.contentType, 'content-length': String(Buffer.byteLength(outText)) });
        return void res.end(outText);
      }

      if (req.method === 'POST' && (url === '/v1/responses' || url === '/v1/messages')) {
        const bodyText = await readBody(req, limit);
        const body = JSON.parse(bodyText) as Record<string, unknown>;
        const model = String(body.model ?? defaultModel);
        const isAnth = url === '/v1/messages';
        const wantStream = body.stream === true;
        if (isAnth && body.system) { const sys = textOfContent(body.system); if (sys) body.messages = [{ role: 'system', content: sys }, ...(Array.isArray(body.messages) ? body.messages : [])]; }
        const chat = toChat(model, body);
        const chatMask = maskRequest(JSON.stringify(chat));
        let r: { plugin: ProviderPlugin; status: number; bodyText: string } | undefined;
        for (const p of registry.candidates(model)) { try { const x = await p.complete(chatMask.masked); if (x.status === 200) { registry.markSuccess(p.id); r = { plugin: p, status: x.status, bodyText: x.bodyText }; break; } registry.markFailure(p.id); } catch { registry.markFailure(p.id); } }
        if (!r) return json(res, 502, { error: 'all_providers_failed' });
        const c = parseChat(JSON.parse(r.bodyText) as Record<string, unknown>);
        c.text = unmaskText(c.text, chatMask.mapping);
        logUsage(isAnth ? 'messages' : 'responses', model, r.plugin.id, { input: c.input, output: c.output, cached: c.cached }, scaleComp(compChars(body), c.input), attributionOf(req));
        const id = (isAnth ? 'msg_' : 'resp_') + Math.random().toString(36).slice(2, 14);
        if (isAnth) {
          const message = { id, type: 'message', role: 'assistant', model, content: [{ type: 'text', text: c.text }], stop_reason: c.finish === 'length' ? 'max_tokens' : 'end_turn', stop_sequence: null, usage: { input_tokens: c.input, output_tokens: c.output } };
          if (!wantStream) return json(res, 200, message);
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
          const send = (e: string, d: unknown) => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
          send('message_start', { type: 'message_start', message: { ...message, content: [], usage: { input_tokens: c.input, output_tokens: 0 } } });
          send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
          if (c.text) send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: c.text } });
          send('content_block_stop', { type: 'content_block_stop', index: 0 });
          send('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: c.output } });
          send('message_stop', { type: 'message_stop' });
          return void res.end();
        }
        const response = { id, object: 'response', created_at: Math.floor(Date.now() / 1000), model, status: 'completed', output_text: c.text,
          output: [{ type: 'message', id: 'msg_' + id.slice(5), role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: c.text, annotations: [] }] }],
          usage: { input_tokens: c.input, output_tokens: c.output, total_tokens: c.input + c.output } };
        if (!wantStream) return json(res, 200, response);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        const send = (e: string, d: unknown) => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
        const itemId = 'msg_' + id.slice(5);
        send('response.created', { type: 'response.created', response: { ...response, status: 'in_progress', output: [], output_text: '' } });
        send('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] } });
        send('response.content_part.added', { type: 'response.content_part.added', item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        send('response.output_text.delta', { type: 'response.output_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta: c.text });
        send('response.output_text.done', { type: 'response.output_text.done', item_id: itemId, output_index: 0, content_index: 0, text: c.text });
        send('response.content_part.done', { type: 'response.content_part.done', item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: c.text, annotations: [] } });
        send('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: c.text, annotations: [] }] } });
        send('response.completed', { type: 'response.completed', response });
        return void res.end();
      }
      json(res, 404, { error: 'not_found' });
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: e instanceof Error ? e.message.slice(0, 120) : 'gateway_error' });
    }
  });
  return { url: 'http://127.0.0.1:0', server, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

export async function listen(handle: GatewayHandle, port = 0): Promise<string> {
  await new Promise<void>((resolve) => handle.server.listen(port, '127.0.0.1', resolve));
  const addr = handle.server.address() as { port: number };
  return 'http://127.0.0.1:' + addr.port;
}
