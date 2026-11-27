/**
 * Unified Agent driver layer — the "one driver interface, host-run, native-best
 * interface per agent" model that T3 Code / HiFox use (NO Docker for execution):
 *
 *   dsh    -> native ACP server:            `dsh --profile acp`
 *   codex  -> native CLI stream-json:       `codex exec --json`
 *   claude -> native CLI stream-json:       `claude -p --output-format text`
 *
 * All three run as host processes and return a common AgentTurnResult.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnAcpTurn, dshAcpLaunch } from './native-dsh-acp-session.ts';

export type AgentId = 'dsh' | 'codex' | 'claude';
export interface AgentTurnInput {
  readonly cwd: string;
  readonly prompt: string;
  readonly timeoutMs?: number;
  readonly model?: string;
  /** codex only: sandbox policy; 'bypass' = --dangerously-bypass-approvals-and-sandbox (external temp dir only). */
  readonly sandbox?: 'read-only' | 'workspace-write' | 'bypass';
  /** claude/codex: extra env (e.g. ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY for a gateway). */
  readonly env?: NodeJS.ProcessEnv;
}
export interface AgentTurnResult {
  readonly agent: AgentId;
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly output: string;
  readonly sessionId?: string;
  readonly usage?: Readonly<Record<string, number>>;
  readonly error?: string;
}
export interface AgentDriver { readonly id: AgentId; run(input: AgentTurnInput): Promise<AgentTurnResult>; }

function collect(child: ReturnType<typeof spawn>, timeoutMs: number) {
  return new Promise<{ code: number | null; out: string; err: string; timedOut: boolean }>((resolve) => {
    let out = '', err = '', done = false;
    const finish = (code: number | null, timedOut: boolean) => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ code, out, err, timedOut });
    };
    child.stdout?.on('data', (d: Buffer) => { if (out.length < 4 * 1024 * 1024) out += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { if (err.length < 65536) err += d.toString('utf8'); });
    child.once('error', (e) => { err += e.message; finish(-1, false); });
    child.once('close', (code) => finish(code, false));
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } finish(null, true); }, timeoutMs);
  });
}

function findCodex(): string | undefined {
  const root = join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin');
  if (!existsSync(root)) return undefined;
  for (const d of readdirSync(root)) { const p = join(root, d, 'codex.exe'); if (existsSync(p)) return p; }
  return undefined;
}

function findClaude(): string {
  if (process.platform === 'win32') {
    const exe = join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (existsSync(exe)) return exe;
    return 'claude.cmd';
  }
  return 'claude';
}

/** DSH — native ACP server. */
export const dshDriver: AgentDriver = {
  id: 'dsh',
  async run(input) {
    const r = await spawnAcpTurn(dshAcpLaunch(), { cwd: input.cwd, prompt: input.prompt, timeoutMs: input.timeoutMs ?? 120000 });
    return { agent: 'dsh', status: r.status, output: r.output, ...(r.sessionId ? { sessionId: r.sessionId } : {}), ...(r.usage ? { usage: r.usage } : {}), ...(r.error ? { error: r.error } : {}) };
  },
};

/** Codex — native CLI stream-json (`codex exec --json`). */
export const codexDriver: AgentDriver = {
  id: 'codex',
  async run(input) {
    const exe = findCodex();
    if (!exe) return { agent: 'codex', status: 'failed', output: '', error: 'codex_cli_missing' };
    const sandbox = input.sandbox ?? 'read-only';
    const args = ['exec', '--json'];
    if (sandbox === 'bypass') args.push('--dangerously-bypass-approvals-and-sandbox');
    else args.push('-s', sandbox, '-c', 'approval_policy="never"');
    if (input.model) args.push('-m', input.model);
    args.push('--skip-git-repo-check', '-C', input.cwd, input.prompt);
    const env = { ...process.env, ...(input.env ?? {}) };
    const child = spawn(exe, args, { cwd: input.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    const r = await collect(child, input.timeoutMs ?? 180000);
    let sessionId: string | undefined, completed = false; const texts: string[] = []; const usage: Record<string, number> = {};
    for (const line of r.out.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let m: unknown; try { m = JSON.parse(line); } catch { continue; }
      const rec = m as Record<string, unknown>;
      if (rec.type === 'thread.started' && typeof rec.thread_id === 'string') sessionId = rec.thread_id;
      const item = rec.item as Record<string, unknown> | undefined;
      if (rec.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') texts.push(item.text);
      if (rec.type === 'turn.completed') { completed = true; const u = rec.usage as Record<string, unknown> | undefined; if (u) for (const [k, v] of Object.entries(u)) if (typeof v === 'number') usage[k] = v; }
    }
    const status = r.timedOut ? 'failed' : (r.code === 0 && (completed || texts.length > 0)) ? 'completed' : 'failed';
    return { agent: 'codex', status, output: texts.join('\n'), ...(sessionId ? { sessionId } : {}), ...(Object.keys(usage).length ? { usage } : {}), ...(status !== 'completed' ? { error: r.timedOut ? 'codex_timeout' : (r.err.slice(-200) || 'codex_failed') } : {}) };
  },
};

/** Claude Code — native CLI (`claude -p --output-format text`). Gateway via env (ANTHROPIC_BASE_URL/KEY). */
export const claudeDriver: AgentDriver = {
  id: 'claude',
  async run(input) {
    const cmd = findClaude();
    const args = ['-p', input.prompt, '--output-format', 'text'];
    if (input.model) args.push('--model', input.model);
    const env = { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', ...(input.env ?? {}) };
    let child;
    try { child = spawn(cmd, args, { cwd: input.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false }); }
    catch { return { agent: 'claude', status: 'failed', output: '', error: 'claude_cli_missing' }; }
    const r = await collect(child, input.timeoutMs ?? 180000);
    if (r.code === -1 && /ENOENT/.test(r.err)) return { agent: 'claude', status: 'failed', output: '', error: 'claude_cli_missing' };
    const status = r.timedOut ? 'failed' : r.code === 0 ? 'completed' : 'failed';
    return { agent: 'claude', status, output: r.out.trim(), ...(status !== 'completed' ? { error: r.timedOut ? 'claude_timeout' : (r.err.slice(-200) || 'claude_failed') } : {}) };
  },
};

export const agentDrivers: Readonly<Record<AgentId, AgentDriver>> = Object.freeze({ dsh: dshDriver, codex: codexDriver, claude: claudeDriver });

/** The single entry: run any agent, host-side, one common result. */
export function runAgent(agent: AgentId, input: AgentTurnInput): Promise<AgentTurnResult> {
  const driver = agentDrivers[agent];
  if (!driver) return Promise.resolve({ agent, status: 'failed', output: '', error: 'unknown_agent' });
  return driver.run(input);
}
