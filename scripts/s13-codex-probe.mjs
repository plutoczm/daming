/** Codex agent via Daming gateway /v1/responses (wire_api=responses). Focused probe. */
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createGatewayServer, listen, loadPlugins, parseGatewayConfig, pluginsFromConfig, providerPluginsFromLoaded } from '../services/daming-gateway/src/index.ts';

const HOME = process.env.USERPROFILE;
const pa = JSON.parse(readFileSync(join(HOME, '.config', 'magpie', 'plugin-auth.json'), 'utf8'));
const logins = JSON.parse(readFileSync(join(HOME, '.config', 'magpie', 'logins.json'), 'utf8'));
const codexLogin = (logins || []).find((r) => r.agent === 'codex');
process.env.CODEX_ACCESS = codexLogin?.auth?.tokens?.access_token || ''; process.env.CODEX_ACCOUNT_ID = codexLogin?.auth?.tokens?.account_id || '';
const wb = pa['workbuddy']; process.env.WORKBUDDY_ACCESS = wb.access; process.env.WORKBUDDY_UID = wb.uid; process.env.WORKBUDDY_DOMAIN = wb.domain;
const dsKey = ((readFileSync(resolve('.env'), 'utf8').split(/\r?\n/).find((l) => l.startsWith('DEEPSEEK_API_KEY=')) || '').split('=').slice(1).join('=')).trim();
const codexExe = (() => { const root = join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin'); for (const d of readdirSync(root)) { const p = join(root, d, 'codex.exe'); if (existsSync(p)) return p; } return 'codex'; })();
function run(exe, args, cwd, env, ms) { return new Promise((res) => { const c = spawn(exe, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); let o = '', e = ''; c.stdout.on('data', (d) => (o += d)); c.stderr.on('data', (d) => (e += d)); const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch {} }, ms); c.once('close', (code) => { clearTimeout(t); res({ code, o, e }); }); c.once('error', (x) => { clearTimeout(t); res({ code: -1, o, e: String(x) }); }); }); }
async function codexTurn(gw, model) {
  const work = mkdtempSync(join(tmpdir(), 'cx-'));
  try {
    writeFileSync(join(work, 'config.toml'), `model_provider = "daming"\nmodel = "${model}"\n\n[model_providers.daming]\nname = "daming"\nbase_url = "${gw}/v1"\nwire_api = "responses"\nenv_key = "DAMING_GW_KEY"\n`);
    const r = await run(codexExe, ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-C', work, 'Reply with exactly: OK. Do not explain.'], work, { ...process.env, CODEX_HOME: work, DAMING_GW_KEY: 'x' }, 90000);
    const t = String(r.o).trim();
    return { ok: r.code === 0 && t.toUpperCase().includes('OK'), code: r.code, out: t.slice(-160), err: String(r.e).slice(-200) };
  } finally { rmSync(work, { recursive: true, force: true }); }
}
const proof = { module: 'codex via gateway responses', observedAt: new Date().toISOString(), dsKeyLen: dsKey.length, results: [] };
try {
  const cfg = parseGatewayConfig(JSON.stringify({ providers: [
    { id: 'ollama', baseUrl: process.env.OLLAMA_BASE ?? 'http://localhost:11434', models: ['qwen3:8b'] },
    ...(dsKey ? [{ id: 'deepseek', baseUrl: 'https://api.deepseek.com', models: ['deepseek-chat'], apiKeyEnv: 'DEEPSEEK_API_KEY' }] : []),
  ] }));
  const plugins = [...pluginsFromConfig(cfg, { ...process.env, DEEPSEEK_API_KEY: dsKey }), ...providerPluginsFromLoaded((await loadPlugins(fileURLToPath(new URL('../examples/plugins', import.meta.url)))).loaded)];
  const models = ['qwen3:8b', 'deepseek-chat', 'gpt-6.2-sol', 'deepseek-v4.1-flash'];
  const h = createGatewayServer({ plugins, models, defaultModel: 'qwen3:8b' });
  const gw = await listen(h, 0);
  try {
    for (const m of models) { const r = await codexTurn(gw, m); proof.results.push({ model: m, ...r }); console.log(m, ' ->', r.ok ? 'pass' : 'fail', '|', r.err.slice(0, 90).replace(/\n/g, ' ')); }
  } finally { await h.close(); }
} catch (e) { proof.error = String(e).slice(0, 240); }
finally { mkdirSync(resolve('.cache/verification'), { recursive: true }); writeFileSync(resolve('.cache/verification/s13-codex-probe.json'), JSON.stringify(proof, null, 2)); console.log(JSON.stringify(proof, null, 2)); }
