import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { evaluateProductionProof } from '../src/production-proof.ts';
import type { ProofInputs } from '../src/production-proof.ts';

const NOW = Date.UTC(2026, 10, 13, 15, 0);
const CREDENTIAL = randomUUID();
const full = (): ProofInputs => ({
  nowMs: NOW,
  tenantOwner: true, mfaEnabled: true,
  dockerIsolatedAtMs: NOW - 2000,
  rootAdministrator: true,
  magpiePatchedNativeScopeObserved: true,
  account: {
    credentialId: CREDENTIAL, provider: 'openai',
    expiresAt: new Date(NOW + 60_000).toISOString()
  },
  budgetConfiguredAndAvailable: true,
  anyUnknownCash: false,
  officialDailyCostObservations: [{
    credentialId: CREDENTIAL,
    observedAt: new Date(NOW - 60_000).toISOString(),
    invoiceAuthenticated: false
  }],
  officialMonthlyLimitObservations: [{
    credentialId: CREDENTIAL,
    observedAt: new Date(NOW - 60_000).toISOString(),
    project: { enforcementStatus: 'enforcing', thresholdMinor: 200 },
    organization: { enforcementStatus: 'enforcing', thresholdMinor: 1000 },
    strictPerRequestCashCapVerified: false
  }]
});
function item(report: ReturnType<typeof evaluateProductionProof>, code: string) {
  const found = report.items.find(v => v.code === code);
  assert.ok(found, code);
  return found;
}
test('even optimistic live signals cannot forge authoritative per-request and subscription proof', () => {
  const report = evaluateProductionProof(full());
  for (const code of [
    'tenant_owner_mfa','fresh_real_docker_isolation',
    'magpie_native_single_upstream','exact_tenant_model_key',
    'configured_soft_budget','no_unknown_prior_cash',
    'openai_issued_service_key_cost_scope','openai_enforcing_monthly_limit'
  ]) assert.equal(item(report, code).state, 'verified', code);
  for (const code of [
    'subscription_account_owned_by_tenant','subscription_actual_upstream_receipt',
    'subscription_runtime_isolated','per_request_authoritative_cash_invoice',
    'strict_cash_precommit_refusal','multi_turn_reconciliation_checkpoint',
    'all_other_runners_isolated'
  ]) {
    assert.equal(item(report, code).state, 'unavailable', code);
    assert.ok(report.blockers.includes(code));
  }
  assert.equal(report.manualOneShotPreconditionsMet, true);
  assert.equal(report.nativeSubscriptionExecutionApproved, false);
  assert.equal(report.automatedMultiTurnApproved, false);
  assert.equal(report.strictPerRequestCashCapApproved, false);
  assert.equal(report.authoritativeInvoiceSettlementApproved, false);
  assert.equal(report.productionPaidDispatchApproved, false);
  assert.equal(report.realVendorInferencePerformedByThisCheck, false);
  assert.equal(report.vendorCredentialsAccessedByThisCheck, false);
  assert.equal(report.unknownHoldsReleasedByThisCheck, false);
  assert.ok(!JSON.stringify(report).includes(CREDENTIAL),
    'account and provider secret identifiers are not in report');
});
test('stale, wrong-tenant, or inactive invoice/limit evidence is never accepted', () => {
  const wrong = randomUUID();
  const inactive = full();
  assert.equal(item(evaluateProductionProof({
    ...inactive, officialMonthlyLimitObservations: [{
      ...inactive.officialMonthlyLimitObservations[0],
      project: { enforcementStatus: 'inactive', thresholdMinor: 200 },
      organization: { enforcementStatus: 'inactive', thresholdMinor: 1000 }
    }]
  }), 'openai_enforcing_monthly_limit').state, 'unavailable');
  const stale = full();
  assert.equal(item(evaluateProductionProof({
    ...stale, dockerIsolatedAtMs: NOW - 301_000,
    officialMonthlyLimitObservations: [{
      ...stale.officialMonthlyLimitObservations[0],
      observedAt: new Date(NOW - 16 * 60_000).toISOString()
    }],
    officialDailyCostObservations: [{
      ...stale.officialDailyCostObservations[0],
      observedAt: new Date(NOW - 73 * 3600_000).toISOString()
    }]
  }), 'fresh_real_docker_isolation').state, 'blocked');
  assert.equal(item(evaluateProductionProof({
    ...stale, officialMonthlyLimitObservations: [{
      ...stale.officialMonthlyLimitObservations[0],
      credentialId: wrong
    }],
    officialDailyCostObservations: [{
      ...stale.officialDailyCostObservations[0],
      credentialId: wrong
    }]
  }), 'openai_enforcing_monthly_limit').state, 'unavailable');
  assert.equal(item(evaluateProductionProof({
    ...stale, officialDailyCostObservations: [{
      ...stale.officialDailyCostObservations[0],
      credentialId: wrong
    }]
  }), 'openai_issued_service_key_cost_scope').state, 'unavailable');
});
test('unresolved cash and missing MFA override even a fresh Docker probe', () => {
  const evidence = evaluateProductionProof({
    ...full(), mfaEnabled: false, anyUnknownCash: true
  });
  assert.equal(evidence.manualOneShotPreconditionsMet, false);
  assert.equal(item(evidence,'tenant_owner_mfa').state, 'blocked');
  assert.equal(item(evidence,'no_unknown_prior_cash').state, 'blocked');
  assert.equal(evidence.productionPaidDispatchApproved, false);
  assert.equal(item(evaluateProductionProof({
    ...full(), account: { ...full().account!, expiresAt: new Date(NOW - 1).toISOString() }
  }), 'exact_tenant_model_key').state, 'blocked');
  assert.equal(item(evaluateProductionProof({
    ...full(), rootAdministrator: false
  }), 'magpie_native_single_upstream').state, 'unavailable');
});
test('proof API refuses malformed or malicious observation structures', () => {
  assert.throws(() => evaluateProductionProof({
    ...full(), nowMs: 0
  }), /production_evidence_input_invalid/);
  assert.throws(() => evaluateProductionProof({
    ...full(), officialMonthlyLimitObservations: Array(101).fill(null)
  }), /production_evidence_input_invalid/);
});
