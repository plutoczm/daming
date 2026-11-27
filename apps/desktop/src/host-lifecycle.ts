import { isAbsolute } from 'node:path';

/**
 * A fully-formed, pre-validated process launch. Arguments are an array and `shell` is false, so
 * nothing from settings or the environment can be spliced into a command line.
 */
export interface HostSpawnPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly windowsHide: true;
  readonly shell: false;
}

/** Environment keys safe to hand to the managed Host child; everything else is dropped. */
const HOST_ENV_ALLOWLIST = [
  'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'HOMEDRIVE', 'HOMEPATH', 'PATH', 'PATHEXT', 'ComSpec', 'NODE_EXTRA_CA_CERTS',
] as const;

export interface BuildHostSpawnInput {
  readonly nodeExecutable: string;
  readonly hostEntry: string;
  readonly dataDir: string;
  readonly port: number;
  readonly webRoot: string;
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
  readonly extraEnv?: Readonly<Record<string, string>>;
}

function requireAbsolute(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value || !isAbsolute(value)) throw new Error(name + ' must be an absolute path');
  return value;
}

function validPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 65535;
}

/** Build the exact Host launch plan. The Host remains the only writer of task/approval/cost state. */
export function buildHostSpawnPlan(input: BuildHostSpawnInput): HostSpawnPlan {
  const nodeExecutable = requireAbsolute(input.nodeExecutable, 'nodeExecutable');
  const hostEntry = requireAbsolute(input.hostEntry, 'hostEntry');
  const dataDir = requireAbsolute(input.dataDir, 'dataDir');
  const webRoot = requireAbsolute(input.webRoot, 'webRoot');
  if (!validPort(input.port)) throw new Error('port must be an integer 0..65535');
  const source = input.sourceEnv ?? {};
  const env: Record<string, string> = {};
  for (const key of HOST_ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === 'string' && value) env[key] = value;
  }
  for (const [key, value] of Object.entries(input.extraEnv ?? {})) {
    if (typeof value === 'string') env[key] = value;
  }
  return {
    command: nodeExecutable,
    args: [hostEntry, '--data-dir', dataDir, '--port', String(input.port), '--web-root', webRoot],
    cwd: dataDir,
    env,
    windowsHide: true,
    shell: false,
  };
}

/** Ready handshake printed by the managed Host launcher, e.g. `DAMING_HOST_READY {"url":...}`. */
export const HOST_READY_PREFIX = 'DAMING_HOST_READY ';

export type HostOutputLine =
  | { readonly kind: 'ready'; readonly url: string }
  | { readonly kind: 'log'; readonly text: string };

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:') return false;
    const host = url.hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
  } catch { return false; }
}

/** Parse one stdout line from the Host child. Only a loopback http URL counts as ready. */
export function parseHostOutputLine(line: string): HostOutputLine {
  const text = line.replace(/\r?\n$/, '');
  if (text.startsWith(HOST_READY_PREFIX)) {
    const payload = text.slice(HOST_READY_PREFIX.length).trim();
    try {
      const value: unknown = JSON.parse(payload);
      if (value && typeof value === 'object' && typeof (value as Record<string, unknown>).url === 'string') {
        const url = (value as Record<string, unknown>).url as string;
        if (isLoopbackUrl(url)) return { kind: 'ready', url };
      }
    } catch { /* fall through to log */ }
    return { kind: 'log', text };
  }
  // Compatibility with web-host.mjs human-readable output.
  const signIn = /^(?:Sign-in URL|First-time bootstrap URL):\s*(\S+)/.exec(text);
  if (signIn && isLoopbackUrl(signIn[1])) return { kind: 'ready', url: signIn[1] };
  return { kind: 'log', text };
}

/**
 * Build the window URL. On first run we append a one-time bootstrap token; because the Host
 * ready URL already ends with "/", naive concatenation yields a "//" path the Host rejects.
 * URL() normalises it to exactly one slash.
 */
