/**
 * Optional Magpie policy for the desktop shell.
 *
 * Daming's default model supply is self-owned. Magpie is an OPTIONAL compatibility backend. The
 * desktop must never install it and must never start it without an explicit user opt-in; an
 * absent binary is reported, not fetched.
 */
export const MAGPIE_DEFAULT_ENABLED = false;

/** Hard invariant tested by installation tests: the installer never bundles or installs Magpie. */
export const MAGPIE_SILENT_INSTALL_ALLOWED = false;

export type MagpieDecisionReason = 'disabled_by_default' | 'not_installed' | 'user_enabled';

export interface MagpieStartDecision {
  readonly start: boolean;
  readonly reason: MagpieDecisionReason;
}

/** Decide whether to start the optional Magpie process. Starts only when user-enabled AND present. */
export function decideMagpieStart(input: { readonly userEnabled: boolean; readonly installed: boolean }): MagpieStartDecision {
  if (!input.userEnabled) return { start: false, reason: 'disabled_by_default' };
  if (!input.installed) return { start: false, reason: 'not_installed' };
  return { start: true, reason: 'user_enabled' };
}

/** Thrown if any code path tries to install or enable Magpie without a user action. */
export class SilentMagpieInstallError extends Error {
  constructor(message = 'magpie_install_requires_explicit_user_action') {
    super(message);
    this.name = 'SilentMagpieInstallError';
  }
}

/** Guard used before any Magpie provisioning: a user-enabled flag is mandatory. */
export function assertUserInitiatedMagpie(input: { readonly userEnabled: boolean }): void {
  if (!input.userEnabled) throw new SilentMagpieInstallError();
}
