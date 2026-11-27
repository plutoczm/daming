import {
  closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync,
  readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync,
  unlinkSync, writeFileSync, utimesSync
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { protectWindowsSecret, unprotectWindowsSecret } from './windows-secret.ts';
import { secureNewWindowsDirectory, secureWindowsTree } from './windows-private-acl.ts';
import { chooseMagpieProfile, selectMagpieProfile } from './magpie-profile.ts';

export class MagpieDataMigrationError extends Error {}
type DiskMeta = { version: 2; instanceId: string; port: number; adminPort: number; dataDir: string; adminKey?: string; adminKeyDpapi?: string; [key: string]: unknown };
type Entry = { path: string; size: number };
type LinkEntry = { path: string; target: string };
export interface MagpieDataMigrationReport {
  readonly destination: string;
  readonly sourceRetained: string;
  readonly instanceId: string;
  readonly port: number;
  readonly adminPort: number;
  readonly filesVerified: number;
  readonly bytesVerified: number;
  readonly linksRecreated: number;
  readonly pathsRewritten: number;
  readonly keyDpapiProtected: boolean;
  readonly sourceAclRestricted: boolean;
  readonly oldPluginCount: number;
  readonly newPluginCount: number;
  readonly verifiedAt: string;
}

function inside(root: string, candidate: string): boolean {
  const base = resolve(root).toLowerCase();
  const full = resolve(candidate).toLowerCase();
  return full === base || full.startsWith(base + sep);
}
function readInstance(path: string): DiskMeta {
  let m: unknown;
  try { m = JSON.parse(readFileSync(join(path, 'instance.json'), 'utf8')); }
  catch { throw new MagpieDataMigrationError('magpie_instance_metadata_missing'); }
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new MagpieDataMigrationError('magpie_instance_metadata_invalid');
  const info = m as Record<string, unknown>;
  if (info.version !== 2 || typeof info.instanceId !== 'string' || !/^[0-9a-f]{32}$/.test(info.instanceId) ||
    typeof info.dataDir !== 'string' || resolve(info.dataDir).toLowerCase() !== resolve(path).toLowerCase() ||
    typeof info.port !== 'number' || !Number.isSafeInteger(info.port) || info.port < 1024 || info.port > 65535 ||
    typeof info.adminPort !== 'number' || !Number.isSafeInteger(info.adminPort) || info.adminPort < 1024 || info.adminPort > 65535 ||
    info.port === info.adminPort || (typeof info.adminKey !== 'string' && typeof info.adminKeyDpapi !== 'string')) {
    throw new MagpieDataMigrationError('magpie_instance_metadata_invalid');
  }
  return info as DiskMeta;
}

async function occupied(port: number): Promise<boolean> {
  return await new Promise<boolean>((done) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(750);
    socket.once('connect', () => { socket.destroy(); done(true); });
    socket.once('timeout', () => { socket.destroy(); done(true); });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      done(error.code !== 'ECONNREFUSED');
    });
  });
}

function inventory(source: string): { files: Entry[]; links: LinkEntry[]; directories: string[] } {
  const files: Entry[] = [];
  const links: LinkEntry[] = [];
  const directories: string[] = [];
  function visit(rel: string): void {
    for (const entry of readdirSync(join(source, rel), { withFileTypes: true })) {
      const child = join(rel, entry.name);
      const full = join(source, child);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        const target = realpathSync(full);
        if (!inside(source, target) || !lstatSync(target).isDirectory()) {
          throw new MagpieDataMigrationError('magpie_external_reparse_point');
        }
        links.push({ path: child, target: relative(source, target) });
      } else if (stat.isDirectory()) { directories.push(child); visit(child); }
      else if (stat.isFile()) files.push({ path: child, size: stat.size });
      else throw new MagpieDataMigrationError('magpie_unexpected_filesystem_entry');
    }
  }
  visit('');
  return { files, links, directories };
}

function bytesEqual(left: string, right: string): boolean {
  const a = openSync(left, 'r');
  const b = openSync(right, 'r');
  try {
    if (statSync(left).size !== statSync(right).size) return false;
    const x = Buffer.allocUnsafe(64 * 1024);
    const y = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const n = readSync(a, x, 0, x.length, null);
      if (n === 0) return true;
      if (readSync(b, y, 0, n, null) !== n || !x.subarray(0, n).equals(y.subarray(0, n))) return false;
    }
  } finally { closeSync(a); closeSync(b); }
}

