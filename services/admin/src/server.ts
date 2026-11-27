import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { installPlugin, listPlugins, removePlugin, setPluginEnabled } from '../../daming-gateway/src/index.ts';
import { scanAccounts, readQuotas } from '../../accounts/src/index.ts';

/** Persistent Daming admin console: visual add/remove of PROVIDERS (config) and PLUGINS, read-only accounts/quotas. */
export type ProviderApi = 'openai-completions' | 'openai-responses' | 'anthropic-messages';
export interface ProviderRow { id: string; api?: ProviderApi; baseUrl: string; models: string[]; apiKeyEnv?: string; apiKeyHeader?: 'authorization' | 'x-api-key' }
export interface AdminOptions { providersFile?: string; pluginsDir?: string; magpieDir?: string }
export interface AdminHandle { listen(port?: number): Promise<string>; close(): Promise<void>; server: Server }

const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const APIS: ProviderApi[] = ['openai-completions', 'openai-responses', 'anthropic-messages'];

function readBody(req: IncomingMessage, limit = 1 << 20): Promise<string> {
  return new Promise((res, rej) => { let n = 0; const c: Buffer[] = []; req.on('data', (d: Buffer) => { n += d.length; if (n > limit) { rej(new Error('body_too_large')); req.destroy(); } else c.push(d); }); req.on('end', () => res(Buffer.concat(c).toString('utf8'))); req.on('error', rej); });
}
function json(res: ServerResponse, status: number, v: unknown): void { const b = Buffer.from(JSON.stringify(v), 'utf8'); res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(b.length) }); res.end(b); }
function html(res: ServerResponse, body: string): void { const b = Buffer.from(body, 'utf8'); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(b.length) }); res.end(b); }
function esc(s: unknown): string { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string)); }

