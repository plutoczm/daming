/** S13 M4 dashboard smoke: real Ollama call -> Daming gateway /dashboard + /api/usage/recent. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createGatewayServer, listen } from '../services/daming-gateway/src/index.ts';

const proof = { stage: 'S13', module: 'M4 usage dashboard (real Ollama call)', observedAt: new Date().toISOString(), ok: false };
const h = createGatewayServer({ upstreamBaseUrl: process.env.OLLAMA_BASE ?? 'http://localhost:11434', models: ['qwen3:8b'], defaultModel: 'qwen3:8b' });
try {
  const base = await listen(h, 0);
  const chat = await (await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen3:8b', messages: [{ role: 'system', content: 'You are Daming gateway.' }, { role: 'user', content: 'Reply with exactly: OK. Do not explain.' }], max_tokens: 512 }) })).json();
  proof.chat = { content: chat?.choices?.[0]?.message?.content, usage: chat?.usage };
  const summary = await (await fetch(base + '/api/usage/summary')).json();
  proof.summary = summary;
  const recent = await (await fetch(base + '/api/usage/recent')).json();
  proof.recentCount = recent?.recent?.length ?? 0;
  const dash = await (await fetch(base + '/dashboard')).text();
  proof.dashboardHasModel = dash.includes('qwen3:8b');
  proof.dashboardHasCacheHit = dash.includes('Cache hit');
  proof.dashboardSnippet = dash.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300);
  proof.ok = String(proof.chat.content ?? '').trim().toUpperCase().includes('OK') && proof.dashboardHasModel && proof.dashboardHasCacheHit && proof.recentCount >= 1;
  if (!proof.ok) process.exitCode = 1;
} catch (e) { proof.error = e instanceof Error ? e.message.slice(0, 200) : String(e); process.exitCode = 1; }
finally {
  try { await h.close(); } catch {}
  mkdirSync(resolve('docs/verification'), { recursive: true }); mkdirSync(resolve('.cache/verification'), { recursive: true });
  const j = JSON.stringify(proof, null, 2) + '\n';
  writeFileSync(resolve('docs/verification/s13-m4-dashboard-2026-11-20.json'), j);
  writeFileSync(resolve('.cache/verification/s13-m4-dashboard.json'), j);
  console.log(j);
}