function cloneFiles(source: string, stage: string, files: Entry[]): number {
  let total = 0;
  for (const entry of files) {
    const src = join(source, entry.path);
    const dst = join(stage, entry.path);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    if (!bytesEqual(src, dst) || statSync(dst).size !== entry.size) {
      throw new MagpieDataMigrationError('magpie_copy_verification_failed');
    }
    const meta = statSync(src);
    utimesSync(dst, meta.atime, meta.mtime);
    total += entry.size;
  }
  return total;
}

function rewritePaths(stage: string, source: string, destination: string, files: Entry[]): number {
  let count = 0;
  const root = source.toLowerCase();
  for (const entry of files) {
    if (!entry.path.toLowerCase().endsWith('.json')) continue;
    if (entry.path.startsWith('pre-plugin-ops-') || entry.path.toLowerCase().endsWith('instance.v1.backup.json')) continue;
    const file = join(stage, entry.path);
    if (statSync(file).size > 2 * 1024 * 1024) continue;
    const raw = readFileSync(file, 'utf8');
    if (!raw.toLowerCase().includes(root) && !raw.toLowerCase().includes(source.replaceAll('\\','\\\\').toLowerCase())) continue;
    let data: unknown;
    try { data = JSON.parse(raw); } catch { throw new MagpieDataMigrationError('magpie_path_json_invalid'); }
    const replace = (value: unknown): unknown => {
      if (typeof value === 'string') {
        if (value.toLowerCase() === root || value.toLowerCase().startsWith(root + sep.toLowerCase())) {
          count++;
          return destination + value.slice(source.length);
        }
        // An embedded absolute path may be a vendor-specific format: fail closed.
        if (value.toLowerCase().includes(root)) throw new MagpieDataMigrationError('magpie_unrecognized_embedded_path');
      }
      if (Array.isArray(value)) return value.map(replace);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v)]));
      return value;
    };
    const mapped = replace(data);
    writeFileSync(file, JSON.stringify(mapped, null, 2) + '\n', { flag: 'w' });
  }
  return count;
}

function pluginCount(dir: string): number {
  const file = join(dir, 'config', 'magpie', 'plugins.json');
  if (!existsSync(file)) return 0;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as { plugins?: unknown };
    return Array.isArray(value.plugins) ? value.plugins.length : 0;
  } catch { throw new MagpieDataMigrationError('magpie_plugins_json_invalid'); }
}

/**
 * Non-destructive cross-volume migration. The existing instance remains untouched
 * and selected until the new backend has passed a read-only health check.
 * No hashes: file verification compares the exact bytes in 64 KiB chunks.
 */
