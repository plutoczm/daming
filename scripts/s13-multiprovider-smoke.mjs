/** S13 M1/M3 smoke: Daming gateway with TWO real providers (Ollama + DeepSeek official API), routed by model. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createGatewayServer, listen, openAICompatiblePlugin } from '../services/daming-gateway/src/index.ts';

function env(k) { try { const l = readFileSync(resolve('.env'), 'utf8').split(/\r?\n/).find((x) => x.startsWith(k + '=')); return l ? l.slice(k.length + 1).trim() : ''; } catch { return ''; } }
const dsKey = env('DEEPSEEK_API_KEY');
const proof = { stage: 'S13', module: 'M1 multi-provider supply + M3 routing (Ollama + DeepSeek official)', observedAt: new Date().toISOString(), realModelInference: false, results: {} };
const h = createGatewayServer({
  models: ['qwen3:8b', 'deepseek-chat'],
  plugins: [
    openAICompatiblePlugin({ id: 'ollama', baseUrl: process.env.OLLAMA_BASE ?? 'http://localhost:11434', models: ['qwen3:8b'] }),
    ...(dsKey ? [openAICompatiblePlugin({ id: 'deepseek', baseUrl: 'https://api.deepseek.com', models: ['deepseek-chat'], headers: { authorization: 'Bearer ' + dsKey } })] : []),
  ],
});
try {
  const base = await listen(h, 0);
  proof.results.models = await (await fetch(base + '/v1/models')).json();
  const P = 'Reply with exactly: OK. Do not explain.';
  const qwen = await (await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen3:8b', messages: [{ role: 'user', content: P }], max_tokens: 512 }) })).json();
  proof.results.ollama = { content: qwen?.choices?.[0]?.message?.content, usage: qwen?.usage };
  proof.results.deepseekConfigured = Boolean(dsKey);
  if (dsKey) {
    const ds = await (await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: P }], max_tokens: 16 }) })).json();
    proof.results.deepseek = { content: ds?.choices?.[0]?.message?.content, usage: ds?.usage };
  }
  proof.results.usageSummary = await (await fetch(base + '/api/usage/summary')).json();
  const ok = (v) => String(v ?? '').trim().toUpperCase().includes('OK');
  proof.realModelInference = ok(proof.results.ollama.content) && (!dsKey || ok(proof.results.deepseek.content));
  if (!proof.realModelInference) process.exitCode = 1;
} catch (e) { proof.error = e instanceof Error ? e.message.slice(0, 200) : String(e); process.exitCode = 1; }
finally {
  try { await h.close(); } catch {}
  mkdirSync(resolve('docs/verification'), { recursive: true }); mkdirSync(resolve('.cache/verification'), { recursive: true });
  const j = JSON.stringify(proof, null, 2) + '\n';
  writeFileSync(resolve('docs/verification/s13-m1-multiprovider-2026-11-20.json'), j);
  writeFileSync(resolve('.cache/verification/s13-m1-multiprovider.json'), j);
  console.log(j);
}
