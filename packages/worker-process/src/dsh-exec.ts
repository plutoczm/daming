import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export interface DshExecOptions {
  readonly executable: string;
  readonly entry: string;
  readonly cwd: string;
  readonly prompt: string;
  /** Prefix for test doubles; production DSH runs the packaged entry directly. */
  readonly commandArgs?: readonly string[];
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
}

export interface DshExecEventView {
  readonly type: string;
  readonly at: string;
  readonly phase?: string;
  readonly text?: string;
  readonly status?: string;
  readonly tool?: string;
  readonly error?: string;
}

export interface DshExecResult {
  readonly status: 'completed' | 'failed' | 'timed_out' | 'cancelled';
  readonly exitCode: number | null;
  readonly output: string;
  readonly events: readonly DshExecEventView[];
  readonly usage?: Readonly<Record<string, number>>;
  readonly error?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length ? value : undefined;
}

function limit(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > 16 * 1024 * 1024) throw new Error('Invalid DSH output limit');
  return result;
}

export class DshExecRun {
  private readonly options: Required<Omit<DshExecOptions, 'signal' | 'commandArgs'>> & { signal?: AbortSignal; commandArgs: readonly string[] };
  private child?: ChildProcessByStdio<Writable, Readable, Readable>;
  private cancelled = false;
  private settled = false;
  private bytes = 0;
  private buffer = '';
  private stderr = '';
  private readonly events: DshExecEventView[] = [];
  private readonly texts: string[] = [];
  private readonly usage: Record<string, number> = {};
  private finalText: string | undefined;
  private finalReason: string | undefined;
  private lastError: string | undefined;
  private sawFinal = false;

  constructor(options: DshExecOptions) {
    if (!options || typeof options !== 'object') throw new Error('DSH options are required');
    if (typeof options.executable !== 'string' || !isAbsolute(options.executable) || !statSync(options.executable).isFile()) throw new Error('DSH executable must be an absolute file');
    if (typeof options.entry !== 'string' || !isAbsolute(options.entry)) throw new Error('DSH entry must be an absolute path');
    if (typeof options.cwd !== 'string' || !isAbsolute(options.cwd) || !statSync(options.cwd).isDirectory()) throw new Error('DSH cwd must be an absolute directory');
    if (typeof options.prompt !== 'string' || !options.prompt.trim() || Buffer.byteLength(options.prompt) > 60000) throw new Error('DSH prompt is invalid');
    this.options = {
      executable: options.executable, entry: options.entry, cwd: options.cwd, prompt: options.prompt,
      timeoutMs: limit(options.timeoutMs, 180000), maxOutputBytes: limit(options.maxOutputBytes, 1024 * 1024),
      signal: options.signal, commandArgs: options.commandArgs ?? []
    };
  }

  private event(type: string, extra: Omit<DshExecEventView, 'type' | 'at'> = {}): void {
    this.events.push({ type, at: new Date().toISOString(), ...extra });
  }

  private addUsage(value: unknown): void {
    const usage = record(value);
    for (const [key, item] of Object.entries(usage)) {
      if (typeof item === 'number' && Number.isFinite(item) && item >= 0) this.usage[key] = (this.usage[key] ?? 0) + item;
    }
  }

  private consume(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: Record<string, unknown>;
    try { parsed = record(JSON.parse(trimmed)); } catch { this.event('stream_error', { error: 'invalid_json_line' }); return; }
    const type = text(parsed.type) ?? 'unknown';
    switch (type) {
      case 'session': {
        const sessionId = text(parsed.sessionId);
        this.event(type, sessionId ? { status: sessionId } : {});
        return;
      }
      case 'status': {
        const phase = text(parsed.phase);
        if (phase === 'step_end') this.addUsage(parsed.usage);
        this.event(type, { ...(phase ? { phase } : {}), ...(text(parsed.reason) ? { status: text(parsed.reason)! } : {}) });
        return;
      }
      case 'thinking': {
        const body = text(parsed.text);
        if (body) this.event(type, { text: body });
        return;
      }
      case 'text': {
        const body = text(parsed.text);
        if (body) { this.texts.push(body); this.event(type, { text: body }); }
        return;
      }
      case 'tool_call': {
        const tool = text(parsed.tool);
        this.event(type, { ...(tool ? { tool } : {}) });
        return;
      }
      case 'tool_result': {
        const status = text(parsed.status);
        const error = text(parsed.error);
        this.event(type, { ...(status ? { status } : {}), ...(error ? { error } : {}) });
        return;
      }
      case 'final': {
        this.sawFinal = true;
        this.finalText = text(parsed.text) ?? '';
        const reason = text(parsed.reason);
        if (reason) this.finalReason = reason;
        this.event(type, { status: reason ? 'failed' : 'completed', ...(this.finalText ? { text: this.finalText } : {}) });
        return;
      }
      case 'error': {
        this.lastError = text(parsed.message) ?? 'dsh_error';
        this.event(type, { error: this.lastError });
        return;
      }
      default:
        this.event(type);
    }
  }

