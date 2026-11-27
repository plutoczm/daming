import { resolve, join } from 'node:path';
import { chooseMagpieProfile, selectMagpieProfile } from '../apps/server/src/magpie-profile.ts';
import { loadEnv } from './load-env.mjs';

loadEnv(resolve('.env'));
const base = resolve(process.env.DAMING_DATA_DIR ?? join(process.env.LOCALAPPDATA ?? process.env.USERPROFILE ?? '.', 'Daming'));
const verb = process.argv[2] ?? 'status';
if (verb === 'status') {
  const choice = chooseMagpieProfile(base);
  console.log('Daming Magpie profile:', choice.profile);
  console.log('Instance data:', choice.dataDir);
  console.log('Instance ID:', choice.instanceId ?? '(not created)');
} else if (verb === 'use') {
  const path = process.argv[3];
  if (!path) throw new Error('Usage: pnpm magpie:profile use <existing-instance-directory>');
  if (process.env.DAMING_MAGPIE_DATA_DIR) throw new Error('Remove DAMING_MAGPIE_DATA_DIR override before selecting a saved profile');
  const chosen = selectMagpieProfile(base, resolve(path));
  console.log('Selected existing Magpie instance:', chosen.dataDir);
  console.log('Instance ID:', chosen.instanceId);
  console.log('Restart pnpm start:web to apply. No account files were copied.');
} else {
  throw new Error('Usage: pnpm magpie:profile status | use <existing-instance-directory>');
}
