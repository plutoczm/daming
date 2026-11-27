import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import { loadEnv } from './load-env.mjs';
import { chooseMagpieProfile } from '../apps/server/src/magpie-profile.ts';
import { migrateMagpieData, rollbackMagpieDataSelection, verifyMigratedMagpieData } from '../apps/server/src/magpie-data-migration.ts';
import { createMagpieHost } from '../apps/server/src/magpie-host.ts';

loadEnv(resolve('.env'));
const root = resolve(process.env.DAMING_DATA_DIR ?? join(process.env.LOCALAPPDATA ?? '.', 'Daming'));
const target = resolve(join(root, 'magpie-headless'));
const action = process.argv[2] ?? 'status';
const recordFile = join(root, 'host', 'magpie-data-migration.json');

async function busy(port) {
  return await new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(800);
    socket.once('connect', () => { socket.destroy(); done(true); });
    socket.once('timeout', () => { socket.destroy(); done(true); });
    socket.once('error', (e) => { socket.destroy(); done(e.code !== 'ECONNREFUSED'); });
  });
}

if (action === 'status') {
  const chosen = chooseMagpieProfile(root);
  console.log('Daming profile:', chosen.profile);
  console.log('Instance directory:', chosen.dataDir);
  console.log('Stable directory:', target);
  console.log('Stable exists:', existsSync(target));
  if (existsSync(recordFile)) {
    const report = JSON.parse(readFileSync(recordFile, 'utf8'));
    console.log('Migration: recorded; checked files:', report.filesVerified, 'plugin cache links:', report.linksRecreated);
    console.log('Original backup directory retained:', report.sourceRetained);
  } else console.log('Migration: not yet recorded');
} else if (action === 'verify') {
  const audit = verifyMigratedMagpieData(root);
  console.log('MIGRATION_VERIFIED', JSON.stringify(audit));
} else if (action === 'migrate') {
  if (process.env.DAMING_MAGPIE_DATA_DIR) {
    throw new Error('DAMING_MAGPIE_DATA_DIR override is active. Disable it before migration.');
  }
  const choice = chooseMagpieProfile(root, {});
  if (choice.profile !== 'selected' || !choice.instanceId) {
    throw new Error('Select and verify the existing Magpie profile first.');
  }
  console.log('Preparing non-destructive migration; original instance is retained.');
  const observed = {};
  const report = await migrateMagpieData({
    hostBase: root, sourceDir: choice.dataDir, destinationDir: target,
    verifyBackend: async (dest) => {
      const daemon = createMagpieHost({ dataDir: dest, profile: 'selected' });
      try {
        const status = await daemon.ensure();
        if (!status.configured || status.instanceId !== choice.instanceId) {
          throw new Error('magpie_migrated_backend_not_ready');
        }
        for (const alias of ['models', 'providers', 'plugins', 'quotas']) {
          const snapshot = await daemon.read(alias);
          if (snapshot.count === null) throw new Error('magpie_migrated_' + alias + '_invalid');
          observed[alias] = snapshot.count;
        }
      } finally {
        daemon.stop();
        // Wait for Windows process teardown before returning control to normal Host startup.
        for (let i = 0; i < 30; i++) {
          if (!await busy(3457) && !await busy(3458)) break;
          await new Promise((r) => setTimeout(r, 200));
        }
        if (await busy(3457) || await busy(3458)) throw new Error('magpie_migrated_daemon_still_running');
      }
    }
  });
  console.log('MIGRATION_COMPLETE', JSON.stringify({
    version: 2, instancePreserved: report.instanceId === choice.instanceId,
    filesByteCompared: report.filesVerified, bytesCompared: report.bytesVerified,
    internalJunctionsFixed: report.linksRecreated, pathsRewritten: report.pathsRewritten,
    originalRetained: true, oldSourceAclRestricted: report.sourceAclRestricted,
    keyProtectedWithDpapi: report.keyDpapiProtected,
    pluginsBefore: report.oldPluginCount, pluginsAfter: report.newPluginCount,
    realBackend: observed, target: report.destination
  }));
} else if (action === 'rollback') {
  if (process.env.DAMING_MAGPIE_DATA_DIR) throw new Error('Disable DAMING_MAGPIE_DATA_DIR override first.');
  if (!existsSync(recordFile)) throw new Error('Migration record unavailable, cannot automatically rollback.');
  const info = JSON.parse(readFileSync(recordFile, 'utf8'));
  if (await busy(info.port) || await busy(info.adminPort)) {
    throw new Error('Stop Daming Host and Magpie daemon before selecting rollback.');
  }
  const restored = rollbackMagpieDataSelection(root);
  console.log('Selection restored to retained original:', restored);
  console.log('Stable migrated copy retained for inspection. Restart Host manually.');
} else {
  throw new Error('Usage: pnpm magpie:data status | verify | migrate | rollback');
}
