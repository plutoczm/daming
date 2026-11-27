/** S13 addable-providers smoke: compatible providers via CONFIG (ollama/zcode) + non-standard via PLUGINS (kiro/workbuddy/codex) in ONE gateway. */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createGatewayServer, gatewayConfigModels, listen, loadPlugins, parseGatewayConfig, pluginsFromConfig, providerPluginsFromLoaded } from '../services/daming-gateway/src/index.ts';

const pa = JSON.parse(readFileSync(process.env.USERPROFILE + '/.config/magpie/plugin-auth.json', 'utf8'));
const wb = pa['workbuddy']; process.env.WORKBUDDY_ACCESS = wb.access; process.env.WORKBUDDY_UID = wb.uid; process.env.WORKBUDDY_DOMAIN = wb.domain;
process.env.ZCODE_KEY = pa['zcode']?.access || '';
const j = JSON.parse(readFileSync(process.env.USERPROFILE + '/.config/magpie/logins.json', 'utf8'));
const cx = (j || []).find((r) => r.agent === 'codex'); process.env.CODEX_ACCESS = cx?.auth?.tokens?.access_token || ''; process.env.CODEX_ACCOUNT_ID = cx?.auth?.tokens?.account_id || '';

const cfg = parseGatewayConfig(JSON.stringify({ providers: [
  { id: 'ollama', api: 'openai-completions', baseUrl: process.env.OLLAMA_BASE ?? 'http://localhost:11434', models: ['qwen3:8b'] },
  { id: 'zcode', api: 'anthropic-messages', baseUrl: 'https://api.z.ai/api/anthropic', models: ['glm-5.3'], apiKeyEnv: 'ZCODE_KEY' },
] }));
const basePlugins = pluginsFromConfig(cfg, process.env);
const report = await loadPlugins(process.cwd() + '/examples/plugins');
const filePlugins = providerPluginsFromLoaded(report.loaded).filter((p) => !basePlugins.some((b) => b.id === p.id));
const plugins = [...basePlugins, ...filePlugins];
const models = [...new Set([...gatewayConfigModels(cfg), ...filePlugins.flatMap((p) => p.models)])];
const proof = { stage: 'S13', module: 'addable providers: config (compatible) + plugins (non-standard)', observedAt: new Date().toISOString(), ok: false, configProviders: basePlugins.map((p) => p.id), pluginProviders: filePlugins.map((p) => p.id), pluginErrors: report.errors, models };
const h = createGatewayServer({ plugins, models, defaultModel: 'qwen3:8b' });
try {
  const base = await listen(h, 0);
  const listed = (await (await fetch(base + '/v1/models')).json()).data.map((m) => m.id);
  proof.listedModels = listed;
  const q = await (await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen3:8b', messages: [{ role: 'user', content: '请只回复 OK' }], max_tokens: 512 }) })).json();
  proof.ollama = q?.choices?.[0]?.message?.content;
  const need = ['qwen3:8b', 'glm-5.3', 'claude-sonnet-4.5', 'deepseek-v4.1-flash', 'gpt-6.2-sol'];
  proof.missing = need.filter((m) => !listed.includes(m));
  proof.ok = String(proof.ollama ?? '').trim().toUpperCase().includes('OK') && proof.missing.length === 0;
  if (!proof.ok) process.exitCode = 1;
} catch (e) { proof.error = e instanceof Error ? e.message.slice(0, 200) : String(e); process.exitCode = 1; }
finally {
  try { await h.close(); } catch {}
  mkdirSync(resolve('docs/verification'), { recursive: true }); mkdirSync(resolve('.cache/verification'), { recursive: true });
  const out = JSON.stringify(proof, null, 2) + '\n';
  writeFileSync(resolve('docs/verification/s13-addable-providers-2026-11-20.json'), out);
  writeFileSync(resolve('.cache/verification/s13-addable-providers.json'), out);
  console.log(out);
}
