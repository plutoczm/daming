/** S10 unified agent driver smoke: run dsh/codex/claude through ONE host-side entry (no Docker). */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runAgent } from '../packages/worker-process/src/agent-driver.ts';

const PROMPT = 'Reply with exactly: OK. Do not call tools.';
const PROXY = { HTTPS_PROXY: 'http://127.0.0.1:7890', HTTP_PROXY: 'http://127.0.0.1:7890', ALL_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'localhost,127.0.0.1,::1' };
const MAGPIE = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3425', ANTHROPIC_API_KEY: 'magpie', OPENAI_BASE_URL: 'http://127.0.0.1:3425/v1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1' };
const plan = [
  { agent: 'dsh', transport: 'ACP (dsh --profile acp)', input: {} },
  { agent: 'codex', transport: 'CLI stream-json (codex exec --json; ChatGPT backend via proxy)', input: { env: PROXY } },
  { agent: 'claude', transport: 'CLI (claude.exe -p --output-format text -> Magpie /v1/messages)', input: { model: 'workbuddy/deepseek-v4.1-flash', env: MAGPIE } },
];
const proof = { stage: 'S10', kind: 'unified agent driver (host-side, no Docker) — one entry: runAgent(agent, input)', observedAt: new Date().toISOString(), results: [] };
for (const p of plan) {
  const cwd = mkdtempSync(join(tmpdir(), 'daming-unified-'));
  try {
    const r = await runAgent(p.agent, { cwd, prompt: PROMPT, timeoutMs: 180000, ...p.input });
    proof.results.push({ agent: p.agent, transport: p.transport, status: r.status, output: r.output, sessionId: r.sessionId, usage: r.usage, error: r.error });
  } catch (e) {
    proof.results.push({ agent: p.agent, transport: p.transport, status: 'failed', error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
  } finally { try { rmSync(cwd, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }); } catch {} }
}
proof.allOk = proof.results.length === 3 && proof.results.every((r) => r.status === 'completed' && (r.output || '').trim().replace(/\.$/, '') === 'OK');
mkdirSync(resolve('docs/verification'), { recursive: true });
mkdirSync(resolve('.cache/verification'), { recursive: true });
const json = JSON.stringify(proof, null, 2) + '\n';
writeFileSync(resolve('docs/verification/s10-unified-agent-driver-2026-11-19.json'), json);
writeFileSync(resolve('.cache/verification/s10-unified-agent-driver.json'), json);
console.log(json);
if (!proof.allOk) process.exitCode = 1;
