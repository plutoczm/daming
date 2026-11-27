import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { statSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { isCodexModelConnection } from './codex-model-connection.ts';
import type { CodexModelConnection } from './codex-model-connection.ts';

export interface CodexExecOptions {
  readonly executable: string;
  readonly cwd: string;
  readonly prompt: string;
  /** Prefix for test doubles; production Codex CLI uses an empty prefix. */
  readonly commandArgs?: readonly string[];
  /** Explicit model for official Codex route; ignored when empty. */
  readonly model?: string;
  /** Ignore user config.toml so Magpie/Ollama overrides cannot hijack official auth. */
  readonly ignoreUserConfig?: boolean;
  /** Host-created, single-model/single-send capability. Never a caller URL. */
  readonly connection?: CodexModelConnection;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
  /** Sandbox policy for model-generated shell commands. Default 'read-only'. */
  readonly sandbox?: 'read-only' | 'workspace-write';
  /** Enable the shell tool (default false). Only meaningful with a write sandbox. */
  readonly enableShell?: boolean;
}

export interface CodexExecEventView {
  readonly type: string;
  readonly at: string;
  readonly itemType?: string;
  readonly text?: string;
  readonly status?: string;
  readonly error?: string;
}

export interface CodexExecResult {
  readonly status: 'completed' | 'failed' | 'timed_out' | 'cancelled';
  readonly exitCode: number | null;
  readonly output: string;
  readonly events: readonly CodexExecEventView[];
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
  if (!Number.isSafeInteger(result) || result < 1 || result > 16 * 1024 * 1024) throw new Error('Invalid Codex output limit');
  return result;
}

export class CodexExecRun {
  private readonly options: Required<Omit<CodexExecOptions, 'signal' | 'commandArgs' | 'model' | 'connection' | 'sandbox' | 'enableShell'>> & { signal?: AbortSignal; commandArgs: readonly string[]; model?: string; connection?: CodexModelConnection; sandbox: 'read-only' | 'workspace-write'; enableShell: boolean };
  private child?: ChildProcessWithoutNullStreams;
  private cancelled = false;
  private settled = false;
  private bytes = 0;
  private buffer = '';
  private stderr = '';
  private readonly events: CodexExecEventView[] = [];
  private readonly messages: string[] = [];
  private readonly usage: Record<string, number> = {};

  constructor(options: CodexExecOptions) {
    if (!options || typeof options !== 'object') throw new Error('Codex options are required');
    if (typeof options.executable !== 'string' || !isAbsolute(options.executable) || !statSync(options.executable).isFile()) throw new Error('Codex executable must be an absolute file');
    if (typeof options.cwd !== 'string' || !isAbsolute(options.cwd) || !statSync(options.cwd).isDirectory()) throw new Error('Codex cwd must be an absolute directory');
    if (typeof options.prompt !== 'string' || !options.prompt.trim() || Buffer.byteLength(options.prompt) > 60000) throw new Error('Codex prompt is invalid');
    if (options.connection !== undefined && (!isCodexModelConnection(options.connection) ||
        (options.model !== undefined && options.model !== options.connection.model))) throw new Error('Codex connection is invalid or conflicts with fixed model');
    this.options = {
      executable: options.executable, cwd: options.cwd, prompt: options.prompt,
      timeoutMs: limit(options.timeoutMs, 120000), maxOutputBytes: limit(options.maxOutputBytes, 1024 * 1024),
      signal: options.signal, commandArgs: options.commandArgs ?? [],
      ...(options.model ? { model: options.model } : {}), ignoreUserConfig: options.ignoreUserConfig ?? false,
      sandbox: options.sandbox ?? 'read-only', enableShell: options.enableShell ?? false,
      ...(options.connection ? { connection: options.connection } : {})
    };
  }

  private event(type: string, extra: Omit<CodexExecEventView, 'type' | 'at'> = {}): void {
    this.events.push({ type, at: new Date().toISOString(), ...extra });
  }

  private consume(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: Record<string, unknown>;
    try { parsed = record(JSON.parse(trimmed)); } catch { this.event('stream_error', { error: 'invalid_json_line' }); return; }
    const type = text(parsed.type) ?? 'unknown';
    if (type === 'item.completed') {
      const item = record(parsed.item);
      const itemType = text(item.type);
      const message = text(item.message);
      const body = text(item.text);
      if (itemType === 'agent_message' && body) this.messages.push(body);
      // Codex emits harmless warnings for legacy user config keys; keep the activity feed about the run itself.
      if (itemType === 'error' && message?.includes('unrecognized configuration settings')) return;
      this.event(type, { ...(itemType ? { itemType } : {}), ...(body ? { text: body } : {}), ...(message ? { error: message } : {}) });
      return;
    }
    if (type === 'turn.completed') {
      const usage = record(parsed.usage);
      for (const [key, value] of Object.entries(usage)) if (typeof value === 'number' && Number.isFinite(value)) this.usage[key] = value;
      this.event(type, { status: 'completed' });
      return;
    }
    if (type === 'turn.failed') {
      this.event(type, { status: 'failed', ...(text(parsed.error) ? { error: text(parsed.error) } : {}) });
      return;
    }
    this.event(type);
  }

  async run(): Promise<CodexExecResult> {
    if (this.child) throw new Error('Codex run already started');
    if (this.options.signal?.aborted) return { status: 'cancelled', exitCode: null, output: '', events: [], usage: undefined };
    const env: NodeJS.ProcessEnv = {};
    for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'PATH', 'CODEX_HOME']) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    const connection = this.options.connection;
    const signal = connection ? AbortSignal.any([...(this.options.signal ? [this.options.signal] : []), connection.signal]) : this.options.signal;
    const temporaryHome = connection ? mkdtempSync(join(tmpdir(), 'daming-codex-connection-')) : undefined;
    const cleanup = (): boolean => {
      try {
        if (temporaryHome) rmSync(temporaryHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        return true;
      } catch { return false; }
    };
    const providerArgs: string[] = [];
    try {
    if (connection && temporaryHome) {
      env.CODEX_HOME = temporaryHome;
      env.HOME = temporaryHome;
      env.USERPROFILE = temporaryHome;
      for (const name of ['APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) {
        env[name] = join(temporaryHome, name.toLowerCase());
        mkdirSync(env[name]!, { recursive: true });
      }
      env.DAMING_CODEX_RELAY_TOKEN = connection.token;
      const config = [
        'model_provider="daming"', 'model=' + JSON.stringify(connection.model),
        'model_providers.daming.name="Daming embedded Magpie"',
        'model_providers.daming.base_url=' + JSON.stringify(connection.baseUrl),
        'model_providers.daming.env_key="DAMING_CODEX_RELAY_TOKEN"',
        'model_providers.daming.wire_api="responses"',
        'model_providers.daming.requires_openai_auth=false',
        'model_providers.daming.request_max_retries=0',
        'model_providers.daming.stream_max_retries=0',
        'model_providers.daming.supports_websockets=false',
        'features.enable_request_compression=false', `features.shell_tool=${this.options.enableShell}`,
        'features.apps=false', 'features.multi_agent=false',
        'web_search="disabled"', 'approval_policy="never"', 'windows.sandbox="mxc"'
      ];
      providerArgs.push('--ignore-rules', ...config.flatMap(value => ['-c', value]));
    }
    this.child = spawn(this.options.executable, [
      ...this.options.commandArgs,
      'exec', '--json',
      ...(this.options.ignoreUserConfig || connection ? ['--ignore-user-config'] : []),
      ...providerArgs,
      ...(this.options.model ? ['-m', this.options.model] : []),
      '--skip-git-repo-check', '--ephemeral',
      '-s', this.options.sandbox, '-C', this.options.cwd, connection ? '-' : this.options.prompt
    ], { cwd: this.options.cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdin.on('error', () => undefined);
    this.child.stdin.end(connection ? this.options.prompt : undefined);
    } catch {
      cleanup();
      throw new Error('codex_connection_process_setup_failed');
    }
    const finish = (status: CodexExecResult['status'], exitCode: number | null, error?: string): CodexExecResult => {
      this.settled = true;
      return { status, exitCode, output: this.messages.join('\n'), events: [...this.events], usage: Object.keys(this.usage).length ? { ...this.usage } : undefined, ...(error ? { error } : {}) };
    };
    return await new Promise<CodexExecResult>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stopped: { status: CodexExecResult['status']; error?: string } | undefined;
      const done = (status: CodexExecResult['status'], exitCode: number | null, error?: string) => {
        if (this.settled) return;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.child?.removeAllListeners();
        if (!cleanup()) return resolve(finish('failed', exitCode, 'codex_temporary_config_cleanup_failed'));
        resolve(finish(status, exitCode, error));
      };
      const abort = () => {
        const transportFailed = connection?.signal.aborted && !this.options.signal?.aborted;
        this.cancelled = !transportFailed;
        stopped = transportFailed ? { status: 'failed', error: 'model_transport_failed_cash_unknown' } : { status: 'cancelled' };
        this.event(transportFailed ? 'model_transport_failed' : 'cancelled');
        this.child?.kill('SIGTERM');
        setTimeout(() => this.child?.kill('SIGKILL'), 500).unref();
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      timer = setTimeout(() => {
        this.event('timeout');
        stopped = { status: 'timed_out', error: 'timeout' };
        this.child?.kill('SIGTERM');
        setTimeout(() => this.child?.kill('SIGKILL'), 500).unref();
      }, this.options.timeoutMs);
      this.child!.stdout.on('data', (chunk: Buffer) => {
        if (this.settled) return;
        this.bytes += chunk.length;
        if (this.bytes > this.options.maxOutputBytes) { this.event('output_limit'); stopped = { status: 'failed', error: 'output_limit' }; this.child?.kill('SIGKILL'); return; }
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
        if (stopped) return done(stopped.status, code, stopped.error);
        if (this.cancelled) return done('cancelled', code);
        if (connection && (!this.events.some(e => e.type === 'turn.completed') ||
            this.events.some(e => e.type === 'turn.failed'))) return done('failed', code, 'missing_successful_turn_receipt');
        if (code === 0) return done('completed', code);
        done('failed', code, this.stderr.trim() || 'nonzero_exit');
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
