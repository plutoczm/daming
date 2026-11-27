import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SessionContext, WorkerResult, WorkerSession } from '@daming/workers';
import { CodexExecRun } from './codex-exec.ts';

interface SessionState {
  readonly context: SessionContext;
  readonly workspace: string;
  run?: CodexExecRun;
}

export interface CodexExecWorkerOptions {
  readonly executable: string;
  readonly workspaceRoot: string;
  readonly timeoutMs?: number;
  readonly model?: string;
  readonly ignoreUserConfig?: boolean;
}

/** Real Codex worker side; execution admission and budgets remain the Host Gateway's job. */
export class CodexExecWorker implements WorkerSession {
  private readonly options: CodexExecWorkerOptions;
  private readonly sessions = new Map<string, SessionState>();

  constructor(options: CodexExecWorkerOptions) {
    if (!options || typeof options.executable !== 'string' || !options.executable) throw new Error('Codex executable is required');
    if (typeof options.workspaceRoot !== 'string' || !options.workspaceRoot) throw new Error('Codex workspace root is required');
    this.options = { ...options, workspaceRoot: resolve(options.workspaceRoot) };
    mkdirSync(this.options.workspaceRoot, { recursive: true });
  }

  createSession(context: SessionContext): void {
    if (this.sessions.has(context.sessionId)) throw new Error('Duplicate Codex session');
    this.sessions.set(context.sessionId, {
      context,
      workspace: mkdtempSync(join(this.options.workspaceRoot, 'run-'))
    });
  }

  async run(sessionId: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<WorkerResult> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Unknown Codex session');
    if (session.run) throw new Error('Codex session already running');
    const run = new CodexExecRun({
      executable: this.options.executable,
      cwd: session.workspace,
      prompt: session.context.input.text,
      timeoutMs: options.timeoutMs ?? this.options.timeoutMs ?? 120000,
      signal: options.signal,
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(this.options.ignoreUserConfig ? { ignoreUserConfig: true } : {})
    });
    session.run = run;
    const result = await run.run();
    rmSync(session.workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    return {
      mode: 'real',
      sessionId: session.context.sessionId,
      taskId: session.context.taskId,
      runId: session.context.runId,
      attemptId: session.context.attemptId,
      status: result.status,
      output: result.output,
      events: result.events.map((event) => ({ type: event.type }))
    };
  }

  cancel(sessionId: string): void {
    this.sessions.get(sessionId)?.run?.cancel();
  }
}
