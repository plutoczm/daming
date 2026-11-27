/**
 * Canonical installer manifest + deterministic renderer/validator for the Windows NSIS build.
 *
 * Keeping the config in code means: (1) tests can assert the "history retained / no silent
 * behaviour" invariants, and (2) `electron-builder.yml` on disk must equal `renderElectronBuilderYml`
 * so it can never drift from the validated manifest.
 */

export interface NsisOptions {
  readonly oneClick: boolean;
  readonly perMachine: boolean;
  readonly allowElevation: boolean;
  readonly allowToChangeInstallationDirectory: boolean;
  readonly createDesktopShortcut: boolean;
  readonly createStartMenuShortcut: boolean;
  /** false => task data, history and logs survive uninstall (only program files are removed). */
  readonly deleteAppDataOnUninstall: boolean;
  readonly differentialPackage: boolean;
  readonly artifactName: string;
}

export interface WindowsTarget {
  readonly target: string;
  readonly arch: readonly string[];
}

export interface ExtraResource {
  readonly from: string;
  readonly to: string;
  readonly filter: readonly string[];
}

export interface InstallerConfig {
  readonly appId: string;
  readonly productName: string;
  readonly artifactName: string;
  readonly directories: { readonly output: string; readonly buildResources: string };
  readonly files: readonly string[];
  readonly extraResources: readonly ExtraResource[];
  readonly win: { readonly target: readonly WindowsTarget[]; readonly artifactName: string; readonly icon?: string };
  readonly nsis: NsisOptions;
  readonly publish: null;
}

/** The single source of truth for the Daming desktop installer. */
export const DESKTOP_INSTALLER: InstallerConfig = Object.freeze({
  appId: 'com.daming.desktop',
  productName: 'Daming',
  artifactName: 'Daming-Setup.exe',
  directories: { output: 'release', buildResources: 'build-resources' },
  files: ['electron/**/*', 'package.json'],
  extraResources: [{ from: 'build/host', to: 'host', filter: ['**/*'] }],
  win: { target: [{ target: 'nsis', arch: ['x64'] }], artifactName: 'Daming-Setup.exe', icon: 'electron/assets/app.ico' },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    deleteAppDataOnUninstall: false,
    differentialPackage: true,
    artifactName: 'Daming-Setup.exe',
  },
  publish: null,
});

/** Return every invariant violation. Empty array means the installer honours the S12 contract. */
export function validateInstallerConfig(config: InstallerConfig): string[] {
  const issues: string[] = [];
  if (!config.appId) issues.push('appId is required');
  if (!config.productName) issues.push('productName is required');
  if (!config.artifactName.endsWith('Daming-Setup.exe')) issues.push('artifactName must be Daming-Setup.exe');
  if (config.win.artifactName !== 'Daming-Setup.exe') issues.push('win.artifactName must be Daming-Setup.exe');
  if (!config.win.target.some((t) => t.target === 'nsis')) issues.push('win target must include nsis');
  if (config.nsis.artifactName !== 'Daming-Setup.exe') issues.push('nsis.artifactName must be Daming-Setup.exe');
  if (config.nsis.oneClick) issues.push('oneClick must be false so users can choose the install directory');
  if (config.nsis.deleteAppDataOnUninstall) issues.push('deleteAppDataOnUninstall must be false to retain history');
  if (!config.nsis.differentialPackage) issues.push('differentialPackage must be true for clean upgrades');
  if (!config.extraResources.some((r) => r.to === 'host')) issues.push('extraResources must ship the managed host bundle');
  if (config.publish !== null) issues.push('publish must be null: local build only, no auto-publish');
  return issues;
}

export function assertInstallerConfig(config: InstallerConfig): void {
  const issues = validateInstallerConfig(config);
  if (issues.length) throw new Error('invalid_installer_config: ' + issues.join('; '));
}

function quote(value: string): string {
  return '"' + value.replace(/"/g, '\\"') + '"';
}

/** Deterministic YAML rendering used to keep `electron-builder.yml` in lockstep with the manifest. */
export function renderElectronBuilderYml(config: InstallerConfig): string {
  const lines: string[] = [];
  lines.push('# Generated from apps/desktop/src/installer.ts (DESKTOP_INSTALLER). Do not edit by hand.');
  lines.push('appId: ' + config.appId);
  lines.push('productName: ' + quote(config.productName));
  lines.push('artifactName: ' + config.artifactName);
  lines.push('directories:');
  lines.push('  output: ' + config.directories.output);
  lines.push('  buildResources: ' + config.directories.buildResources);
  lines.push('files:');
  for (const file of config.files) lines.push('  - ' + quote(file));
  lines.push('extraResources:');
  for (const resource of config.extraResources) {
    lines.push('  - from: ' + resource.from);
    lines.push('    to: ' + resource.to);
    lines.push('    filter:');
    for (const item of resource.filter) lines.push('      - ' + quote(item));
  }
  lines.push('win:');
  if (config.win.icon) lines.push('  icon: ' + config.win.icon);
  lines.push('  artifactName: ' + config.win.artifactName);
  lines.push('  target:');
  for (const target of config.win.target) {
    lines.push('    - target: ' + target.target);
    lines.push('      arch:');
    for (const arch of target.arch) lines.push('        - ' + arch);
  }
  lines.push('nsis:');
  lines.push('  oneClick: ' + config.nsis.oneClick);
  lines.push('  perMachine: ' + config.nsis.perMachine);
  lines.push('  allowElevation: ' + config.nsis.allowElevation);
  lines.push('  allowToChangeInstallationDirectory: ' + config.nsis.allowToChangeInstallationDirectory);
  lines.push('  createDesktopShortcut: ' + config.nsis.createDesktopShortcut);
  lines.push('  createStartMenuShortcut: ' + config.nsis.createStartMenuShortcut);
  lines.push('  deleteAppDataOnUninstall: ' + config.nsis.deleteAppDataOnUninstall);
  lines.push('  differentialPackage: ' + config.nsis.differentialPackage);
  lines.push('  artifactName: ' + config.nsis.artifactName);
  lines.push('publish: null');
  return lines.join('\n') + '\n';
}
