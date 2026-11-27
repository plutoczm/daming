/**
 * ACP (Agent Client Protocol) client driver — JSON-RPC over stdio.
 *
 * This is the "one driver per Agent, speak the protocol" transport that T3 Code
 * and HiFox both use. DSH exposes a standard ACP server (`dsh --profile acp`,
 * agentInfo.name = "deepseek-harness-acp"), so it can be driven the same way as
 * T3 drives it, instead of DSH's private `--json` stream.
 *
 * Minimal, robust client: initialize -> session/new -> session/prompt, streams
 * session/update notifications, answers session/request_permission (auto-allow
 * when the agent offers an allow option), and bounds everything with a timeout.
 * Server->client requests we do not implement get a JSON-RPC error (never hang).
 */
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export interface AcpContentBlock { readonly type: string; readonly text?: string }
export interface AcpSessionUpdate {
  readonly sessionUpdate?: string;
  readonly content?: AcpContentBlock;
  readonly [key: string]: unknown;
}
export interface AcpTurnResult {
  readonly status: 'completed' | 'cancelled' | 'failed';
  readonly output: string;
  readonly sessionId?: string;
  readonly stopReason?: string;
  readonly updates: readonly string[];
  readonly usage?: Readonly<Record<string, number>>;
  readonly error?: string;
}
export interface AcpLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}
export interface AcpTurnOptions {
  readonly cwd: string;
  readonly prompt: string;
  readonly timeoutMs?: number;
  /** Auto-select permission options whose kind contains 'allow'. Default true. */
  readonly autoAllowTools?: boolean;
}

/** Resolve the DSH ACP launch for this install (desktop exe + cli.js entry, or a plain `dsh` binary). */
export function dshAcpLaunch(): AcpLaunch {
  const exe = process.env.DAMING_DSH_EXE?.trim() || 'D:/dsh/DeepSeek Harness.exe';
  const entry = process.env.DAMING_DSH_ENTRY?.trim()
    || 'D:/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js';
  const env = { ...process.env };
  // Desktop Electron executable needs ELECTRON_RUN_AS_NODE to act as a CLI.
  if (/DeepSeek Harness\.exe$/i.test(exe)) env.ELECTRON_RUN_AS_NODE = '1';
  return { command: exe, args: [entry, '--profile', 'acp'], env };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** One ACP turn against an already-spawned server process. */
export function runAcpTurn(child: ChildProcessWithoutNullStreams, options: AcpTurnOptions): Promise<AcpTurnResult> {
  const { cwd, prompt } = options;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const autoAllow = options.autoAllowTools ?? true;
  return new Promise((resolve) => {
    let buffer = '';
    let sessionId: string | undefined;
    let settled = false;
    const texts: string[] = [];
    const updates: string[] = [];
    const usage: Record<string, number> = {};
    const finish = (result: AcpTurnResult) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* ignore */ }
      resolve(result);
    };
    const send = (obj: unknown) => { try { child.stdin.write(JSON.stringify(obj) + '\n'); } catch { /* ignore */ } };

    const handle = (msg: Record<string, unknown>) => {
      // Server -> client request
      if (typeof msg.method === 'string' && msg.id !== undefined) {
        const id = msg.id;
        if (msg.method === 'session/request_permission') {
          const params = isRecord(msg.params) ? msg.params : {};
          const opts = Array.isArray(params.options) ? params.options as Array<Record<string, unknown>> : [];
          const allow = autoAllow
            ? opts.find((o) => typeof o.kind === 'string' && /allow/i.test(o.kind)) ?? opts[0]
            : undefined;
          if (allow && typeof allow.optionId === 'string') {
            send({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'selected', optionId: allow.optionId } } });
          } else {
            send({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'cancelled' } } });
          }
          return;
        }
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method_not_supported' } });
        return;
      }
      // Server -> client notification
      if (msg.method === 'session/update') {
        const params = isRecord(msg.params) ? msg.params : {};
        const update = isRecord(params.update) ? params.update as AcpSessionUpdate : {};
        if (typeof update.sessionUpdate === 'string') updates.push(update.sessionUpdate);
        if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && typeof update.content.text === 'string') {
          texts.push(update.content.text);
        }
        if (update.sessionUpdate === 'usage_update' && isRecord(update.usage)) {
          for (const [k, v] of Object.entries(update.usage)) if (typeof v === 'number' && Number.isFinite(v)) usage[k] = v;
        }
        return;
      }
      // responses
      if (msg.id === 1) {
        if (msg.error) return finish({ status: 'failed', output: '', updates, error: 'acp_initialize_failed' });
        send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd, mcpServers: [] } });
      } else if (msg.id === 2) {
        const result = isRecord(msg.result) ? msg.result : {};
        if (msg.error || typeof result.sessionId !== 'string') {
          return finish({ status: 'failed', output: '', updates, error: 'acp_session_new_failed' });
        }
        sessionId = result.sessionId;
        send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: prompt }] } });
      } else if (msg.id === 3) {
        const result = isRecord(msg.result) ? msg.result : {};
        const stopReason = typeof result.stopReason === 'string' ? result.stopReason : undefined;
        const status = stopReason === 'cancelled' ? 'cancelled' : msg.error ? 'failed' : 'completed';
        finish({ status, output: texts.join(''), sessionId, ...(stopReason ? { stopReason } : {}),
          updates, ...(Object.keys(usage).length ? { usage } : {}), ...(msg.error ? { error: 'acp_prompt_failed' } : {}) });
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg: unknown;
        try { msg = JSON.parse(line); } catch { continue; }
        if (isRecord(msg)) handle(msg);
      }
    });
    child.once('error', () => finish({ status: 'failed', output: '', updates, error: 'acp_spawn_error' }));
    child.once('close', () => { if (!settled) finish({ status: 'failed', output: texts.join(''), updates, error: 'acp_transport_closed' }); });
    const timer = setTimeout(() => finish({ status: 'failed', output: texts.join(''), sessionId, updates, error: 'acp_timeout' }), timeoutMs);

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: { fs: false, terminal: false } } });
  });
}

/** Spawn an ACP server from a launch descriptor and run one turn. */
export async function spawnAcpTurn(launch: AcpLaunch, options: AcpTurnOptions): Promise<AcpTurnResult> {
  const child = spawn(launch.command, [...launch.args], {
    cwd: options.cwd, env: launch.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,
  });
  child.stderr.resume();
  return runAcpTurn(child, options);
}
