import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SessionContext, WorkerResult, WorkerSession } from '@daming/workers';
import { DshExecRun } from './dsh-exec.ts';

interface SessionState {
  readonly context: SessionContext;
  readonly workspace: string;
  run?: DshExecRun;
}

export interface DshExecWorkerOptions {
  readonly executable: string;
  readonly entry: string;
  readonly workspaceRoot: string;
  readonly timeoutMs?: number;
}

/** Real DeepSeek Harness worker side; execution admission and budgets remain the Host Gateway's job. */
export class DshExecWorker implements WorkerSession {
  private readonly options: DshExecWorkerOptions;
  private readonly sessions = new Map<string, SessionState>();

  constructor(options: DshExecWorkerOptions) {
    if (!options || typeof options.executable !== 'string' || !options.executable) throw new Error('DSH executable is required');
    if (typeof options.entry !== 'string' || !options.entry) throw new Error('DSH entry is required');
    if (typeof options.workspaceRoot !== 'string' || !options.workspaceRoot) throw new Error('DSH workspace root is required');
    this.options = { ...options, workspaceRoot: resolve(options.workspaceRoot) };
    mkdirSync(this.options.workspaceRoot, { recursive: true });
  }

  createSession(context: SessionContext): void {
    if (this.sessions.has(context.sessionId)) throw new Error('Duplicate DSH session');
    this.sessions.set(context.sessionId, {
      context,
      workspace: mkdtempSync(join(this.options.workspaceRoot, 'run-'))
    });
  }

  async run(sessionId: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<WorkerResult> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Unknown DSH session');
    if (session.run) throw new Error('DSH session already running');
    const run = new DshExecRun({
      executable: this.options.executable,
      entry: this.options.entry,
      cwd: session.workspace,
      prompt: session.context.input.text,
      timeoutMs: options.timeoutMs ?? this.options.timeoutMs ?? 180000,
      signal: options.signal
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
      events: result.events.map((event) => ({ type: event.type })),
      ...(result.usage ? { usage: result.usage } : {})
    };
  }

  cancel(sessionId: string): void {
    this.sessions.get(sessionId)?.run?.cancel();
  }
}
