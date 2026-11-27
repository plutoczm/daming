import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export class WindowsAclError extends Error {}

export function currentWindowsSid(): string {
  if (process.platform !== 'win32') return 'non_windows';
  return currentSid();
}

function currentSid(): string {
  const r = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8', windowsHide: true, timeout: 10000
  });
  const sid = /S-\d+(?:-\d+){4,}/.exec(r.stdout ?? '')?.[0];
  if (r.status !== 0 || !sid) throw new WindowsAclError('windows_identity_unavailable');
  return sid;
}

function restrictOne(path: string, sid: string, isDirectory: boolean): void {
  const inheritedRights = isDirectory ? ':(OI)(CI)F' : ':F';
  const args = [
    path, '/inheritance:r', '/grant:r',
    '*' + sid + inheritedRights,
    '*S-1-5-18' + inheritedRights,    // LOCAL SYSTEM
    '*S-1-5-32-544' + inheritedRights // Administrators
  ];
  const r = spawnSync('icacls.exe', args, {
    encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 4096
  });
  if (r.status !== 0 || r.error) throw new WindowsAclError('windows_private_acl_failed');
}

/** Only call before placing sensitive files into a freshly created empty directory. */
export function secureNewWindowsDirectory(path: string): void {
  if (process.platform !== 'win32') return;
  restrictOne(path, currentSid(), true);
}

/** Limit old backups as well, without following Bun junctions to arbitrary folders. */
export function secureWindowsTree(path: string): void {
  if (process.platform !== 'win32') return;
  const sid = currentSid();
  const visit = (node: string) => {
    const stat = lstatSync(node);
    if (stat.isSymbolicLink()) return;
    const isDirectory = stat.isDirectory();
    restrictOne(node, sid, isDirectory);
    if (isDirectory) for (const child of readdirSync(node)) visit(join(node, child));
  };
  visit(path);
}
