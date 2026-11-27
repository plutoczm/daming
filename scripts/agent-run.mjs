#!/usr/bin/env node
/**
 * Unified host-side agent runner — ONE way to run dsh / codex / claude.
 * Uses the native-best interface per agent (dsh: ACP, codex: exec --json, claude: -p),
 * all as host processes (no Docker). This is the "T3/HiFox-style" unified entry.
 *
 * Usage:
 *   node scripts/agent-run.mjs --agent dsh|codex|claude --prompt "..." [--cwd DIR] [--model M]
 *                              [--sandbox read-only|workspace-write|bypass] [--magpie] [--timeout MS]
 *
 * --magpie routes claude/codex model traffic through the local Magpie gateway
 *          (ANTHROPIC_BASE_URL=http://127.0.0.1:3425, model workbuddy/deepseek-v4.1-flash).
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runAgent } from '../packages/worker-process/src/agent-driver.ts';

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def; };
const flag = (name) => argv.includes('--' + name);
const agent = opt('agent');
const prompt = opt('prompt');
if (!['dsh', 'codex', 'claude'].includes(agent) || !prompt) {
  console.error('usage: node scripts/agent-run.mjs --agent dsh|codex|claude --prompt "..." [--cwd DIR] [--model M] [--sandbox ...] [--magpie]');
  process.exit(2);
}
const own = !opt('cwd');
const cwd = own ? mkdtempSync(join(tmpdir(), 'daming-agent-run-')) : resolve(opt('cwd'));
const magpie = flag('magpie');
const model = opt('model', magpie ? (agent === 'claude' ? 'workbuddy/deepseek-v4.1-flash' : 'codex/gpt-6.1-sol') : undefined);
const env = magpie ? { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3425', ANTHROPIC_API_KEY: 'magpie', OPENAI_BASE_URL: 'http://127.0.0.1:3425/v1' } : undefined;
const out = { observedAt: new Date().toISOString(), agent, cwd, model: model ?? null, magpie };
try {
  const r = await runAgent(agent, { cwd, prompt, timeoutMs: Number(opt('timeout', 180000)), ...(model ? { model } : {}), sandbox: opt('sandbox'), ...(env ? { env } : {}) });
  Object.assign(out, r);
  if (r.status !== 'completed') process.exitCode = 1;
} catch (e) {
  out.error = e instanceof Error ? e.message.slice(0, 300) : String(e); process.exitCode = 1;
} finally {
  if (own) try { rmSync(cwd, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }); } catch {}
  mkdirSync(resolve('.cache/verification'), { recursive: true });
  console.log(JSON.stringify(out, null, 2));
}
