/** S13 M6 smoke: Claude Code via onboarding config -> Daming gateway -> Ollama (REAL agent turn). */
import { existsSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createGatewayServer, listen, writeAgentConfigs } from '../services/daming-gateway/src/index.ts';

const claudeExe = join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
const proof = { stage: 'S13', module: 'M6 agent onboarding (Claude Code -> Daming gateway -> Ollama)', observedAt: new Date().toISOString(), realAgentTurn: false };
const h = createGatewayServer({ upstreamBaseUrl: process.env.OLLAMA_BASE ?? 'http://localhost:11434', models: ['qwen3:8b'], defaultModel: 'qwen3:8b' });
let work;
try {
  const base = await listen(h, 0);
  proof.gatewayUrl = base;
  proof.claudeExe = existsSync(claudeExe);
  work = mkdtempSync(join(tmpdir(), 'daming-onboard-'));
  const files = writeAgentConfigs(['claude'], { openaiBaseUrl: base, anthropicBaseUrl: base, apiKey: 'daming', model: 'qwen3:8b' }, work);
  proof.configFile = files[0].path;
  proof.configPreview = files[0].content.split('\n').filter((l) => l && !l.startsWith('#')).join(' | ');
  // Run the REAL Claude Code against the Daming gateway using the generated env.
  const res = await new Promise((resolveDone) => {
    const child = spawn(claudeExe, ['-p', 'Reply with exactly: OK. Do not explain.', '--output-format', 'text', '--model', 'qwen3:8b'], {
      cwd: work, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: 'daming', CLAUDE_CONFIG_DIR: work, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1' },
    });
    let out = '', err = ''; child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 150000);
    child.once('close', (code) => { clearTimeout(t); resolveDone({ code, out, err }); });
    child.once('error', (e) => { clearTimeout(t); resolveDone({ code: -1, out, err: String(e) }); });
  });
  proof.claudeExit = res.code;
  proof.claudeStdout = String(res.out).trim().slice(0, 200);
  proof.claudeStderrTail = String(res.err).slice(-300);
  proof.realAgentTurn = res.code === 0 && String(res.out).trim().toUpperCase().includes('OK');
  proof.usage = await (await fetch(base + '/api/usage/summary')).json();
  if (!proof.realAgentTurn) process.exitCode = 1;
} catch (e) {
  proof.error = e instanceof Error ? e.message.slice(0, 200) : String(e); process.exitCode = 1;
} finally {
  try { await h.close(); } catch {}
  if (work) try { rmSync(work, { recursive: true, force: true }); } catch {}
  mkdirSync(resolve('docs/verification'), { recursive: true });
  mkdirSync(resolve('.cache/verification'), { recursive: true });
  const j = JSON.stringify(proof, null, 2) + '\n';
  writeFileSync(resolve('docs/verification/s13-m6-agent-onboarding-2026-11-20.json'), j);
  writeFileSync(resolve('.cache/verification/s13-m6-agent-onboarding.json'), j);
  console.log(j);
}

