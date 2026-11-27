import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type IsolatedTenantProbe = {
  readonly runtime: 'wsl2-bubblewrap';
  readonly agent: 'offline-inspector';
  readonly tenantScoped: true;
  readonly networkBlocked: true;
  readonly windowsDrivesHidden: true;
  readonly homeHidden: true;
  readonly hostConfigHidden: true;
  readonly unprivileged: true;
  readonly ephemeralFilesystem: true;
  readonly allowedExternalTools: false;
  readonly modelCallsEnabled: false;
  readonly verified: true;
  readonly inspectedCharacters: number;
  readonly inspectedUtf8Bytes: number;
  readonly lineCount: number;
};

export class TenantSandboxError extends Error {
  readonly reason: string;
  constructor(reason: string) { super(reason); this.reason = reason; }
}

// Fixed code only; user-controlled task text MUST NEVER be converted into shell
// input, Python source, process arguments or filesystem paths.
const PYTHON_WORKER = [
  'import json,os,socket,sys',
  'raw=sys.stdin.buffer.read(8193)',
  'if len(raw)>8192: sys.exit(13)',
  'data=json.loads(raw.decode("utf8"))',
  'if not isinstance(data,dict) or set(data)!={"formatVersion","task","text"}: sys.exit(14)',
  'if data["formatVersion"]!=1 or data["task"]!="offline-inspect" or not isinstance(data["text"],str): sys.exit(15)',
  'value=data["text"]',
  'if len(value)>2048 or len(value.encode("utf8"))>8192: sys.exit(16)',
  's=socket.socket(socket.AF_INET,socket.SOCK_STREAM)',
  's.settimeout(0.5)',
  'network_blocked=(s.connect_ex(("1.1.1.1",443))!=0)',
  's.close()',
  'result={"windowsDrivesHidden":not os.path.exists("/mnt/c/Windows") and not os.path.exists("/mnt/d/Projects"),"homeHidden":not os.path.exists("/home"),"hostConfigHidden":not os.path.exists("/etc/passwd"),"networkBlocked":network_blocked,"unprivileged":os.geteuid()!=0,"ephemeralFilesystem":os.path.isdir("/tmp") and os.listdir("/tmp")==[],"inspectedCharacters":len(value),"inspectedUtf8Bytes":len(value.encode("utf8")),"lineCount":len(value.splitlines())}',
  'print(json.dumps(result,separators=(",",":")))' 
].join('\n');

export const TENANT_BWRAP_PREFIX: readonly string[] = Object.freeze([
  '-d', 'Ubuntu-24.04', '--',
  '/usr/bin/bwrap', '--unshare-user', '--unshare-pid', '--unshare-net',
  '--unshare-ipc', '--unshare-uts', '--unshare-cgroup',
  '--die-with-parent', '--new-session',
  '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib',
  '--ro-bind', '/lib64', '/lib64', '--ro-bind', '/bin', '/bin',
  '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
  '--chdir', '/tmp', '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin',
  '/usr/bin/python3', '-I', '-c', PYTHON_WORKER
]);

type Result = Omit<IsolatedTenantProbe,
  'runtime' | 'agent' | 'tenantScoped' | 'allowedExternalTools' |
  'modelCallsEnabled' | 'verified'>;
const BOOLS = ['networkBlocked','windowsDrivesHidden','homeHidden',
  'hostConfigHidden','unprivileged','ephemeralFilesystem'] as const;

/** Each call is a fresh, ephemeral Linux process. Only JSON enters via stdin.
 * There are no mounts of tenant data, model secrets or Windows directories.
 * In particular this does NOT run Codex/DSH/Magpie or infer tokens.
 */
export async function runIsolatedTenantInspect(
  text: string, options: { timeoutMs?: number; maxOutputBytes?: number; signal?: AbortSignal } = {}
): Promise<IsolatedTenantProbe> {
  if (typeof text !== 'string' || text.length > 2048 ||
      Buffer.byteLength(text, 'utf8') > 8192) {
    throw new TenantSandboxError('tenant_sandbox_input_invalid');
  }
  const timeoutMs = options.timeoutMs ?? 12000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) {
    throw new TenantSandboxError('tenant_sandbox_timeout_invalid');
  }
  const maxOutputBytes = options.maxOutputBytes ?? 3072;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 128 ||
      maxOutputBytes > 8192) throw new TenantSandboxError('tenant_sandbox_output_limit_invalid');
  if (options.signal?.aborted) throw new TenantSandboxError('tenant_sandbox_aborted');
  if (process.platform !== 'win32' || !process.env.SystemRoot) {
    throw new TenantSandboxError('tenant_sandbox_requires_windows_wsl2');
  }
  const executable = join(process.env.SystemRoot, 'System32', 'wsl.exe');
  if (!existsSync(executable)) throw new TenantSandboxError('tenant_sandbox_wsl_unavailable');
  const request = JSON.stringify({ formatVersion: 1, task: 'offline-inspect', text });
  return await new Promise<IsolatedTenantProbe>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {};
    for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH']) {
      if (process.env[name]) env[name] = process.env[name];
    }
    const child = spawn(executable, [...TENANT_BWRAP_PREFIX], {
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env,
      ...(options.signal ? { signal: options.signal } : {})
    });
    let done = false;
    let bytes = 0;
    const output: Buffer[] = [];
    const settle = (error?: Error, value?: IsolatedTenantProbe) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(() => {
      child.kill();
      settle(new TenantSandboxError('tenant_sandbox_timeout'));
    }, timeoutMs);
    child.stdout.on('data', (block: Buffer) => {
      bytes += block.length;
      if (bytes > maxOutputBytes) {
        child.kill();
        settle(new TenantSandboxError('tenant_sandbox_output_overflow'));
      } else output.push(block);
    });
    child.once('error', () => settle(new TenantSandboxError('tenant_sandbox_launch_failed')));
    child.once('close', (exitCode) => {
      if (done) return;
      if (exitCode !== 0) return settle(new TenantSandboxError('tenant_sandbox_worker_failed'));
      try {
        const raw: unknown = JSON.parse(Buffer.concat(output).toString('utf8').trim());
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new Error('invalid');
        }
        const v = raw as Record<string, unknown>;
        if (BOOLS.some(name => v[name] !== true) ||
            !Number.isSafeInteger(v.inspectedCharacters) ||
            v.inspectedCharacters !== Array.from(text).length ||
            !Number.isSafeInteger(v.inspectedUtf8Bytes) ||
            v.inspectedUtf8Bytes !== Buffer.byteLength(text, 'utf8') ||
            !Number.isSafeInteger(v.lineCount) || Number(v.lineCount) < 0) {
          throw new Error('boundary_denied');
        }
        settle(undefined, {
          runtime: 'wsl2-bubblewrap', agent: 'offline-inspector',
          tenantScoped: true, allowedExternalTools: false,
          modelCallsEnabled: false, verified: true,
          networkBlocked: true, windowsDrivesHidden: true, homeHidden: true,
          hostConfigHidden: true, unprivileged: true, ephemeralFilesystem: true,
          inspectedCharacters: Number(v.inspectedCharacters),
          inspectedUtf8Bytes: Number(v.inspectedUtf8Bytes),
          lineCount: Number(v.lineCount)
        });
      } catch {
        settle(new TenantSandboxError('tenant_sandbox_boundary_not_verified'));
      }
    });
    child.stdin.on('error', () => { /* process exit handled above */ });
    child.stdin.end(request);
  });
}
