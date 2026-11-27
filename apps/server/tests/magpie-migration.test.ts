import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectLegacyMagpieMeta, migrateLegacyMagpieMeta } from '../src/magpie-migration.ts';

function legacyDir(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'daming-magpie-v1-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const file = join(dir, 'instance.json');
  const original = JSON.stringify({ version: 1, port: 34978, instanceId: 'a'.repeat(32), dataDir: dir }, null, 2) + '\n';
  writeFileSync(file, original);
  return { dir, file, original };
}

test('v1 migration preserves ID/port/data and makes a byte-for-byte rollback backup', (t) => {
  const { dir, file, original } = legacyDir(t);
  writeFileSync(join(dir, 'magpie.log'), 'keep this log');
  assert.equal(inspectLegacyMagpieMeta(dir)?.port, 34978);
  const current = migrateLegacyMagpieMeta(dir, 34979);
  assert.equal(current.version, 2);
  assert.equal(current.migratedFrom, 1);
  assert.equal(current.instanceId, 'a'.repeat(32));
  assert.equal(current.port, 34978);
  assert.equal(current.adminPort, 34979);
  assert.match(current.adminKey, /^[A-Za-z0-9_-]{32}$/);
  const readBack = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(readBack, current);
  assert.equal(readFileSync(join(dir, 'instance.v1.backup.json'), 'utf8'), original);
  assert.equal(readFileSync(join(dir, 'magpie.log'), 'utf8'), 'keep this log');
  assert.equal(existsSync(join(dir, 'instance.migration.lock')), false);
});

test('legacy migration refuses stale backups and concurrent migration locks without changing metadata', (t) => {
  const { dir, file, original } = legacyDir(t);
  writeFileSync(join(dir, 'instance.v1.backup.json'), 'a different old instance');
  assert.throws(() => migrateLegacyMagpieMeta(dir, 34979), /migration_backup_conflict/);
  assert.equal(readFileSync(file, 'utf8'), original);
  rmSync(join(dir, 'instance.v1.backup.json'));
  writeFileSync(join(dir, 'instance.migration.lock'), 'held by another process');
  assert.throws(() => migrateLegacyMagpieMeta(dir, 34979), /migration_lock_exists/);
  assert.equal(readFileSync(file, 'utf8'), original);
});

test('legacy migration refuses wrong directory, malformed identifier and port collision', (t) => {
  const { dir, file } = legacyDir(t);
  assert.throws(() => migrateLegacyMagpieMeta(dir, 34978), /invalid_legacy_metadata/);
  const wrong = JSON.stringify({ version: 1, port: 34978, instanceId: 'not-valid', dataDir: dir });
  writeFileSync(file, wrong);
  assert.equal(inspectLegacyMagpieMeta(dir), undefined);
  assert.throws(() => migrateLegacyMagpieMeta(dir, 34979), /invalid_legacy_metadata/);
  assert.equal(readFileSync(file, 'utf8'), wrong);
});
