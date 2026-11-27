/** S13 matrix: Daming gateway serves providers/plugins; agents drive a model via the gateway.
 *  Reads real creds from Magpie (plugin-auth.json / logins.json). Records per-cell pass/fail.
 *  Agents: claude (claude.exe via /v1/messages), codex (codex.exe via /v1/responses).
 *  DSH-through-gateway is not automated (would rewrite DSH profile); marked skipped, honestly. */
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createGatewayServer, gatewayConfigModels, listen, loadPlugins, parseGatewayConfig, pluginsFromConfig, providerPluginsFromLoaded } from '../services/daming-gateway/src/index.ts';

const HOME = process.env.USERPROFILE;
const pluginAuth = JSON.parse(readFileSync(join(HOME, '.config', 'magpie', 'plugin-auth.json'), 'utf8'));
const logins = JSON.parse(readFileSync(join(HOME, '.config', 'magpie', 'logins.json'), 'utf8'));
const codexLogin = (logins || []).find((r) => r.agent === 'codex');
const dsKey = (readFileSync(resolve('.env'), 'utf8').split(/\r?\n/).find((l) => l.startsWith('DEEPSEEK_API_KEY=')) || '').split('=').slice(1).join('=').trim();
// env for plugins
const wb = pluginAuth['workbuddy'];
process.env.WORKBUDDY_ACCESS = wb.access; process.env.WORKBUDDY_UID = wb.uid; process.env.WORKBUDDY_DOMAIN = wb.domain;
process.env.ZCODE_KEY = pluginAuth['zcode']?.access || '';
const kiro = pluginAuth['kiro'];
process.env.KIRO_ACCESS = kiro?.access || ''; process.env.KIRO_PROFILE_ARN = kiro?.profileArn || ''; process.env.KIRO_REGION = kiro?.region || 'us-east-1';
process.env.CODEX_ACCESS = codexLogin?.auth?.tokens?.access_token || ''; process.env.CODEX_ACCOUNT_ID = codexLogin?.auth?.tokens?.account_id || '';

