/**
 * Production evidence admission is DENY-BY-CONSTRUCTION until the actual
 * subscription execution identity and vendor's REQUEST-LEVEL settlement/
 * guarantee become independently provable. A unit test can simulate
 * observations, but the Host never receives a client-controlled "pass" bit.
 *
 * This is a READ-ONLY verification report, not a capability grant.
 */
export type ProofState = 'verified' | 'blocked' | 'unavailable';
export interface ProofItem {
  readonly code: string;
  readonly state: ProofState;
  readonly evidence: string;
  readonly requirement: string;
}
export interface ProductionProofReport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly mode: 'fail_closed_evidence_review';
  readonly manualOneShotPreconditionsMet: boolean;
  readonly nativeSubscriptionExecutionApproved: false;
  readonly automatedMultiTurnApproved: false;
  readonly strictPerRequestCashCapApproved: false;
  readonly authoritativeInvoiceSettlementApproved: false;
  readonly productionPaidDispatchApproved: false;
  readonly items: readonly ProofItem[];
  readonly blockers: readonly string[];
  readonly realVendorInferencePerformedByThisCheck: false;
  readonly vendorCredentialsAccessedByThisCheck: false;
  readonly unknownHoldsReleasedByThisCheck: false;
}
export interface ProofAccount {
  readonly credentialId: string;
  readonly provider: 'openai' | 'deepseek';
  readonly expiresAt: string;
}
export interface ProofInputs {
  readonly nowMs: number;
  readonly tenantOwner: boolean;
  readonly mfaEnabled: boolean;
  readonly dockerIsolatedAtMs: number | null;
  readonly rootAdministrator: boolean;
  readonly magpiePatchedNativeScopeObserved: boolean;
  readonly account: ProofAccount | null;
  readonly budgetConfiguredAndAvailable: boolean;
  readonly anyUnknownCash: boolean;
  readonly officialDailyCostObservations: readonly {
    credentialId: string; observedAt: string;
    invoiceAuthenticated: false;
  }[];
  readonly officialMonthlyLimitObservations: readonly {
    credentialId: string; observedAt: string;
    project: { enforcementStatus: string; thresholdMinor: number };
    organization: { enforcementStatus: string; thresholdMinor: number };
    strictPerRequestCashCapVerified: false;
  }[];
}
const SAFE_MS = 5 * 60_000;
const COST_MS = 72 * 60 * 60_000;
const LIMIT_MS = 15 * 60_000;
function recent(at: number, now: number, maxAge: number): boolean {
  return Number.isSafeInteger(at) && at > 0 && at <= now && now - at <= maxAge;
}
function dateMs(date: string): number {
  return typeof date === 'string' ? Date.parse(date) : NaN;
}
export function evaluateProductionProof(input: ProofInputs): ProductionProofReport {
  if (!input || !Number.isSafeInteger(input.nowMs) || input.nowMs < 1_700_000_000_000 ||
      !Array.isArray(input.officialDailyCostObservations) ||
      !Array.isArray(input.officialMonthlyLimitObservations) ||
      input.officialDailyCostObservations.length > 100 ||
      input.officialMonthlyLimitObservations.length > 100) {
    throw new Error('production_evidence_input_invalid');
  }
  const at = input.nowMs;
  const account = input.account;
  const ownedAccount = !!account &&
    /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(account.credentialId) &&
    ['openai','deepseek'].includes(account.provider) &&
    Number.isFinite(dateMs(account.expiresAt)) && dateMs(account.expiresAt) > at;
  const isolated = input.dockerIsolatedAtMs !== null &&
    recent(input.dockerIsolatedAtMs, at, SAFE_MS);
  const ownerMfa = input.tenantOwner && input.mfaEnabled;
  const accountCost = ownedAccount && account.provider === 'openai' &&
    input.officialDailyCostObservations.some(x =>
      x.credentialId === account.credentialId &&
      x.invoiceAuthenticated === false &&
      recent(dateMs(x.observedAt), at, COST_MS));
  const limitSeen = ownedAccount && account.provider === 'openai' &&
    input.officialMonthlyLimitObservations.some(x =>
      x.credentialId === account.credentialId &&
      x.strictPerRequestCashCapVerified === false &&
      recent(dateMs(x.observedAt), at, LIMIT_MS) &&
      (x.project.enforcementStatus === 'enforcing' ||
       x.organization.enforcementStatus === 'enforcing') &&
      [x.project.thresholdMinor, x.organization.thresholdMinor].every(n =>
        Number.isSafeInteger(n) && n > 0 && n <= 100_000_000));
  const item = (code: string, requirement: string,
    state: ProofState, evidence: string): ProofItem => ({ code, requirement, state, evidence });
  const checks: ProofItem[] = [
    item('tenant_owner_mfa', 'Owner and second factor for this exact tenant',
      ownerMfa ? 'verified' : 'blocked',
      ownerMfa ? 'persistent_session_and_mfa_registry' : 'owner_or_mfa_missing'),
    item('fresh_real_docker_isolation', 'Networkless Docker Agent probe within 5 minutes',
      isolated ? 'verified' : 'blocked',
      isolated ? 'docker_real_container_recent' : 'real_docker_probe_required'),
    item('magpie_native_single_upstream', 'Live patched Magpie single-upstream scope capability',
      input.rootAdministrator && input.magpiePatchedNativeScopeObserved ? 'verified' : 'unavailable',
      input.rootAdministrator && input.magpiePatchedNativeScopeObserved
        ? 'native_gateway_scope_readonly' : 'live_magpie_scope_not_proved'),
    item('exact_tenant_model_key', 'One independently verified non-revoked tenant API account',
      ownedAccount ? 'verified' : 'blocked',
      ownedAccount ? 'tenant_vault_metadata_only' : 'tenant_account_missing_or_expired'),
    item('configured_soft_budget', 'Currency-matched local budget with available room',
      input.budgetConfiguredAndAvailable ? 'verified' : 'blocked',
      input.budgetConfiguredAndAvailable
        ? 'tenant_sqlite_soft_reservation' : 'local_budget_unavailable'),
    item('no_unknown_prior_cash', 'No pending unknown supplier cash effects',
      input.anyUnknownCash ? 'blocked' : 'verified',
      input.anyUnknownCash
        ? 'previous_cash_effect_must_remain_frozen' : 'local_cash_journal_no_unknown'),
    item('openai_issued_service_key_cost_scope',
      'Official full-day project+API-key aggregated cost observed for this key',
      accountCost ? 'verified' : 'unavailable',
      accountCost ? 'openai_admin_aggregate_not_invoice' :
        'no_fresh_issued_key_aggregate_for_selected_account'),
    item('openai_enforcing_monthly_limit',
      'Official project or organization monthly limit enforcing and freshly observed',
      limitSeen ? 'verified' : 'unavailable',
      limitSeen ? 'official_admin_monthly_limit_can_overshoot' :
        'no_fresh_enforcing_limit_for_selected_account'),
    item('subscription_account_owned_by_tenant',
      'Authenticated native subscription account and session bound to tenant',
      'unavailable', 'magpie_subscription_login_not_cryptographically_bound_to_tenant'),
    item('subscription_actual_upstream_receipt',
      'Server-attested final subscription account for each real Agent turn',
      'unavailable', 'no_verified_final_subscription_account_receipt'),
    item('subscription_runtime_isolated',
      'Native subscription CLI and OAuth refresh entirely inside approved sandbox',
      'unavailable', 'native_subscription_process_outside_governed_docker'),
    item('per_request_authoritative_cash_invoice',
      'Vendor-authenticated request-level charge for this exact dispatch ID',
      'unavailable', 'daily_cost_aggregates_have_no_request_invoice_id'),
    item('strict_cash_precommit_refusal',
      'Vendor guarantees no spend beyond per-request committed cash ceiling',
      'unavailable', 'monthly_spend_limits_can_overshoot_and_are_not_per_request'),
    item('multi_turn_reconciliation_checkpoint',
      'Every paid tool turn can settle and resume with proven spend',
      'unavailable', 'paid_turn_journal_has_no_verified_cash_settlement'),
    item('all_other_runners_isolated',
      'No legacy Windows AutoLoop/Codex/DSH path bypasses the paid proxy',
      'unavailable', 'legacy_cli_paths_not_migrated')
  ];
  // Never use a caller-supplied boolean to unlock the real upstream. The
  // project currently lacks 5 distinct externally attestable properties.
  const manual = ownerMfa && isolated && ownedAccount &&
    input.budgetConfiguredAndAvailable && !input.anyUnknownCash;
  return {
    schemaVersion: 1,
    generatedAt: new Date(at).toISOString(),
    mode: 'fail_closed_evidence_review',
    manualOneShotPreconditionsMet: manual,
    nativeSubscriptionExecutionApproved: false,
    automatedMultiTurnApproved: false,
    strictPerRequestCashCapApproved: false,
    authoritativeInvoiceSettlementApproved: false,
    productionPaidDispatchApproved: false,
    items: checks,
    blockers: checks.filter(c => c.state !== 'verified').map(c => c.code),
    realVendorInferencePerformedByThisCheck: false,
    vendorCredentialsAccessedByThisCheck: false,
    unknownHoldsReleasedByThisCheck: false
  };
}
