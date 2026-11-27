import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';

export type MagpieProfileKind = 'default' | 'selected' | 'environment';
export interface MagpieProfileChoice {
  readonly dataDir: string;
  readonly profile: MagpieProfileKind;
  readonly instanceId?: string;
}

interface StoredChoice {
  readonly version: 1;
  readonly dataDir: string;
  readonly instanceId: string;
}
export class MagpieProfileError extends Error {}

function selectedFile(baseDir: string): string { return join(baseDir, 'host', 'magpie-profile.json'); }

function inspected(dataDir: string): StoredChoice {
  if (!isAbsolute(dataDir)) throw new MagpieProfileError('magpie_profile_path_not_absolute');
  let canonical: string;
  try { canonical = realpathSync(dataDir); }
  catch { throw new MagpieProfileError('magpie_profile_directory_missing'); }
  try {
    const m: unknown = JSON.parse(readFileSync(join(canonical, 'instance.json'), 'utf8'));
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('invalid');
    const v = m as Record<string, unknown>;
    if (v.version !== 2 || typeof v.instanceId !== 'string' || !/^[0-9a-f]{32}$/.test(v.instanceId) ||
        typeof v.dataDir !== 'string' || resolve(v.dataDir).toLowerCase() !== canonical.toLowerCase()) {
      throw new Error('invalid');
    }
    return { version: 1, dataDir: canonical, instanceId: v.instanceId };
  } catch {
    throw new MagpieProfileError('magpie_profile_instance_mismatch');
  }
}

export function chooseMagpieProfile(baseDir: string, env: NodeJS.ProcessEnv = process.env): MagpieProfileChoice {
  const overridden = env.DAMING_MAGPIE_DATA_DIR?.trim();
  if (overridden) {
    const info = inspected(overridden);
    return { dataDir: info.dataDir, profile: 'environment', instanceId: info.instanceId };
  }
  const file = selectedFile(baseDir);
  if (existsSync(file)) {
    let value: unknown;
    try { value = JSON.parse(readFileSync(file, 'utf8')); }
    catch { throw new MagpieProfileError('magpie_profile_config_invalid'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MagpieProfileError('magpie_profile_config_invalid');
    const s = value as Record<string, unknown>;
    if (s.version !== 1 || typeof s.dataDir !== 'string' || typeof s.instanceId !== 'string') {
      throw new MagpieProfileError('magpie_profile_config_invalid');
    }
    const info = inspected(s.dataDir);
    if (info.instanceId !== s.instanceId) throw new MagpieProfileError('magpie_profile_identity_changed');
    return { dataDir: info.dataDir, profile: 'selected', instanceId: info.instanceId };
  }
  return { dataDir: resolve(join(baseDir, 'magpie-headless')), profile: 'default' };
}

// Explicitly adopts an existing Daming-owned instance; no credentials or account files are copied.
export function selectMagpieProfile(baseDir: string, candidate: string): MagpieProfileChoice {
  const chosen = inspected(resolve(candidate));
  mkdirSync(join(baseDir, 'host'), { recursive: true });
  const file = selectedFile(baseDir);
  if (existsSync(file)) {
    const previous = join(baseDir, 'host', 'magpie-profile.previous.' + Date.now() + '.json');
    copyFileSync(file, previous);
  }
  const temporary = file + '.next.' + randomBytes(6).toString('hex');
  writeFileSync(temporary, JSON.stringify(chosen, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  renameSync(temporary, file);
  return { dataDir: chosen.dataDir, profile: 'selected', instanceId: chosen.instanceId };
}
