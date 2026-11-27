export {
  DEFAULT_DESKTOP_SETTINGS,
  mergeSettings,
  planUpgrade,
  resolveDesktopPaths,
} from './paths.ts';
export type {
  DesktopPathInput,
  DesktopPaths,
  DesktopSettings,
  UpgradeInput,
  UpgradePlan,
} from './paths.ts';

export {
  HOST_READY_PREFIX,
  HostSupervisor,
  buildBootstrapUrl,
  buildHostSpawnPlan,
  buildProcessTreeKill,
  parseHostOutputLine,
} from './host-lifecycle.ts';
export type {
  BuildHostSpawnInput,
  HostChild,
  HostOutputLine,
  HostSnapshot,
  HostSpawnPlan,
  HostState,
  SupervisorDeps,
} from './host-lifecycle.ts';

export {
  MAGPIE_DEFAULT_ENABLED,
  MAGPIE_SILENT_INSTALL_ALLOWED,
  SilentMagpieInstallError,
  assertUserInitiatedMagpie,
  decideMagpieStart,
} from './magpie-gate.ts';
export type { MagpieDecisionReason, MagpieStartDecision } from './magpie-gate.ts';

export {
  DESKTOP_INSTALLER,
  assertInstallerConfig,
  renderElectronBuilderYml,
  validateInstallerConfig,
} from './installer.ts';
export type { ExtraResource, InstallerConfig, NsisOptions, WindowsTarget } from './installer.ts';