function validateProvider(raw: unknown): ProviderRow {
  const p = (raw ?? {}) as Record<string, unknown>;
  if (typeof p.id !== 'string' || !ID.test(p.id)) throw new Error('provider_id_invalid');
  const api = (p.api ?? 'openai-completions') as ProviderApi;
  if (!APIS.includes(api)) throw new Error('provider_api_invalid');
  if (typeof p.baseUrl !== 'string' || !/^https?:\/\//.test(p.baseUrl)) throw new Error('provider_baseurl_invalid');
  const models = Array.isArray(p.models) ? p.models.filter((m): m is string => typeof m === 'string' && !!m) : (typeof p.models === 'string' ? String(p.models).split(',').map((s) => s.trim()).filter(Boolean) : []);
  if (!models.length) throw new Error('provider_models_invalid');
  const out: ProviderRow = { id: p.id, api, baseUrl: p.baseUrl, models };
  if (typeof p.apiKeyEnv === 'string' && p.apiKeyEnv) out.apiKeyEnv = p.apiKeyEnv;
  if (p.apiKeyHeader === 'x-api-key') out.apiKeyHeader = 'x-api-key';
  return out;
}

export function createAdminServer(opts: AdminOptions = {}): AdminHandle {
  const providersFile = resolve(opts.providersFile || 'config/providers.json');
  const pluginsDir = resolve(opts.pluginsDir || process.env.DAMING_PLUGINS_DIR || 'examples/plugins');
  const magpieDir = opts.magpieDir;

  function loadProviders(): { providers: ProviderRow[]; defaultModel?: string } {
    if (!existsSync(providersFile)) return { providers: [] };
    try { return JSON.parse(readFileSync(providersFile, 'utf8').replace(/^\uFEFF/, '')) as { providers: ProviderRow[]; defaultModel?: string }; } catch { return { providers: [] }; }
  }
  function saveProviders(cfg: { providers: ProviderRow[]; defaultModel?: string }): void { mkdirSync(dirname(providersFile), { recursive: true }); writeFileSync(providersFile, JSON.stringify(cfg, null, 2) + '\n'); }
  function models(): string[] { const s = new Set<string>(); for (const p of loadProviders().providers) for (const m of p.models) s.add(m); for (const pl of listPlugins(pluginsDir)) for (const m of pl.manifest?.models ?? []) s.add(m); return [...s]; }

  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const path = u.pathname;
    try {
      if (req.method === 'GET' && (path === '/' || path === '/admin')) return html(res, adminPage());
      if (req.method === 'GET' && path === '/api/providers') return json(res, 200, loadProviders());
      if (req.method === 'POST' && path === '/api/providers') {
        const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        const row = validateProvider(body);
        const cfg = loadProviders(); const i = cfg.providers.findIndex((p) => p.id === row.id);
        if (i >= 0) cfg.providers[i] = row; else cfg.providers.push(row);
        if (typeof body.defaultModel === 'string') cfg.defaultModel = body.defaultModel;
        saveProviders(cfg); return json(res, 200, { ok: true, provider: row });
      }
      if (req.method === 'DELETE' && path === '/api/providers') {
        const id = u.searchParams.get('id'); if (!id) return json(res, 400, { error: 'id_required' });
        const cfg = loadProviders(); cfg.providers = cfg.providers.filter((p) => p.id !== id); saveProviders(cfg); return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && path === '/api/plugins') return json(res, 200, { dir: pluginsDir, plugins: listPlugins(pluginsDir) });
      if (req.method === 'POST' && path === '/api/plugins/install') {
        const b = JSON.parse(await readBody(req)) as { src?: string }; if (!b.src) return json(res, 400, { error: 'src_required' });
        try { const dest = installPlugin(resolve(b.src), pluginsDir); return json(res, 200, { ok: true, dest }); } catch (e) { return json(res, 400, { error: e instanceof Error ? e.message : String(e) }); }
      }
      const pm = /^\/api\/plugins\/(enable|disable|remove)$/.exec(path);
      if (req.method === 'POST' && pm) {
        const id = u.searchParams.get('id'); const item = listPlugins(pluginsDir).find((p) => (p.manifest?.id || p.name) === id);
        if (!item) return json(res, 404, { error: 'plugin_not_found' });
        if (pm[1] === 'remove') { removePlugin(pluginsDir, item.manifest?.id || item.name); return json(res, 200, { ok: true }); }
        setPluginEnabled(item.dir, pm[1] === 'enable'); return json(res, 200, { ok: true, enabled: pm[1] === 'enable' });
      }
      if (req.method === 'GET' && path === '/api/accounts') return json(res, 200, scanAccounts(magpieDir ? { magpieDir } : {}));
      if (req.method === 'GET' && path === '/api/quotas') return json(res, 200, { quotas: await readQuotas(magpieDir ? { magpieDir } : {}) });
      if (req.method === 'GET' && path === '/api/models') return json(res, 200, { models: models() });
      return json(res, 404, { error: 'not_found' });
    } catch (e) { json(res, 400, { error: e instanceof Error ? e.message.slice(0, 160) : String(e) }); }
  });

  return {
    server,
    listen(port = 0): Promise<string> { return new Promise((r, rej) => { server.once('error', rej); server.listen(port, '127.0.0.1', () => { const a = server.address() as { port: number }; r('http://127.0.0.1:' + a.port); }); }); },
    close(): Promise<void> { return new Promise((r) => server.close(() => r())); },
  };
}

function adminPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Daming Admin</title><style>
body{font-family:system-ui,-apple-system,sans-serif;margin:20px;color:#111;max-width:1100px}
h1{font-size:20px}h2{font-size:15px;margin-top:24px;border-bottom:1px solid #eee;padding-bottom:4px}
table{border-collapse:collapse;margin:8px 0;width:100%}td,th{border:1px solid #ddd;padding:4px 8px;font-size:13px;text-align:left}
input,select,button{font-size:13px;padding:3px 6px;margin:2px}button{cursor:pointer}
.k{color:#555}code{background:#f4f4f4;padding:1px 4px;border-radius:3px}.row>*{margin-right:6px}
</style></head><body>
<h1>Daming Admin · 供应/插件/账号（可视化增删）</h1>
<p class="k">常驻管理面板。供应商=兼容端点配置（随时加）；插件=丢目录即用。<a href="/api/models">/api/models</a></p>

<h2>Providers（配置驱动，随时增删）</h2>
<table id="prov"><thead><tr><th>id</th><th>api</th><th>baseUrl</th><th>models</th><th>keyEnv</th><th></th></tr></thead><tbody></tbody></table>
<div class="row"><input id="p_id" placeholder="id" size="10"><select id="p_api"><option>openai-completions</option><option>openai-responses</option><option>anthropic-messages</option></select><input id="p_base" placeholder="https://api.example.com" size="30"><input id="p_models" placeholder="model-a,model-b" size="22"><input id="p_key" placeholder="API_KEY_ENV" size="14"><button onclick="addProv()">+ 添加/更新供应商</button></div>

<h2>Plugins（丢目录即用）</h2>
<table id="plug"><thead><tr><th>on</th><th>id</th><th>kind</th><th>models</th><th></th></tr></thead><tbody></tbody></table>
<div class="row"><input id="pl_src" placeholder="插件源目录路径 e.g. examples/plugins/echo-provider" size="50"><button onclick="installPlug()">安装插件</button></div>

<h2>Accounts（只读）</h2>
<table id="acc"><thead><tr><th>provider</th><th>id</th><th>access</th><th>refresh</th><th>accountId</th></tr></thead><tbody></tbody></table>

<script>
async function j(u,o){const r=await fetch(u,o);return r.json();}
function td(x){const e=document.createElement('td');e.textContent=x==null?'':String(x);return e;}
async function loadProv(){const d=await j('/api/providers');const tb=document.querySelector('#prov tbody');tb.innerHTML='';for(const p of (d.providers||[])){const tr=document.createElement('tr');tr.append(td(p.id),td(p.api||'openai-completions'),td(p.baseUrl),td((p.models||[]).join(',')),td(p.apiKeyEnv||''));const c=document.createElement('td');const b=document.createElement('button');b.textContent='删除';b.onclick=async()=>{await j('/api/providers?id='+encodeURIComponent(p.id),{method:'DELETE'});loadProv();loadModels();};c.append(b);tr.append(c);tb.append(tr);}}
async function addProv(){const body={id:p_id.value.trim(),api:p_api.value,baseUrl:p_base.value.trim(),models:p_models.value.split(',').map(s=>s.trim()).filter(Boolean),apiKeyEnv:p_key.value.trim()||undefined};const r=await j('/api/providers',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(r.error)return alert('错误: '+r.error);loadProv();loadModels();}
async function loadPlug(){const d=await j('/api/plugins');const tb=document.querySelector('#plug tbody');tb.innerHTML='';for(const p of (d.plugins||[])){const tr=document.createElement('tr');tr.append(td(p.enabled?'✓':'✗'),td(p.manifest?.id||p.name),td(p.manifest?.kind||''),td((p.manifest?.models||[]).join(',')));const c=document.createElement('td');const id=encodeURIComponent(p.manifest?.id||p.name);const be=document.createElement('button');be.textContent=p.enabled?'禁用':'启用';be.onclick=async()=>{await j('/api/plugins/'+(p.enabled?'disable':'enable')+'?id='+id,{method:'POST'});loadPlug();loadModels();};const br=document.createElement('button');br.textContent='移除';br.onclick=async()=>{await j('/api/plugins/remove?id='+id,{method:'POST'});loadPlug();loadModels();};c.append(be,br);tr.append(c);tb.append(tr);}}
async function installPlug(){const r=await j('/api/plugins/install',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({src:pl_src.value.trim()})});if(r.error)return alert('错误: '+r.error);loadPlug();loadModels();}
async function loadAcc(){const d=await j('/api/accounts');const tb=document.querySelector('#acc tbody');tb.innerHTML='';for(const a of (d.accounts||[])){const tr=document.createElement('tr');tr.append(td(a.provider),td(a.id),td(a.hasAccess?'Y':'N'),td(a.hasRefresh?'Y':'N'),td(a.accountId||''));tb.append(tr);}}
async function loadModels(){const d=await j('/api/models');console.log('models',d.models);}
loadProv();loadPlug();loadAcc();
</script></body></html>`;
}
