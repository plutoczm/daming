import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';

export class TenantDockerSandboxError extends Error {
  readonly reason: string;
  constructor(reason: string) { super(reason); this.reason = reason; }
}
export type TenantDockerSandboxEvidence = {
  runtime: 'docker-desktop-linux'; agent: 'offline-fixed-agent';
  containerIsolated: true; networkBlocked: true; rootReadonly: true;
  windowsDrivesHidden: true; hostSecretsHidden: true; unprivileged: true;
  tempWritable: true; credentialsInjected: false; externalToolsEnabled: false;
  modelCallsEnabled: false; paidDispatchPermitted: false;
  inspectedCharacters: number; inspectedUtf8Bytes: number; lineCount: number;
};

// Never interpolate task content into Docker options, container commands, or
// image names. Host secrets are NOT passed into the container.
const WORKER = [
  'import json,os,socket,sys',
  'raw=sys.stdin.buffer.read(8193)',
  'if len(raw)>8192: sys.exit(11)',
  'v=json.loads(raw.decode("utf8"))',
  'if not isinstance(v,dict) or set(v)!={"version","text"} or v["version"]!=1 or not isinstance(v["text"],str): sys.exit(12)',
  's=v["text"]',
  'if len(s)>2048 or len(s.encode("utf8"))>8192: sys.exit(13)',
  'net=socket.socket(socket.AF_INET,socket.SOCK_STREAM)',
  'net.settimeout(0.4)',
  'try: networkBlocked=net.connect_ex(("1.1.1.1",443))!=0',
  'except OSError: networkBlocked=True',
  'finally: net.close()',
  'rootReadonly=False',
  'try:',
  ' open("/etc/daming-sandbox-write-probe","x").close()',
  'except OSError: rootReadonly=True',
  'else: os.unlink("/etc/daming-sandbox-write-probe")',
  'tempWritable=False',
  'try:',
  ' with open("/tmp/daming-private-probe","x") as f: f.write("ok")',
  ' os.unlink("/tmp/daming-private-probe")',
  ' tempWritable=True',
  'except OSError: pass',
  'noHost=not any(os.path.exists(p) for p in ("/mnt/c/Windows","/mnt/d/Projects","/host","/workspace","/var/run/docker.sock","/run/docker.sock"))',
  'noSecrets=not any(os.path.exists(p) for p in ("/root/.codex","/root/.claude","/root/.aws","/root/.ssh","/home/oai","/host-secrets"))',
  'noSecrets=noSecrets and not any(("API_KEY" in k or "SECRET" in k or "TOKEN" in k or "PASSWORD" in k) for k in os.environ)',
  'print(json.dumps({"networkBlocked":networkBlocked,"rootReadonly":rootReadonly,"tempWritable":tempWritable,"windowsDrivesHidden":noHost,"hostSecretsHidden":noSecrets,"unprivileged":os.geteuid()==65534 and os.getegid()==65534,"inspectedCharacters":len(s),"inspectedUtf8Bytes":len(s.encode("utf8")),"lineCount":len(s.splitlines())},separators=(",",":")))',
].join('\n');

// No network, host mounts, Docker socket, image pulls or ambient privileges.
// Fixed local Docker Desktop Linux named pipe: never trust DOCKER_HOST or
// caller-controlled contexts. No untrusted agent executable is launched.
export const LOCAL_DOCKER_PIPE = 'npipe:////./pipe/dockerDesktopLinuxEngine';
const IMAGE = 'python:3.12-slim';
export const DOCKER_AGENT_ISOLATION_ARGS: readonly string[] = Object.freeze([
  '--host', LOCAL_DOCKER_PIPE,
  'run', '--rm', '--pull=never', '--interactive',
  '--network=none', '--read-only', '--cap-drop=ALL',
  '--security-opt=no-new-privileges:true',
  // Docker's default PID namespace is private; --pid=private is invalid.
  '--ipc=private', '--cgroupns=private',
  '--pids-limit=32', '--memory=128m', '--memory-swap=128m', '--cpus=0.5',
  '--user=65534:65534', '--tmpfs=/tmp:rw,nosuid,nodev,size=16m,mode=1777',
  '--workdir=/tmp',
]);

const TRUE_FIELDS = ['networkBlocked','rootReadonly','tempWritable',
  'windowsDrivesHidden','hostSecretsHidden','unprivileged'] as const;

