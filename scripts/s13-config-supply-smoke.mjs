/** S13 M1 config-driven supply smoke: build providers from config (Ollama + DeepSeek via apiKeyEnv), real chats. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createGatewayServer, gatewayConfigModels, listen, parseGatewayConfig, pluginsFromConfig } from '../services/daming-gateway/src/index.ts';

function env(k) { try { const l = readFileSync(resolve('.env'), 'utf8').split(/\r?\n/).find((x) => x.startsWith(k + '=')); return l ? l.slice(k.length + 1).trim() : ''; } catch { return ''; } }
const key = env('DEEPSEEK_API_KEY');
const proof = { stage: 'S13', module: 'M1 config-driven supply (providers from config, keys from env)', observedAt: new Date().toISOString(), ok: false };
const cfg = parseGatewayConfig(JSON.stringify({ providers: [
  { id: 'ollama', baseUrl: process.env.OLLAMA_BASE ?? 'http://localhost:11434', models: ['qwen3:8b'] },
  ...(key ? [{ id: 'deepseek', baseUrl: 'https://api.deepseek.com', models: ['deepseek-chat'], apiKeyEnv: 'DEEPSEEK_API_KEY' }] : []),
] }));
const plugins = pluginsFromConfig(cfg, { ...process.env, DEEPSEEK_API_KEY: key });
const h = createGatewayServer({ plugins, models: gatewayConfigModels(cfg), defaultModel: 'qwen3:8b' });
try {
  const base = await listen(h, 0);
  const models = await (await fetch(base + '/v1/models')).json();
  proof.providerIds = plugins.map((p) => p.id);
  proof.models = models.data?.map((m) => m.id);
  const P = 'Reply with exactly: OK. Do not explain.';
  const q = await (await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen3:8b', messages: [{ role: 'user', content: P }], max_tokens: 512 }) })).json();
  proof.ollama = q?.choices?.[0]?.message?.content;
  if (key) { const d = await (await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: P }], max_tokens: 16 }) })).json(); proof.deepseek = d?.choices?.[0]?.message?.content; }
  const ok = (v) => String(v ?? '').trim().toUpperCase().includes('OK');
  proof.ok = ok(proof.ollama) && (!key || ok(proof.deepseek));
  if (!proof.ok) process.exitCode = 1;
} catch (e) { proof.error = e instanceof Error ? e.message.slice(0, 200) : String(e); process.exitCode = 1; }
finally {
  try { await h.close(); } catch {}
  mkdirSync(resolve('docs/verification'), { recursive: true }); mkdirSync(resolve('.cache/verification'), { recursive: true });
  const j = JSON.stringify(proof, null, 2) + '\n';
  writeFileSync(resolve('docs/verification/s13-m1-config-supply-2026-11-20.json'), j);
  writeFileSync(resolve('.cache/verification/s13-m1-config-supply.json'), j);
  console.log(j);
}
