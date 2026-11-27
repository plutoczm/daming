/** S13 plugin-framework smoke: drop-in plugins from a directory become gateway providers (echo + real WorkBuddy). */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGatewayServer, listen, loadPlugins, providerPluginsFromLoaded } from '../services/daming-gateway/src/index.ts';

const j = JSON.parse(readFileSync(process.env.USERPROFILE + '\\.config\\magpie\\plugin-auth.json', 'utf8'));
const wb = j['workbuddy'];
process.env.WORKBUDDY_ACCESS = wb.access; process.env.WORKBUDDY_UID = wb.uid; process.env.WORKBUDDY_DOMAIN = wb.domain;

const dir = fileURLToPath(new URL('../examples/plugins', import.meta.url));
const proof = { stage: 'S13', module: 'plugin framework (drop-in providers)', observedAt: new Date().toISOString(), ok: false };
const h = (() => { const reportP = loadPlugins(dir); return reportP; })();
try {
  const report = await h;
  proof.loadedPlugins = report.loaded.map((p) => p.manifest.id);
  proof.errors = report.errors;
  const bridged = providerPluginsFromLoaded(report.loaded);
  const models = [...new Set(bridged.flatMap((p) => p.models))];
  proof.models = models;
  const gw = createGatewayServer({ plugins: bridged, models, defaultModel: 'echo-1' });
  const base = await listen(gw, 0);
  try {
    const echo = await (await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'echo-1', messages: [{ role: 'user', content: 'hi' }] }) })).json();
    proof.echo = echo?.choices?.[0]?.message?.content;
    const wbChat = await (await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'Reply with exactly: OK. Do not explain.' }], max_tokens: 256 }) })).json();
    proof.workbuddy = wbChat?.choices?.[0]?.message?.content;
    proof.workbuddyUsage = wbChat?.usage;
    proof.ok = proof.echo === 'ECHO:hi' && String(proof.workbuddy ?? '').trim().toUpperCase().includes('OK');
  } finally { await gw.close(); }
  if (!proof.ok) process.exitCode = 1;
} catch (e) { proof.error = e instanceof Error ? e.message.slice(0, 240) : String(e); process.exitCode = 1; }
finally {
  mkdirSync(resolve('docs/verification'), { recursive: true }); mkdirSync(resolve('.cache/verification'), { recursive: true });
  const out = JSON.stringify(proof, null, 2) + '\n';
  writeFileSync(resolve('docs/verification/s13-m5-plugin-framework-2026-11-20.json'), out);
  writeFileSync(resolve('.cache/verification/s13-m5-plugin-framework.json'), out);
  console.log(out);
}