export async function migrateMagpieData(options: {
  readonly hostBase: string;
  readonly sourceDir: string;
  readonly destinationDir: string;
  readonly checkPort?: (port: number) => Promise<boolean>;
  readonly verifyBackend: (dir: string) => Promise<void>;
  readonly restrictOldTree?: boolean;
}): Promise<MagpieDataMigrationReport> {
  const hostBase = resolve(options.hostBase);
  const source = realpathSync(resolve(options.sourceDir));
  const destination = resolve(options.destinationDir);
  if (source.toLowerCase() === destination.toLowerCase() ||
      inside(source, destination) || inside(destination, source) ||
      !isAbsolute(options.destinationDir)) throw new MagpieDataMigrationError('magpie_destination_invalid');
  if (existsSync(destination)) throw new MagpieDataMigrationError('magpie_destination_exists');
  if (existsSync(join(hostBase, '.daming-host-owner.lock'))) throw new MagpieDataMigrationError('daming_host_must_be_stopped');
  const chosen = chooseMagpieProfile(hostBase, { });
  const meta = readInstance(source);
  if (chosen.profile !== 'selected' || chosen.dataDir.toLowerCase() !== source.toLowerCase() ||
      chosen.instanceId !== meta.instanceId) throw new MagpieDataMigrationError('magpie_source_not_selected');
  const isBusy = options.checkPort ?? occupied;
  if (await isBusy(meta.port) || await isBusy(meta.adminPort)) throw new MagpieDataMigrationError('magpie_ports_in_use');
  if (process.platform === 'win32' && !inside(process.env.LOCALAPPDATA ?? hostBase, destination)) {
    throw new MagpieDataMigrationError('magpie_destination_not_local_appdata');
  }
  const hostDir = join(hostBase, 'host');
  mkdirSync(hostDir, { recursive: true });
  const lock = join(hostDir, 'magpie-data-migration.lock');
  let fd: number;
  try { fd = openSync(lock, 'wx', 0o600); }
  catch { throw new MagpieDataMigrationError('magpie_migration_already_running'); }
  let stage: string | undefined;
  let committed = false;
  try {
    const { files, links, directories } = inventory(source);
    const originalCount = pluginCount(source);
    stage = destination + '.stage-' + randomBytes(6).toString('hex');
    mkdirSync(stage, { recursive: false });
    secureNewWindowsDirectory(stage);
    for (const rel of directories) mkdirSync(join(stage, rel), { recursive: true });
    const verifiedBytes = cloneFiles(source, stage, files);
    // Ensure the original did not change during copy.
    for (const entry of files) {
      if (!bytesEqual(join(source, entry.path), join(stage, entry.path))) throw new MagpieDataMigrationError('magpie_source_changed_during_copy');
    }
    let rewritten = rewritePaths(stage, source, destination, files);
    const moved = readInstance(source);
    if (moved.instanceId !== meta.instanceId || moved.port !== meta.port || moved.adminPort !== meta.adminPort) {
      throw new MagpieDataMigrationError('magpie_source_identity_changed');
    }
    const next: Record<string, unknown> = { ...meta, dataDir: destination };
    if (process.platform === 'win32') {
      if (typeof meta.adminKey === 'string') {
        next.adminKeyDpapi = protectWindowsSecret(meta.adminKey);
      } else {
        unprotectWindowsSecret(meta.adminKeyDpapi!);
      }
      delete next.adminKey;
    }
    writeFileSync(join(stage, 'instance.json'), JSON.stringify(next, null, 2) + '\n');
    rewritten++;
    if (originalCount !== pluginCount(stage)) throw new MagpieDataMigrationError('magpie_plugins_changed_during_copy');
    if (await isBusy(meta.port) || await isBusy(meta.adminPort)) throw new MagpieDataMigrationError('magpie_ports_became_busy');
    renameSync(stage, destination);
    stage = undefined;
    for (const link of links) {
      const target = join(destination, link.target);
      if (!existsSync(target)) throw new MagpieDataMigrationError('magpie_junction_target_missing');
      mkdirSync(dirname(join(destination, link.path)), { recursive: true });
      symlinkSync(target, join(destination, link.path), 'junction');
    }
    if (pluginCount(destination) !== originalCount) throw new MagpieDataMigrationError('magpie_plugins_mismatch_after_commit');
    await options.verifyBackend(destination);
    // Recheck user selection immediately before switching.
    const active = chooseMagpieProfile(hostBase, {});
    if (active.dataDir.toLowerCase() !== source.toLowerCase() || active.instanceId !== meta.instanceId) {
      throw new MagpieDataMigrationError('magpie_selection_changed_during_migration');
    }
    selectMagpieProfile(hostBase, destination);
    committed = true;
    let oldAclRestricted = false;
    if (options.restrictOldTree !== false) {
      try { secureWindowsTree(source); oldAclRestricted = true; }
      catch { /* The verified destination is already selected. Preserve source for operator cleanup. */ }
    }
    const report: MagpieDataMigrationReport = {
      destination, sourceRetained: source, instanceId: meta.instanceId,
      port: meta.port, adminPort: meta.adminPort,
      filesVerified: files.length, bytesVerified: verifiedBytes,
      linksRecreated: links.length, pathsRewritten: rewritten,
      keyDpapiProtected: process.platform === 'win32',
      sourceAclRestricted: oldAclRestricted,
      oldPluginCount: originalCount, newPluginCount: pluginCount(destination),
      verifiedAt: new Date().toISOString()
    };
    writeFileSync(join(hostDir, 'magpie-data-migration.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    return report;
  } catch (error) {
    if (stage && existsSync(stage)) {
      try { rmSync(stage, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 }); }
      catch { /* Original remains selected; inspect restricted stage manually. */ }
    }
    // The original source and profile remain untouched on all pre-commit failures.
    if (!committed) {
      const current = chooseMagpieProfile(hostBase, {});
      if (current.dataDir.toLowerCase() !== source.toLowerCase()) {
        try { selectMagpieProfile(hostBase, source); } catch { /* Report the original error; manual reconciliation required. */ }
      }
    }
    throw error;
  } finally { closeSync(fd); unlinkSync(lock); }
}

export function rollbackMagpieDataSelection(hostBase: string): string {
  const base = resolve(hostBase);
  if (existsSync(join(base, '.daming-host-owner.lock'))) throw new MagpieDataMigrationError('daming_host_must_be_stopped');
  const file = join(base, 'host', 'magpie-data-migration.json');
  if (!existsSync(file)) throw new MagpieDataMigrationError('magpie_migration_record_missing');
  const report = JSON.parse(readFileSync(file, 'utf8')) as MagpieDataMigrationReport;
  const current = chooseMagpieProfile(base, {});
  if (current.dataDir.toLowerCase() !== resolve(report.destination).toLowerCase() ||
    current.instanceId !== report.instanceId) throw new MagpieDataMigrationError('magpie_current_profile_changed');
  const original = readInstance(report.sourceRetained);
  if (original.instanceId !== report.instanceId || original.port !== report.port) {
    throw new MagpieDataMigrationError('magpie_rollback_identity_mismatch');
  }
  selectMagpieProfile(base, report.sourceRetained);
  return report.sourceRetained;
}

/**
 * Read-only post-migration verification. Never starts Magpie or rewrites instance,
 * plugin data, profile metadata, or secrets. Reports only safe counts/booleans.
 */
export function verifyMigratedMagpieData(hostBase: string): {
  readonly valid: true;
  readonly filesExpected: number;
  readonly sourceRetained: true;
  readonly instancePreserved: true;
  readonly pluginCountPreserved: true;
  readonly dpapiVerified: boolean;
  readonly activeSelectionMatches: true;
} {
  const base = resolve(hostBase);
  const reportPath = join(base, 'host', 'magpie-data-migration.json');
  if (!existsSync(reportPath)) throw new MagpieDataMigrationError('magpie_migration_record_missing');
  let report: MagpieDataMigrationReport;
  try { report = JSON.parse(readFileSync(reportPath, 'utf8')) as MagpieDataMigrationReport; }
  catch { throw new MagpieDataMigrationError('magpie_migration_record_invalid'); }
  if (!report || !Number.isSafeInteger(report.filesVerified) || report.filesVerified < 1 ||
      typeof report.sourceRetained !== 'string' || typeof report.destination !== 'string' ||
      typeof report.instanceId !== 'string' || !/^[0-9a-f]{32}$/.test(report.instanceId)) {
    throw new MagpieDataMigrationError('magpie_migration_record_invalid');
  }
  const current = chooseMagpieProfile(base, {});
  if (current.profile !== 'selected' || current.dataDir.toLowerCase() !== resolve(report.destination).toLowerCase() ||
      current.instanceId !== report.instanceId) throw new MagpieDataMigrationError('magpie_migration_selection_mismatch');
  const source = readInstance(report.sourceRetained);
  const dest = readInstance(report.destination);
  if (source.instanceId !== dest.instanceId || dest.instanceId !== report.instanceId ||
      source.port !== dest.port || source.adminPort !== dest.adminPort ||
      dest.port !== report.port || dest.adminPort !== report.adminPort) {
    throw new MagpieDataMigrationError('magpie_migration_identity_mismatch');
  }
  const srcCount = pluginCount(report.sourceRetained);
  const dstCount = pluginCount(report.destination);
  if (srcCount !== dstCount || srcCount !== report.oldPluginCount || dstCount !== report.newPluginCount) {
    throw new MagpieDataMigrationError('magpie_migration_plugin_count_mismatch');
  }
  if (process.platform === 'win32') {
    if (typeof dest.adminKeyDpapi !== 'string' || dest.adminKey !== undefined ||
        !unprotectWindowsSecret(dest.adminKeyDpapi)) throw new MagpieDataMigrationError('magpie_migration_dpapi_invalid');
  }
  return {
    valid: true, filesExpected: report.filesVerified, sourceRetained: true,
    instancePreserved: true, pluginCountPreserved: true,
    dpapiVerified: process.platform === 'win32', activeSelectionMatches: true
  };
}
