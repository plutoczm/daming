import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  symlinkSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateMagpieData, rollbackMagpieDataSelection, verifyMigratedMagpieData } from '../src/magpie-data-migration.ts';
import { selectMagpieProfile, chooseMagpieProfile } from '../src/magpie-profile.ts';
import { protectWindowsSecret, unprotectWindowsSecret } from '../src/windows-secret.ts';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(process.env.LOCALAPPDATA ?? tmpdir(), 'daming-safe-migration-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  const hostBase = join(root, 'Daming');
  const source = join(root, 'legacy-managed');
  const destination = join(root, 'Daming', 'magpie-headless');
  mkdirSync(source, { recursive: true });
  mkdirSync(hostBase, { recursive: true });
  const meta = {
    version: 2, port: 34075, adminPort: 34076,
    instanceId: 'd'.repeat(32), dataDir: source,
    adminKey: 'private-admin-key-1234567890'
  };
  writeFileSync(join(source, 'instance.json'), JSON.stringify(meta));
  const configDir = join(source, 'config', 'magpie');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'plugins.json'), JSON.stringify({
    plugins: [{ spec: '@trusted/example@latest', options: { session: 'never-print' } }]
  }));
  const cacheDir = join(source, 'cache', 'magpie');
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, 'providers-state.json'), JSON.stringify({
    providers: { gateway: { archive: { folder: join(source, 'cache', 'magpie', 'archives') } } }
  }));
  const pkg = join(source, 'cache', 'pkg');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'installed.txt'), 'package contents');
  const isolatedLinkParent = join(source, 'cache', 'link-only-parent');
  mkdirSync(isolatedLinkParent);
  const link = join(isolatedLinkParent, 'pkg-link');
  if (process.platform === 'win32') symlinkSync(pkg, link, 'junction');
  else symlinkSync(pkg, link, 'dir');
  selectMagpieProfile(hostBase, source);
  return { root, hostBase, source, destination, meta };
}

test('Windows DPAPI seals a secret per current user without storing plaintext', () => {
  if (process.platform !== 'win32') return;
  const token = 'test-credential-' + Date.now();
  const ciphertext = protectWindowsSecret(token);
  assert.notEqual(ciphertext, token);
  assert.equal(unprotectWindowsSecret(ciphertext), token);
  assert.throws(() => unprotectWindowsSecret('not-base64'), /dpapi_payload_invalid/);
});

test('Magpie data migrates byte-for-byte with re-pointed junctions and protected admin credential', async (t) => {
  const { hostBase, source, destination, meta } = fixture(t);
  let verified = false;
  const report = await migrateMagpieData({
    hostBase, sourceDir: source, destinationDir: destination,
    checkPort: async () => false, restrictOldTree: false,
    verifyBackend: async (dir) => {
      assert.equal(dir, destination);
      const next = JSON.parse(readFileSync(join(dir, 'instance.json'), 'utf8')) as Record<string, unknown>;
      assert.equal(next.instanceId, meta.instanceId);
      assert.equal(next.dataDir, destination);
      if (process.platform === 'win32') {
        assert.equal(next.adminKey, undefined);
        assert.equal(unprotectWindowsSecret(next.adminKeyDpapi as string), meta.adminKey);
      }
      const state = JSON.parse(readFileSync(join(dir, 'cache', 'magpie', 'providers-state.json'), 'utf8')) as { providers: { gateway: { archive: { folder: string } } } };
      assert.ok(state.providers.gateway.archive.folder.startsWith(destination));
      assert.equal(readFileSync(join(dir, 'cache', 'link-only-parent', 'pkg-link', 'installed.txt'), 'utf8'), 'package contents');
      verified = true;
    }
  });
  assert.equal(verified, true);
  assert.equal(report.filesVerified >= 4, true);
  assert.equal(report.linksRecreated, 1);
  assert.equal(report.oldPluginCount, 1);
  assert.equal(report.newPluginCount, 1);
  assert.equal(report.keyDpapiProtected, process.platform === 'win32');
  assert.equal(readFileSync(join(source, 'instance.json'), 'utf8').includes(meta.adminKey), true);
  assert.equal(chooseMagpieProfile(hostBase, {}).dataDir, destination);
  const audit = verifyMigratedMagpieData(hostBase);
  assert.equal(audit.valid, true);
  assert.equal(audit.filesExpected, report.filesVerified);
  assert.equal(audit.pluginCountPreserved, true);
  assert.equal(audit.dpapiVerified, process.platform === 'win32');
  assert.equal(rollbackMagpieDataSelection(hostBase), source);
  assert.throws(() => verifyMigratedMagpieData(hostBase), /magpie_migration_selection_mismatch/);
  assert.equal(chooseMagpieProfile(hostBase, {}).dataDir, source);
});

test('failed backend verification keeps original selected and old credentials intact', async (t) => {
  const { hostBase, source, destination } = fixture(t);
  await assert.rejects(migrateMagpieData({
    hostBase, sourceDir: source, destinationDir: destination,
    checkPort: async () => false, restrictOldTree: false,
    verifyBackend: async () => { throw new Error('simulated-backend-unavailable'); }
  }), /simulated-backend-unavailable/);
  assert.equal(chooseMagpieProfile(hostBase, {}).dataDir, source);
  assert.equal(existsSync(join(source, 'instance.json')), true);
  assert.equal(existsSync(join(source, 'config', 'magpie', 'plugins.json')), true);
});

test('migration refuses busy ports and does not make a stage copy', async (t) => {
  const { hostBase, source, destination } = fixture(t);
  let requestedBackend = false;
  await assert.rejects(migrateMagpieData({
    hostBase, sourceDir: source, destinationDir: destination,
    checkPort: async () => true,
    verifyBackend: async () => { requestedBackend = true; }
  }), /magpie_ports_in_use/);
  assert.equal(requestedBackend, false);
  assert.equal(existsSync(destination), false);
  assert.equal(chooseMagpieProfile(hostBase, {}).dataDir, source);
});

test('read-only migration verification detects changed installed plugin inventory', async (t) => {
  const { hostBase, source, destination } = fixture(t);
  await migrateMagpieData({
    hostBase, sourceDir: source, destinationDir: destination,
    checkPort: async () => false, restrictOldTree: false,
    verifyBackend: async () => undefined
  });
  const file = join(destination, 'config', 'magpie', 'plugins.json');
  writeFileSync(file, JSON.stringify({ plugins: [] }));
  assert.throws(() => verifyMigratedMagpieData(hostBase), /magpie_migration_plugin_count_mismatch/);
  assert.equal(readFileSync(join(source, 'config', 'magpie', 'plugins.json'), 'utf8').includes('@trusted/example'), true);
});
