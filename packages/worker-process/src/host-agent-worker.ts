import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SessionContext, WorkerResult, WorkerSession } from '@daming/workers';
import { runAgent } from './agent-driver.ts';
import type { AgentId } from './agent-driver.ts';

export interface HostAgentWorkerOptions {
  readonly agent: AgentId;
  readonly workspaceRoot: string;
  readonly timeoutMs?: number;
  readonly model?: string;
  readonly sandbox?: 'read-only' | 'workspace-write' | 'bypass';
  readonly env?: NodeJS.ProcessEnv;
}

interface SessionState { readonly context: SessionContext; readonly workspace: string }

/**
 * WorkerSession that dispatches to the UNIFIED host agent driver (runAgent):
 * dsh -> ACP, codex -> codex exec --json, claude -> claude -p. Host process, no Docker.
 * Returns the exact session/task/run/attempt identity so the governance layer accepts it.
 */
export class HostAgentWorker implements WorkerSession {
  private readonly options: HostAgentWorkerOptions;
  private readonly sessions = new Map<string, SessionState>();
  private readonly aborts = new Map<string, AbortController>();

  constructor(options: HostAgentWorkerOptions) {
    if (!options || !['dsh', 'codex', 'claude'].includes(options.agent)) throw new Error('Host agent worker requires a known agent');
    if (typeof options.workspaceRoot !== 'string' || !options.workspaceRoot) throw new Error('Host agent worker requires a workspace root');
    this.options = { ...options, workspaceRoot: resolve(options.workspaceRoot) };
    mkdirSync(this.options.workspaceRoot, { recursive: true });
  }

  createSession(context: SessionContext): void {
    if (this.sessions.has(context.sessionId)) throw new Error('Duplicate host agent session');
    this.sessions.set(context.sessionId, { context, workspace: mkdtempSync(join(this.options.workspaceRoot, 'run-')) });
  }

  async run(sessionId: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<WorkerResult> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Unknown host agent session');
    if (this.aborts.has(sessionId)) throw new Error('Host agent session already running');
    const abort = new AbortController();
    this.aborts.set(sessionId, abort);
    if (options.signal) options.signal.addEventListener('abort', () => abort.abort(), { once: true });
    try {
      const r = await runAgent(this.options.agent, {
        cwd: session.workspace,
        prompt: session.context.input.text,
        timeoutMs: options.timeoutMs ?? this.options.timeoutMs ?? 300000,
        ...(this.options.model ? { model: this.options.model } : {}),
        ...(this.options.sandbox ? { sandbox: this.options.sandbox } : {}),
        ...(this.options.env ? { env: this.options.env } : {}),
      });
      return {
        mode: 'real',
        sessionId: session.context.sessionId,
        taskId: session.context.taskId,
        runId: session.context.runId,
        attemptId: session.context.attemptId,
        status: r.status,
        output: r.output,
        events: [{ type: 'final' }],
        ...(r.usage ? { usage: r.usage } : {}),
      };
    } finally {
      this.aborts.delete(sessionId);
      try { rmSync(session.workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ }
    }
  }

  cancel(sessionId: string): void {
    this.aborts.get(sessionId)?.abort();
  }
}
