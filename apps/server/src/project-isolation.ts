import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Diagnostics ONLY. Proves an offline Linux namespace can hide Windows files and
 * disable networking; this is NOT a credentialed Codex/DSH execution adapter.
 */
export interface OfflineIsolationProbe {
  readonly available: boolean;
  readonly runtime: 'wsl2-bubblewrap';
  readonly distro: 'Ubuntu-24.04';
  readonly windowsDrivesHidden: boolean;
  readonly userHomeHidden: boolean;
  readonly hostConfigHidden: boolean;
  readonly networkBlocked: boolean;
  readonly unprivileged: boolean;
  readonly reason: string;
}

const PYTHON_PROOF = [
  'import json,os,socket',
  's=socket.socket(socket.AF_INET,socket.SOCK_STREAM)',
  's.settimeout(0.8)',
  'n=s.connect_ex(("1.1.1.1",443))',
  's.close()',
  'print(json.dumps({"windowsDrivesHidden":not os.path.exists("/mnt/c/Windows") and not os.path.exists("/mnt/d/Projects"),"userHomeHidden":not os.path.exists("/home/jeremy") and not os.path.exists("/home"),"hostConfigHidden":not os.path.exists("/etc/passwd"),"networkBlocked":n!=0,"unprivileged":os.geteuid()!=0}))'
].join(';');

export const WSL_BWRAP_ARGS: readonly string[] = Object.freeze([
  '-d', 'Ubuntu-24.04', '--',
  '/usr/bin/bwrap',
  '--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts',
  '--unshare-cgroup', '--die-with-parent', '--new-session',
  '--ro-bind', '/usr', '/usr',
  '--ro-bind', '/lib', '/lib',
  '--ro-bind', '/lib64', '/lib64',
  '--ro-bind', '/bin', '/bin',
  '--proc', '/proc', '--dev', '/dev',
  '--tmpfs', '/tmp', '--chdir', '/tmp',
  '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin',
  '/usr/bin/python3', '-c', PYTHON_PROOF
]);

function denied(reason: string): OfflineIsolationProbe {
  return {
    available: false, runtime: 'wsl2-bubblewrap', distro: 'Ubuntu-24.04',
    windowsDrivesHidden: false, userHomeHidden: false, hostConfigHidden: false,
    networkBlocked: false, unprivileged: false, reason
  };
}

export async function probeOfflineWslIsolation(timeoutMs = 12000): Promise<OfflineIsolationProbe> {
  if (process.platform !== 'win32') return denied('requires_windows');
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) return denied('windows_system_root_missing');
  const executable = join(systemRoot, 'System32', 'wsl.exe');
  if (!existsSync(executable)) return denied('wsl_not_installed');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) {
    throw new Error('isolation_probe_timeout_invalid');
  }

  return await new Promise<OfflineIsolationProbe>((finish) => {
    let settled = false;
    let stdout = '';
    const child = spawn(executable, [...WSL_BWRAP_ARGS], {
      windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore']
    });
    const done = (value: OfflineIsolationProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      done(denied('namespace_probe_timeout'));
    }, timeoutMs);
    child.stdout.on('data', (buffer: Buffer) => {
      if (stdout.length < 4096) stdout += buffer.toString('utf8').slice(0, 4096 - stdout.length);
    });
    child.once('error', () => done(denied('wsl_launch_failed')));
    child.once('close', (code) => {
      if (code !== 0) { done(denied('namespace_probe_failed')); return; }
      try {
        const data: unknown = JSON.parse(stdout.trim());
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid');
        const value = data as Record<string, unknown>;
        const flags = ['windowsDrivesHidden', 'userHomeHidden', 'hostConfigHidden', 'networkBlocked', 'unprivileged'] as const;
        if (flags.some((name) => typeof value[name] !== 'boolean')) throw new Error('missing_boolean');
        const available = flags.every((name) => value[name] === true);
        done({
          available, runtime: 'wsl2-bubblewrap', distro: 'Ubuntu-24.04',
          windowsDrivesHidden: value.windowsDrivesHidden as boolean,
          userHomeHidden: value.userHomeHidden as boolean,
          hostConfigHidden: value.hostConfigHidden as boolean,
          networkBlocked: value.networkBlocked as boolean,
          unprivileged: value.unprivileged as boolean,
          reason: available ? 'offline_namespace_verified' : 'namespace_boundary_not_verified'
        });
      } catch {
        done(denied('namespace_probe_invalid_response'));
      }
    });
  });
}

/**
 * Production model CLI executors are Windows processes today. An offline WSL
 * namespace probe is not proof that these Windows processes run inside it.
 * Fail closed until model processes have a dedicated sandboxed launcher and
 * mediated, billable API access.
 */
export function projectLiveIsolationGate(): { ready: false; reason: 'isolated_model_cli_not_integrated' } {
  return { ready: false, reason: 'isolated_model_cli_not_integrated' };
}
