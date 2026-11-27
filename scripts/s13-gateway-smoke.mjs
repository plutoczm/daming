/** S13 M1/M3/M4 smoke: Daming gateway -> local Ollama, REAL model turns; usage summary. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createGatewayServer, listen } from '../services/daming-gateway/src/index.ts';

const proof = { stage: 'S13', module: 'M1 gateway (OpenAI chat/responses + Anthropic messages) + M3 routing + M4 usage -> Ollama', observedAt: new Date().toISOString(), realModelInference: false, results: {} };
const h = createGatewayServer({ upstreamBaseUrl: process.env.OLLAMA_BASE ?? 'http://localhost:11434', models: ['qwen3:8b'], defaultModel: 'qwen3:8b' });
try {
  const base = await listen(h, 0);
  proof.gatewayUrl = base;
  const P = 'Reply with exactly: OK. Do not explain.';
  proof.results.models = await (await fetch(base + '/v1/models')).json();
  const chat = await (await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen3:8b', messages: [{ role: 'user', content: P }], max_tokens: 512, stream: false }) })).json();
  proof.results.chat = { content: chat?.choices?.[0]?.message?.content, usage: chat?.usage };
  const msg = await (await fetch(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen3:8b', max_tokens: 512, messages: [{ role: 'user', content: P }] }) })).json();
  proof.results.messages = { type: msg?.type, text: msg?.content?.[0]?.text, usage: msg?.usage };
  const resp = await (await fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen3:8b', input: P, max_output_tokens: 512 }) })).json();
  proof.results.responses = { object: resp?.object, output_text: resp?.output_text, usage: resp?.usage };
  proof.results.usageSummary = await (await fetch(base + '/api/usage/summary')).json();
  const ok = (v) => String(v ?? '').trim().toUpperCase().includes('OK');
  proof.realModelInference = ok(proof.results.chat.content) && ok(proof.results.messages.text) && ok(proof.results.responses.output_text);
  if (!proof.realModelInference) process.exitCode = 1;
} catch (e) {
  proof.error = e instanceof Error ? e.message.slice(0, 200) : String(e);
  process.exitCode = 1;
} finally {
  try { await h.close(); } catch {}
  mkdirSync(resolve('docs/verification'), { recursive: true });
  mkdirSync(resolve('.cache/verification'), { recursive: true });
  const j = JSON.stringify(proof, null, 2) + '\n';
  writeFileSync(resolve('docs/verification/s13-m1-gateway-2026-11-20.json'), j);
  writeFileSync(resolve('.cache/verification/s13-m1-gateway.json'), j);
  console.log(j);
}