export function dockerBinary(): string {
  if (process.platform !== 'win32') throw new TenantDockerSandboxError('docker_windows_host_required');
  const path = 'D:\\Docker\\resources\\bin\\docker.exe';
  if (!existsSync(path)) throw new TenantDockerSandboxError('docker_local_cli_missing');
  return path;
}

/** Fixed-code, offline Agent execution boundary verification.
 * This is deliberately NOT an authorized paid Agent or Magpie adapter.
 */
export async function probeTenantDockerAgent(
  text: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<TenantDockerSandboxEvidence> {
  if (typeof text !== 'string' || text.length > 2048 || Buffer.byteLength(text, 'utf8') > 8192)
    throw new TenantDockerSandboxError('docker_agent_input_invalid');
  const timeoutMs = options.timeoutMs ?? 15000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000)
    throw new TenantDockerSandboxError('docker_agent_timeout_invalid');
  if (options.signal?.aborted) throw new TenantDockerSandboxError('docker_agent_aborted');
  const executable = dockerBinary();
  const name = 'daming-probe-' + randomUUID();
  const args = [...DOCKER_AGENT_ISOLATION_ARGS, '--name=' + name,
    '--entrypoint=/usr/local/bin/python3', IMAGE, '-I', '-c', WORKER];
  const input = JSON.stringify({ version: 1, text });
  return await new Promise<TenantDockerSandboxEvidence>((resolve, reject) => {
    // PATH is needed by Docker Desktop helpers; no Docker credentials are
    // forwarded into containers. Explicit --host overrides DOCKER_HOST.
    const child = spawn(executable, args, {
      shell: false, windowsHide: true, stdio: ['pipe','pipe','pipe'],
      ...(options.signal ? { signal: options.signal } : {})
    });
    let done = false;
    let stdout = Buffer.alloc(0), stderrBytes = 0;
    const cleanup = () => {
      // In case docker.exe is killed after the daemon starts the container,
      // terminate only this unique probe container (never other workloads).
      const reaper = spawn(executable, ['--host', LOCAL_DOCKER_PIPE,
        'rm','--force',name], { shell: false, windowsHide: true,
        stdio: 'ignore' });
      reaper.once('error', () => {});
      reaper.unref();
    };
    const finish = (error?: Error, result?: TenantDockerSandboxEvidence) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result!);
    };
    const timer = setTimeout(() => {
      child.kill();
      cleanup();
      finish(new TenantDockerSandboxError('docker_agent_timeout'));
    }, timeoutMs);
    child.stdout.on('data', (buf: Buffer) => {
      if (done) return;
      if (stdout.length + buf.length > 3072) {
        child.kill(); cleanup();
        finish(new TenantDockerSandboxError('docker_agent_output_overflow'));
      } else stdout = Buffer.concat([stdout, buf]);
    });
    child.stderr.on('data', (buf: Buffer) => {
      stderrBytes += buf.length;
      if (stderrBytes > 16384 && !done) {
        child.kill(); cleanup();
        finish(new TenantDockerSandboxError('docker_agent_stderr_overflow'));
      }
    });
    child.once('error', () => {
      cleanup();
      finish(new TenantDockerSandboxError('docker_agent_launch_failed'));
    });
    child.once('close', code => {
      if (done) return;
      if (code !== 0) return finish(new TenantDockerSandboxError('docker_agent_worker_failed'));
      try {
        const value: unknown = JSON.parse(stdout.toString('utf8').trim());
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not_object');
        const v = value as Record<string, unknown>;
        if (TRUE_FIELDS.some(key => v[key] !== true) ||
            v.inspectedCharacters !== Array.from(text).length ||
            v.inspectedUtf8Bytes !== Buffer.byteLength(text, 'utf8') ||
            !Number.isSafeInteger(v.lineCount) || Number(v.lineCount) < 0)
          throw new Error('boundary');
        finish(undefined, {
          runtime: 'docker-desktop-linux', agent: 'offline-fixed-agent',
          containerIsolated: true,
          networkBlocked: true, rootReadonly: true, tempWritable: true,
          windowsDrivesHidden: true, hostSecretsHidden: true,
          unprivileged: true, credentialsInjected: false,
          externalToolsEnabled: false, modelCallsEnabled: false,
          paidDispatchPermitted: false,
          inspectedCharacters: Number(v.inspectedCharacters),
          inspectedUtf8Bytes: Number(v.inspectedUtf8Bytes),
          lineCount: Number(v.lineCount)
        });
      } catch {
        finish(new TenantDockerSandboxError('docker_agent_boundary_not_verified'));
      }
    });
    child.stdin.once('error', () => {});
    child.stdin.end(input);
  });
}
