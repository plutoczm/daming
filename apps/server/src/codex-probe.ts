import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CodexExecRun } from '@daming/worker-process';
import type { CodexExecEventView } from '@daming/worker-process';
import type { RealCodexEventView, RealCodexRunView } from '@daming/contracts';

interface RunRecord {
  readonly runId: string;
  readonly prompt: string;
  readonly startedAt: string;
  status: RealCodexRunView['status'];
  endedAt: string | null;
  output: string;
  events: RealCodexEventView[];
  error?: string;
  readonly workspace: string;
}

function eventView(event: CodexExecEventView): RealCodexEventView {
  return {
    type: event.type, at: event.at,
    ...(event.itemType === undefined ? {} : { itemType: event.itemType }),
    ...(event.text === undefined ? {} : { text: event.text }),
    ...(event.status === undefined ? {} : { status: event.status }),
    ...(event.error === undefined ? {} : { error: event.error })
  };
}

/** Read-only Codex probe; not a production Worker or task effect. */
export class CodexProbeService {
  private readonly executable: string | undefined;
  private readonly root: string;
  private readonly runs = new Map<string, RunRecord>();

  constructor(options: { executable?: string; root: string }) {
    this.executable = options.executable?.trim() || undefined;
    this.root = options.root;
  }

  get enabled(): boolean { return this.executable !== undefined; }

  start(prompt: string): { runId: string } {
    if (!this.executable) throw new Error('codex_probe_not_configured');
    if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 60000) throw new Error('codex_probe_prompt_invalid');
    const runId = randomUUID();
    const workspace = join(this.root, runId);
    mkdirSync(workspace, { recursive: true });
    const record: RunRecord = {
      runId, prompt: prompt.trim(), startedAt: new Date().toISOString(), status: 'running',
      endedAt: null, output: '', events: [], workspace
    };
    this.runs.set(runId, record);
    const run = new CodexExecRun({ executable: this.executable, cwd: workspace, prompt: record.prompt, timeoutMs: 120000 });
    void run.run().then((result) => {
      record.status = result.status;
      record.endedAt = new Date().toISOString();
      record.output = result.output;
      record.events = result.events.map(eventView);
      if (result.error) record.error = result.error;
      rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }).catch(() => {
      record.status = 'failed';
      record.endedAt = new Date().toISOString();
      record.error = 'codex_probe_failed';
      rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    });
    return { runId };
  }

  get(runId: string): RealCodexRunView | undefined {
    const record = this.runs.get(runId);
    if (!record) return undefined;
    return {
      runId: record.runId, status: record.status, prompt: record.prompt,
      startedAt: record.startedAt, endedAt: record.endedAt, output: record.output,
      events: [...record.events], ...(record.error === undefined ? {} : { error: record.error })
    };
  }
}

export function createCodexProbe(root: string): CodexProbeService {
  return new CodexProbeService({ root, executable: process.env.DAMING_CODEX_EXE });
}
