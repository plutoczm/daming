import { spawn } from 'node:child_process';

export interface RemoteCheckinTarget {
  readonly host: string;
  readonly user: string;
  readonly port?: number;
  readonly keyPath?: string;
  /** Directory on the Linux host holding daming-checkin.sh + checkin-daemon.mjs. */
  readonly remoteDir?: string;
}
export type RemoteCheckinAction = 'start' | 'stop' | 'status' | 'once';
export interface RemoteCheckinResult {
  readonly action: RemoteCheckinAction;
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(cmd: string, args: string[], timeoutMs = 20000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { err += d.toString('utf8'); });
    child.once('error', (e) => { if (done) return; done = true; clearTimeout(timer); resolve({ code: -1, stdout: out, stderr: String(e) }); });
    child.once('close', (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); });
  });
}

/**
 * Controls a PERSISTENT check-in daemon on a remote Linux host over SSH.
 * `start` launches it detached (setsid/nohup) so it survives the controller
 * session and the Windows main host being shut down; only `stop` stops it.
 * This controller never holds the process and holds no long-lived connection.
 */
export class RemoteCheckinController {
  private readonly t: { host: string; user: string; port: number; keyPath?: string; remoteDir: string };
  constructor(target: RemoteCheckinTarget) {
    if (!target || typeof target.host !== 'string' || !target.host || typeof target.user !== 'string' || !target.user) {
      throw new Error('remote_checkin_target_invalid');
    }
    this.t = {
      host: target.host, user: target.user, port: target.port ?? 22,
      ...(target.keyPath ? { keyPath: target.keyPath } : {}),
      remoteDir: target.remoteDir ?? '~/daming-checkin',
    };
  }
  private sshArgs(command: string): string[] {
    const a = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-p', String(this.t.port)];
    if (this.t.keyPath) a.push('-i', this.t.keyPath);
    a.push(this.t.user + '@' + this.t.host, command);
    return a;
  }
  private async action(action: RemoteCheckinAction): Promise<RemoteCheckinResult> {
    const script = this.t.remoteDir.replace(/\/+$/, '') + '/daming-checkin.sh';
    const quoted = "'" + script.replace(/'/g, "'\\''") + "'";
    const r = await run('ssh', this.sshArgs('bash ' + quoted + ' ' + action));
    return { action, code: r.code, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
  }
  start(): Promise<RemoteCheckinResult> { return this.action('start'); }
  stop(): Promise<RemoteCheckinResult> { return this.action('stop'); }
  status(): Promise<RemoteCheckinResult> { return this.action('status'); }
  once(): Promise<RemoteCheckinResult> { return this.action('once'); }
}
