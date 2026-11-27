import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseMagpieProfile, selectMagpieProfile } from '../src/magpie-profile.ts';

test('selected Magpie instance survives restart without copying account files', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'daming-profile-'));
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const previous = join(base, 'existing-instance');
  mkdirSync(previous);
  const identity = 'a'.repeat(32);
  writeFileSync(join(previous, 'instance.json'), JSON.stringify({
    version: 2, port: 3457, adminPort: 3458, adminKey: 'not-to-expose-key', instanceId: identity, dataDir: previous
  }));
  const initial = chooseMagpieProfile(base, {});
  assert.equal(initial.profile, 'default');
  assert.equal(initial.instanceId, undefined);
  const chosen = selectMagpieProfile(base, previous);
  assert.equal(chosen.profile, 'selected');
  assert.equal(chosen.instanceId, identity);
  const restarted = chooseMagpieProfile(base, {});
  assert.deepEqual(restarted, chosen);
  const serialized = readFileSync(join(base, 'host', 'magpie-profile.json'), 'utf8');
  assert.doesNotMatch(serialized, /not-to-expose-key|adminKey/);
  assert.equal(chooseMagpieProfile(base, { DAMING_MAGPIE_DATA_DIR: previous }).profile, 'environment');
  writeFileSync(join(previous, 'instance.json'), JSON.stringify({ version: 2, port: 3457, instanceId: 'b'.repeat(32), dataDir: previous }));
  assert.throws(() => chooseMagpieProfile(base, {}), /magpie_profile_identity_changed/);
});

test('invalid chosen Magpie instance is refused and does not change active profile', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'daming-profile-invalid-'));
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  assert.throws(() => selectMagpieProfile(base, join(base, 'missing')), /magpie_profile_directory_missing/);
  assert.equal(chooseMagpieProfile(base, {}).profile, 'default');
});
