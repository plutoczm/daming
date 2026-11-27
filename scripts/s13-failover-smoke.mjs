/** S13 M3 failover smoke: bad provider + real Ollama for same model -> gateway failovers to Ollama. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createGatewayServer, listen, openAICompatiblePlugin } from '../services/daming-gateway/src/index.ts';

const proof = { stage: 'S13', module: 'M3 routing: health circuit-breaker + failover (bad -> Ollama)', observedAt: new Date().toISOString(), ok: false };
const h = createGatewayServer({ models: ['qwen3:8b'], plugins: [
  openAICompatiblePlugin({ id: 'bad', baseUrl: 'http://127.0.0.1:1', models: ['qwen3:8b'] }),
  openAICompatiblePlugin({ id: 'ollama', baseUrl: process.env.OLLAMA_BASE ?? 'http://localhost:11434', models: ['qwen3:8b'] }),
] });
try {
  const base = await listen(h, 0);
  const chat = await (await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen3:8b', messages: [{ role: 'user', content: 'Reply with exactly: OK. Do not explain.' }], max_tokens: 512 }) })).json();
  proof.chat = { content: chat?.choices?.[0]?.message?.content, usage: chat?.usage };
  const recent = await (await fetch(base + '/api/usage/recent')).json();
  proof.usedProvider = recent?.recent?.[recent.recent.length - 1]?.provider;
  proof.ok = String(proof.chat.content ?? '').trim().toUpperCase().includes('OK') && proof.usedProvider === 'ollama';
  if (!proof.ok) process.exitCode = 1;
} catch (e) { proof.error = e instanceof Error ? e.message.slice(0, 200) : String(e); process.exitCode = 1; }
finally {
  try { await h.close(); } catch {}
  mkdirSync(resolve('docs/verification'), { recursive: true }); mkdirSync(resolve('.cache/verification'), { recursive: true });
  const j = JSON.stringify(proof, null, 2) + '\n';
  writeFileSync(resolve('docs/verification/s13-m3-failover-2026-11-20.json'), j);
  writeFileSync(resolve('.cache/verification/s13-m3-failover.json'), j);
  console.log(j);
}