const claudeExe = join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
const codexExe = (() => { const root = join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin'); try { for (const d of readdirSync(root)) { const p = join(root, d, 'codex.exe'); if (existsSync(p)) return p; } } catch {} return undefined; })();

function run(exe, args, cwd, env, timeoutMs) {
  return new Promise((res) => {
    const c = spawn(exe, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let out = '', err = ''; c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch {} }, timeoutMs);
    c.once('close', (code) => { clearTimeout(t); res({ code, out, err }); });
    c.once('error', (e) => { clearTimeout(t); res({ code: -1, out, err: String(e) }); });
  });
}
async function claudeTurn(gw, model) {
  const work = mkdtempSync(join(tmpdir(), 'mx-claude-'));
  try {
    const r = await run(claudeExe, ['-p', '请只回复 OK', '--output-format', 'text', '--model', model], work,
      { ...process.env, ANTHROPIC_BASE_URL: gw, ANTHROPIC_AUTH_TOKEN: 'daming', ANTHROPIC_API_KEY: 'daming', CLAUDE_CONFIG_DIR: work, ANTHROPIC_MODEL: model, ANTHROPIC_SMALL_FAST_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1' }, 150000);
    const text = String(r.out).trim();
    return { ok: r.code === 0 && text.length > 0 && !/all_providers_failed|upstream_error|INVALID_REQUEST|unexpected status|502/i.test(text), out: text.slice(0, 100), err: String(r.err).slice(-200), code: r.code };
  } finally { rmSync(work, { recursive: true, force: true }); }
}
async function codexTurn(gw, model) {
  const work = mkdtempSync(join(tmpdir(), 'mx-codex-'));
  try {
    const toml = `model_provider = "daming"\nmodel = "${model}"\n\n[model_providers.daming]\nname = "daming"\nbase_url = "${gw}/v1"\nwire_api = "responses"\nenv_key = "DAMING_GW_KEY"\n`;
    writeFileSync(join(work, 'config.toml'), toml);
    const r = await run(codexExe, ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-C', work, '请只回复 OK'], work,
      { ...process.env, CODEX_HOME: work, DAMING_GW_KEY: 'x' }, 120000);
    const text = String(r.out).trim();
    return { ok: r.code === 0 && text.replace(/tokens used\s*\d+/i, '').trim().length > 0 && !/all_providers_failed|upstream_error|INVALID_REQUEST|unexpected status|502/i.test(text), out: text.slice(-160), err: String(r.err).slice(-240), code: r.code };
  } finally { rmSync(work, { recursive: true, force: true }); }
}
async function dshTurn(gw, model) {
  const work = mkdtempSync(join(tmpdir(), 'mx-dsh-'));
  try {
    const overlay = join(work, 'overlay.yml');
    writeFileSync(overlay, `- id: llm-pi-ai\n  name: "@deepseek-ai/dsh-llm-pi-ai"\n  config:\n    providers:\n      magpie:\n        displayName: Daming Gateway\n        api: openai-completions\n        apiKeyEnv: DAMING_GW_KEY\n        baseURL: ${gw}/v1\n        models:\n          - id: ${model}\n            name: ${model}\n            input: [text]\n        streamIdleTimeoutMs: 600000\n- id: agent-default-model\n  config:\n    provider: magpie\n    model: "${model}"\n`);
    const exe = process.env.DSH_NODE_EXECUTABLE || 'D:\\dsh\\DeepSeek Harness.exe';
    const binJs = 'D:/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js';
    const r = await run(exe, [binJs, '--profile', 'headless', '--patch', overlay, '请只回复 OK'], work,
      { ...process.env, ELECTRON_RUN_AS_NODE: '1', DAMING_GW_KEY: 'x' }, 150000);
    const text = String(r.out).trim();
    return { ok: r.code === 0 && text.length > 0 && !/all_providers_failed|upstream_error|INVALID_REQUEST|unexpected status|502/i.test(text), out: text.slice(-200), err: String(r.err).slice(-240), code: r.code };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message.slice(0, 160) : String(e) }; }
}

const proof = { stage: 'S13', module: 'model-provider 鑴?agent matrix via Daming gateway', observedAt: new Date().toISOString(), results: [] };
try {
  const cfg = parseGatewayConfig(JSON.stringify({ providers: [
    { id: 'ollama', baseUrl: process.env.OLLAMA_BASE ?? 'http://localhost:11434', models: ['qwen3:8b'] },
    ...(dsKey ? [{ id: 'deepseek', baseUrl: 'https://api.deepseek.com', models: ['deepseek-chat'], apiKeyEnv: 'DEEPSEEK_API_KEY' }] : []),
  ] }));
  const basePlugins = pluginsFromConfig(cfg, { ...process.env, DEEPSEEK_API_KEY: dsKey });
  const report = await loadPlugins(fileURLToPath(new URL('../examples/plugins', import.meta.url)));
  const filePlugins = providerPluginsFromLoaded(report.loaded);
  const plugins = [...basePlugins, ...filePlugins];
  const models = [...new Set([...gatewayConfigModels(cfg), ...filePlugins.flatMap((p) => p.models)])];
  proof.plugins = plugins.map((p) => p.id); proof.models = models; proof.pluginErrors = report.errors;
  proof.creds = { workbuddy: !!process.env.WORKBUDDY_ACCESS, codex: !!process.env.CODEX_ACCESS, zcode: !!process.env.ZCODE_KEY, kiro: !!process.env.KIRO_ACCESS, deepseek: !!dsKey };
  const gwHandle = createGatewayServer({ plugins, models, defaultModel: 'qwen3:8b' });
  const gw = await listen(gwHandle, 0);
  try {
    const matrix = [
      ['qwen3:8b', 'ollama', ['claude', 'codex', 'dsh']],
      ['gpt-6.2-sol', 'codex-plugin', ['codex', 'dsh']],
      ['deepseek-v4.1-flash', 'workbuddy-plugin', ['dsh', 'claude']],
      ['deepseek-chat', 'deepseek-api', ['codex', 'dsh', 'claude']],
    ];
    for (const [model, provider, agents] of matrix) {
      for (const agent of agents) {
        let cell;
        if (false) { cell = { status: 'skipped', reason: 'dsh CLI 閺堫亜鐣炬担?鐠?DSH_BIN 閹稿洤鎮?dsh 閸忋儱褰涢崡鍐插讲); 瀹告彃顦稉瀛樻 --patch 鐟曞棛娲婇弬瑙勵攳 dshTurn()' }; }
        else {
          const startedAt = Date.now();
          try {
            const r = agent === 'claude' ? await claudeTurn(gw, model) : (agent === 'codex' ? await codexTurn(gw, model) : await dshTurn(gw, model));
            cell = { status: r.ok ? 'pass' : 'fail', code: r.code, out: r.out, err: r.err, ms: Date.now() - startedAt, ...(r.error ? { error: r.error } : {}), ...(r.note ? { note: r.note } : {}) };
          }
          catch (e) { cell = { status: 'fail', error: e instanceof Error ? e.message.slice(0, 160) : String(e) }; }
        }
        proof.results.push({ model, provider, agent, ...cell });
        console.log(`${model} 鑴?${agent} 閳?${cell.status}`);
      }
    }
  } finally { await gwHandle.close(); }
} catch (e) { proof.error = e instanceof Error ? e.message.slice(0, 240) : String(e); }
finally {
  mkdirSync(resolve('docs/verification'), { recursive: true }); mkdirSync(resolve('.cache/verification'), { recursive: true });
  const out = JSON.stringify(proof, null, 2) + '\n';
  writeFileSync(resolve('docs/verification/s13-matrix-2026-11-20.json'), out);
  writeFileSync(resolve('.cache/verification/s13-matrix.json'), out);
  console.log(out);
}


