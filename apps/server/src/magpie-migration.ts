import { constants, copyFileSync, existsSync, openSync, closeSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

export interface LegacyMagpieMeta {
  readonly version: 1;
  readonly port: number;
  readonly instanceId: string;
  readonly dataDir: string;
}

export interface UpgradedMagpieMeta {
  readonly version: 2;
  readonly port: number;
  readonly adminPort: number;
  readonly adminKey: string;
  readonly instanceId: string;
  readonly dataDir: string;
  readonly migratedFrom: 1;
}

export class MagpieMigrationError extends Error {}

const validPort = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 1024 && n <= 65535;

export function inspectLegacyMagpieMeta(dir: string): LegacyMagpieMeta | undefined {
  const file = join(dir, 'instance.json');
  if (!existsSync(file)) return undefined;
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const m = value as Record<string, unknown>;
  if (m.version !== 1 || !validPort(m.port) ||
      typeof m.instanceId !== 'string' || !/^[a-f0-9]{32}$/.test(m.instanceId) ||
      typeof m.dataDir !== 'string' || resolve(m.dataDir).toLowerCase() !== resolve(dir).toLowerCase()) return undefined;
  return m as unknown as LegacyMagpieMeta;
}

// Only call after verifying that both the old gateway port and new admin port are unused.
// Original bytes remain at instance.v1.backup.json for a manual rollback.
export function migrateLegacyMagpieMeta(dir: string, adminPort: number): UpgradedMagpieMeta {
  const normalized = resolve(dir);
  const file = join(normalized, 'instance.json');
  const backup = join(normalized, 'instance.v1.backup.json');
  const lock = join(normalized, 'instance.migration.lock');
  if (!validPort(adminPort)) throw new MagpieMigrationError('invalid_magpie_admin_port');
  let fd: number;
  try { fd = openSync(lock, 'wx', 0o600); }
  catch { throw new MagpieMigrationError('migration_lock_exists'); }
  let nextFile: string | undefined;
  try {
    const legacy = inspectLegacyMagpieMeta(normalized);
    if (!legacy || legacy.port === adminPort) throw new MagpieMigrationError('invalid_legacy_metadata');
    const original = readFileSync(file, 'utf8');
    if (existsSync(backup)) {
      if (readFileSync(backup, 'utf8') !== original) throw new MagpieMigrationError('migration_backup_conflict');
    } else {
      copyFileSync(file, backup, constants.COPYFILE_EXCL);
    }
    const updated: UpgradedMagpieMeta = {
      version: 2, port: legacy.port, adminPort, adminKey: randomBytes(24).toString('base64url'),
      instanceId: legacy.instanceId, dataDir: normalized, migratedFrom: 1
    };
    nextFile = join(dirname(file), 'instance.next.' + randomBytes(8).toString('hex'));
    writeFileSync(nextFile, JSON.stringify(updated, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    if (readFileSync(file, 'utf8') !== original) throw new MagpieMigrationError('migration_source_changed');
    renameSync(nextFile, file);
    nextFile = undefined;
    return updated;
  } finally {
    if (nextFile && existsSync(nextFile)) unlinkSync(nextFile);
    closeSync(fd);
    unlinkSync(lock);
  }
}