export function buildBootstrapUrl(baseUrl: string, token: string, initialized: boolean): string {
  if (initialized) return baseUrl;
  return new URL('/?token=' + encodeURIComponent(token), baseUrl).toString();
}

/** Cross-platform, argument-array process-tree kill for a managed child. */export function buildProcessTreeKill(pid: number, platform: string = process.platform): { readonly command: string; readonly args: readonly string[] } {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('pid must be a positive integer');
  if (platform === 'win32') return { command: 'taskkill', args: ['/pid', String(pid), '/T', '/F'] };
  return { command: 'kill', args: ['-TERM', String(pid)] };
}

export type HostState = 'idle' | 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed';

export interface HostSnapshot {
  readonly state: HostState;
  readonly url?: string;
  readonly pid?: number;
  readonly reason?: string;
}

export interface HostChild {
  readonly pid?: number;
  readonly stdout?: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null;
  readonly stderr?: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null;
  once(event: 'exit', cb: (code: number | null, signal: string | null) => void): void;
  once(event: 'error', cb: (error: Error) => void): void;
}

export interface SupervisorDeps {
  readonly spawn: (plan: HostSpawnPlan) => HostChild;
  readonly killTree: (pid: number) => void;
}

/**
 * Supervises exactly one managed Host child. Electron never writes task state itself; it only
 * starts, observes the ready handshake, and reaps the child (whole tree) on stop. A second
 * start while running is a no-op so ticks and window events cannot spawn duplicate Hosts.
 */
export class HostSupervisor {
  readonly #deps: SupervisorDeps;
  #state: HostState = 'idle';
  #url: string | undefined;
  #pid: number | undefined;
  #reason: string | undefined;
  #buffer = '';

  constructor(deps: SupervisorDeps) {
    this.#deps = deps;
  }

  snapshot(): HostSnapshot {
    return {
      state: this.#state,
      ...(this.#url ? { url: this.#url } : {}),
      ...(this.#pid !== undefined ? { pid: this.#pid } : {}),
      ...(this.#reason ? { reason: this.#reason } : {}),
    };
  }

  start(plan: HostSpawnPlan): HostSnapshot {
    if (this.#state === 'starting' || this.#state === 'ready') return this.snapshot();
    this.#state = 'starting';
    this.#url = undefined;
    this.#reason = undefined;
    this.#buffer = '';
    let child: HostChild;
    try {
      child = this.#deps.spawn(plan);
    } catch {
      this.#state = 'failed';
      this.#reason = 'spawn_error';
      return this.snapshot();
    }
    this.#pid = child.pid;
    child.stdout?.on('data', (chunk) => this.#onData(chunk));
    child.once('exit', (code, signal) => {
      if (this.#state === 'stopping' || this.#state === 'stopped') {
        this.#state = 'stopped';
        return;
      }
      this.#state = 'failed';
      this.#reason = 'host_exited_' + (code ?? signal ?? 'unknown');
    });
    child.once('error', () => {
      this.#state = 'failed';
      this.#reason = 'spawn_error';
    });
    return this.snapshot();
  }

  #onData(chunk: Buffer | string): void {
    this.#buffer += chunk.toString();
    const lines = this.#buffer.split('\n');
    this.#buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line) continue;
      const parsed = parseHostOutputLine(line);
      if (parsed.kind === 'ready') {
        this.#url = parsed.url;
        this.#state = 'ready';
      }
    }
  }

  stop(): HostSnapshot {
    if (this.#state === 'idle' || this.#state === 'stopped') {
      this.#state = 'stopped';
      return this.snapshot();
    }
    const pid = this.#pid;
    this.#state = 'stopping';
    if (pid !== undefined) {
      try { this.#deps.killTree(pid); } catch { /* already gone */ }
    }
    this.#state = 'stopped';
    return this.snapshot();
  }
}
