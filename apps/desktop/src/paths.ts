import { join, resolve } from 'node:path';

/** Absolute, per-user desktop locations. Pure apart from path joining, so tests run cross-platform. */
export interface DesktopPaths {
  readonly dataDir: string;
  readonly historyDir: string;
  readonly settingsFile: string;
  readonly cacheDir: string;
  readonly logDir: string;
}

export interface DesktopPathInput {
  readonly platform: NodeJS.Platform | string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeFallback?: string;
}

const APP_DIR = 'Daming';

/** Resolve the single per-user data root. History and settings live here and survive upgrades. */
export function resolveDesktopPaths(input: DesktopPathInput): DesktopPaths {
  const env = input.env;
  const home = input.homeFallback ?? env.USERPROFILE ?? env.HOME ?? '.';
  let root: string;
  if (input.platform === 'win32') {
    root = join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), APP_DIR);
  } else if (input.platform === 'darwin') {
    root = join(home, 'Library', 'Application Support', APP_DIR);
  } else {
    root = join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), APP_DIR);
  }
  const dataDir = resolve(root);
  return {
    dataDir,
    historyDir: join(dataDir, 'history'),
    settingsFile: join(dataDir, 'desktop-settings.json'),
    cacheDir: join(dataDir, 'cache'),
    logDir: join(dataDir, 'logs'),
  };
}

export interface DesktopSettings {
  readonly hostPort: number;
  /** Optional Magpie is OFF by default; the desktop never installs or starts it silently. */
  readonly startMagpie: boolean;
  readonly firstRunVersion?: string;
  readonly schemaVersion: number;
  readonly extra: Readonly<Record<string, unknown>>;
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = Object.freeze({
  hostPort: 3210,
  startMagpie: false,
  schemaVersion: 1,
  extra: Object.freeze({}),
});

function validPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 65535;
}

/**
 * Merge any on-disk settings with defaults while preserving unknown keys so an older or newer
 * build never loses a user preference across upgrade/downgrade.
 */
export function mergeSettings(existing: unknown): DesktopSettings {
  const row = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? existing as Record<string, unknown>
    : {};
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (['hostPort', 'startMagpie', 'firstRunVersion', 'schemaVersion'].includes(key)) continue;
    extra[key] = value;
  }
  return {
    hostPort: validPort(row.hostPort) ? row.hostPort : DEFAULT_DESKTOP_SETTINGS.hostPort,
    startMagpie: typeof row.startMagpie === 'boolean' ? row.startMagpie : DEFAULT_DESKTOP_SETTINGS.startMagpie,
    ...(typeof row.firstRunVersion === 'string' ? { firstRunVersion: row.firstRunVersion } : {}),
    schemaVersion: Number.isSafeInteger(row.schemaVersion) && (row.schemaVersion as number) > 0
      ? row.schemaVersion as number
      : DEFAULT_DESKTOP_SETTINGS.schemaVersion,
    extra,
  };
}

export interface UpgradePlan {
  /** Paths that must be kept: user data and history survive upgrade, downgrade and uninstall. */
  readonly preserve: readonly string[];
  /** Only disposable per-version cache directories may be removed. */
  readonly remove: readonly string[];
  readonly settings: DesktopSettings;
  readonly firstRun: boolean;
  readonly versionChanged: boolean;
}

export interface UpgradeInput {
  readonly fromVersion?: string;
  readonly toVersion: string;
  readonly settings: unknown;
  readonly cacheDirs?: readonly string[];
  readonly paths: DesktopPaths;
}

/**
 * Decide what an upgrade keeps and what it clears. History and settings are always preserved;
 * only caller-supplied disposable cache directories are removable, and only for a different
 * app version. This is the deterministic contract behind "history retained on upgrade".
 */
export function planUpgrade(input: UpgradeInput): UpgradePlan {
  if (!input.toVersion || typeof input.toVersion !== 'string') throw new Error('toVersion is required');
  const settings = mergeSettings(input.settings);
  const versionChanged = !!input.fromVersion && input.fromVersion !== input.toVersion;
  const firstRun = settings.firstRunVersion === undefined;
  const cacheDirs = input.cacheDirs ?? [];
  return {
    preserve: [input.paths.dataDir, input.paths.historyDir, input.paths.settingsFile],
    remove: versionChanged ? [...cacheDirs] : [],
    settings: firstRun ? { ...settings, firstRunVersion: input.toVersion } : settings,
    firstRun,
    versionChanged,
  };
}
