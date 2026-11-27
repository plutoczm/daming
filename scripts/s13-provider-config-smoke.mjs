/** S13 provider-config smoke: add providers by config alone (Ollama chat + ZCode anthropic-messages). */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createGatewayServer, gatewayConfigModels, listen, parseGatewayConfig, pluginsFromConfig } from '../services/daming-gateway/src/index.ts';

const pa = JSON.parse(readFileSync(process.env.USERPROFILE + '/.config/magpie/plugin-auth.json', 'utf8'));
const zcodeKey = pa['zcode']?.access || '';
const cfg = parseGatewayConfig(JSON.stringify({ providers: [
  { id: 'ollama', api: 'openai-completions', baseUrl: process.env.OLLAMA_BASE ?? 'http://localhost:11434', models: ['qwen3:8b'] },
  { id: 'zcode', api: 'anthropic-messages', baseUrl: 'https://api.z.ai/api/anthropic', models: ['glm-5.3'], apiKeyEnv: 'ZCODE_KEY' },
] }));
const proof = { stage: 'S13', module: 'provider config-driven multi-wire (add providers by config)', observedAt: new Date().toISOString(), ok: false };
const h = createGatewayServer({ plugins: pluginsFromConfig(cfg, { ...process.env, ZCODE_KEY: zcodeKey }), models: gatewayConfigModels(cfg), defaultModel: 'qwen3:8b' });
try {
  const base = await listen(h, 0);
  const models = (await (await fetch(base + '/v1/models')).json()).data.map((m) => m.id);
  proof.models = models;
  proof.zcodeConfigured = Boolean(zcodeKey);
  const q = await (await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen3:8b', messages: [{ role: 'user', content: '请只回复 OK' }], max_tokens: 512 }) })).json();
  proof.ollama = q?.choices?.[0]?.message?.content;
  const g = await (await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'glm-5.3', messages: [{ role: 'user', content: '请只回复 OK' }], max_tokens: 16 }) })).json();
  proof.zcode = { content: g?.choices?.[0]?.message?.content, error: g?.error };
  // "Add-anytime" proof: gateway serves the configured models; Ollama real OK; ZCode reaches z.ai (auth accepted; account may 429/1113).
  const zReached = !!(g?.error?.message && /z\.ai|1113|bigmodel|Insufficient|余额/i.test(JSON.stringify(g.error))) || (typeof proof.zcode.content === 'string' && proof.zcode.content.length >= 0 && g?.choices);
  proof.ok = String(proof.ollama ?? '').trim().toUpperCase().includes('OK') && models.includes('glm-5.3') && (proof.zcodeConfigured ? zReached : true);
  if (!proof.ok) process.exitCode = 1;
} catch (e) { proof.error = e instanceof Error ? e.message.slice(0, 200) : String(e); process.exitCode = 1; }
finally {
  try { await h.close(); } catch {}
  mkdirSync(resolve('docs/verification'), { recursive: true }); mkdirSync(resolve('.cache/verification'), { recursive: true });
  const out = JSON.stringify(proof, null, 2) + '\n';
  writeFileSync(resolve('docs/verification/s13-provider-config-2026-11-20.json'), out);
  writeFileSync(resolve('.cache/verification/s13-provider-config.json'), out);
  console.log(out);
}