  async run(): Promise<DshExecResult> {
    if (this.child) throw new Error('DSH run already started');
    if (this.options.signal?.aborted) return { status: 'cancelled', exitCode: null, output: '', events: [], usage: undefined };
    const env: NodeJS.ProcessEnv = {};
    for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'PATH', 'DSH_HOME', 'LANG', 'LANGUAGE', 'LC_ALL', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL']) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    env.ELECTRON_RUN_AS_NODE = '1';
    env.DSH_PERMISSION_MODE = 'read-only';
    this.child = spawn(this.options.executable, [
      ...this.options.commandArgs,
      this.options.entry, '--profile', 'headless', '--json', '--approval-policy', 'never', '-'
    ], { cwd: this.options.cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdin.end(this.options.prompt, 'utf8');
    const finish = (status: DshExecResult['status'], exitCode: number | null, error?: string): DshExecResult => {
      this.settled = true;
      const output = this.finalText ?? this.texts.join('\n');
      return { status, exitCode, output, events: [...this.events], usage: Object.keys(this.usage).length ? { ...this.usage } : undefined, ...(error ? { error } : {}) };
    };
    return await new Promise<DshExecResult>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (status: DshExecResult['status'], exitCode: number | null, error?: string) => {
        if (this.settled) return;
        if (timer) clearTimeout(timer);
        this.options.signal?.removeEventListener('abort', abort);
        this.child?.removeAllListeners();
        resolve(finish(status, exitCode, error));
      };
      const abort = () => {
        this.cancelled = true;
        this.event('cancelled');
        this.child?.kill('SIGTERM');
        setTimeout(() => this.child?.kill('SIGKILL'), 500).unref();
        done('cancelled', null);
      };
      this.options.signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        this.event('timeout');
        this.child?.kill('SIGTERM');
        setTimeout(() => this.child?.kill('SIGKILL'), 500).unref();
        done('timed_out', null, 'timeout');
      }, this.options.timeoutMs);
      this.child!.stdout.on('data', (chunk: Buffer) => {
        if (this.settled) return;
        this.bytes += chunk.length;
        if (this.bytes > this.options.maxOutputBytes) { this.event('output_limit'); this.child?.kill('SIGKILL'); done('failed', null, 'output_limit'); return; }
        this.buffer += chunk.toString('utf8');
        let newline;
        while ((newline = this.buffer.indexOf('\n')) >= 0) { this.consume(this.buffer.slice(0, newline)); this.buffer = this.buffer.slice(newline + 1); }
      });
      this.child!.stderr.on('data', (chunk: Buffer) => {
        if (this.stderr.length < 4096) this.stderr += chunk.toString('utf8').slice(0, 4096 - this.stderr.length);
      });
      this.child!.once('error', () => done('failed', null, 'spawn_error'));
      this.child!.once('close', (code) => {
        if (this.buffer) this.consume(this.buffer);
        if (this.cancelled) return done('cancelled', code);
        if (code === 0) {
          if (!this.sawFinal) return done('failed', code, 'missing_final_event');
          if (this.finalReason) return done('failed', code, this.finalReason);
          return done('completed', code);
        }
        done('failed', code, this.lastError ?? this.stderr.trim() ?? 'nonzero_exit');
      });
    });
  }

  cancel(): void {
    if (this.settled) return;
    this.cancelled = true;
    this.event('cancelled');
    this.child?.kill('SIGTERM');
    setTimeout(() => this.child?.kill('SIGKILL'), 500).unref();
  }
}
