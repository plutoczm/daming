/** Probe gateway /v1/messages latency per model (isolates Claude-hang: gateway vs CLI). */
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGatewayServer, listen, loadPlugins, parseGatewayConfig, pluginsFromConfig, providerPluginsFromLoaded } from '../services/daming-gateway/src/index.ts';

const pa = JSON.parse(readFileSync(join(process.env.USERPROFILE, '.config', 'magpie', 'plugin-auth.json'), 'utf8'));
const wb = pa['workbuddy']; process.env.WORKBUDDY_ACCESS = wb.access; process.env.WORKBUDDY_UID = wb.uid; process.env.WORKBUDDY_DOMAIN = wb.domain;
const dsKey = ((readFileSync(resolve('.env'), 'utf8').split(/\r?\n/).find((l) => l.startsWith('DEEPSEEK_API_KEY=')) || '').split('=').slice(1).join('=')).trim();
const cfg = parseGatewayConfig(JSON.stringify({ providers: [
  { id: 'ollama', baseUrl: process.env.OLLAMA_BASE ?? 'http://localhost:11434', models: ['qwen3:8b'] },
  ...(dsKey ? [{ id: 'deepseek', baseUrl: 'https://api.deepseek.com', models: ['deepseek-chat'], apiKeyEnv: 'DEEPSEEK_API_KEY' }] : []),
] }));
const plugins = [...pluginsFromConfig(cfg, { ...process.env, DEEPSEEK_API_KEY: dsKey }), ...providerPluginsFromLoaded((await loadPlugins(fileURLToPath(new URL('../examples/plugins', import.meta.url)))).loaded)];
const h = createGatewayServer({ plugins, models: ['qwen3:8b', 'deepseek-chat', 'deepseek-v4.1-flash'], defaultModel: 'qwen3:8b' });
const base = await listen(h, 0);
for (const model of ['qwen3:8b', 'deepseek-chat', 'deepseek-v4.1-flash']) {
  const t0 = Date.now();
  try {
    const r = await fetch(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hi' }] }), signal: AbortSignal.timeout(60000) });
    const txt = await r.text();
    console.log(model, '->', r.status, (Date.now() - t0) + 'ms', '|', txt.slice(0, 120).replace(/\n/g, ' '));
  } catch (e) { console.log(model, '-> ERROR', (Date.now() - t0) + 'ms', String(e).slice(0, 120)); }
}
await h.close();
