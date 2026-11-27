import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TenantBudgetLedger } from '../src/tenant-budget.ts';
import type { IdentityPrincipal } from '../src/identity-registry.ts';

const principal = (tenantId: string, role: 'owner' | 'operator' | 'viewer' = 'owner'):
  IdentityPrincipal => ({
    userId: randomUUID(), username: 'fixture', tenantId,
    tenantName: 'fixture', memberRole: role, rootAdministrator: false
  });

test('atomically reserves preview budget without ever authorizing paid routing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'daming-budget-test-'));
  const tenant = randomUUID();
  const alice = principal(tenant);
  const bob = principal(randomUUID());
  const observer = principal(tenant, 'viewer');
  let clock = Date.UTC(2026, 10, 12, 12, 0, 0);
  let store = new TenantBudgetLedger(dir, () => clock);
  try {
    const policy = store.configure(alice, {
      currency: 'USD', perRequestMinor: 500, perUtcDayMinor: 1000
    });
    assert.equal(policy.authorizedPaidDispatch, false);
    assert.equal(policy.vendorGuaranteedCashCap, false);
    assert.equal(policy.invoiceReconciliationVerified, false);
    assert.equal(store.policy(bob, 'USD'), null);
    assert.deepEqual(store.listHolds(bob), []);
    assert.throws(() => store.configure(observer, {
      currency: 'USD', perRequestMinor: 100, perUtcDayMinor: 200
    }), /tenant_owner_required/);
    assert.throws(() => store.previewHold(observer, {
      currency: 'USD', requestId: randomUUID(), requestedMinor: 1
    }), /tenant_operator_required/);
    const requestId = randomUUID();
    const one = store.previewHold(alice, {
      currency: 'USD', requestId, requestedMinor: 400
    });
    assert.equal(one.status, 'held_preview');
    assert.equal(one.paidDispatchPermitted, false);
    assert.equal(one.externalVendorCalled, false);
    assert.equal(store.previewHold(alice, {
      currency: 'USD', requestId, requestedMinor: 400
    }).holdId, one.holdId);
    assert.equal(store.policy(alice, 'USD')?.holdsAndSettledTodayMinor, 400);
    assert.throws(() => store.previewHold(alice, {
      currency: 'USD', requestId, requestedMinor: 401
    }), /budget_request_id_conflict/);
    assert.throws(() => store.cancelPreview(bob, one.holdId),
      /budget_hold_not_found/);
    assert.throws(() => store.configure(alice, {
      currency: 'USD', perRequestMinor: 100, perUtcDayMinor: 200
    }), /budget_policy_below_uncleared_holds/);
    const two = store.previewHold(alice, {
      currency: 'USD', requestId: randomUUID(), requestedMinor: 500
    });
    assert.equal(store.policy(alice, 'USD')?.holdsAndSettledTodayMinor, 900);
    assert.throws(() => store.previewHold(alice, {
      currency: 'USD', requestId: randomUUID(), requestedMinor: 150
    }), /budget_preview_exceeds_configured_limit/);
    store.cancelPreview(alice, one.holdId);
    assert.equal(store.policy(alice, 'USD')?.holdsAndSettledTodayMinor, 500);
    store.markUncertain(alice, two.holdId);
    assert.throws(() => store.cancelPreview(alice, two.holdId), /budget_hold_cannot_release/);
    assert.equal(store.policy(alice, 'USD')?.holdsAndSettledTodayMinor, 500);
    assert.equal(store.listHolds(alice).length, 2);
    store.close();
    store = new TenantBudgetLedger(dir, () => clock);
    assert.equal(store.policy(alice, 'USD')?.holdsAndSettledTodayMinor, 500);
    clock += 86400000;
    assert.equal(store.policy(alice, 'USD')?.holdsAndSettledTodayMinor, 0);
    assert.ok(store.listHolds(alice).some(h => h.status === 'uncertain'));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
});

test('two SQLite writers cannot exceed one tenant daily cap or mix currencies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'daming-budget-concurrency-'));
  const alice = principal(randomUUID());
  const store = new TenantBudgetLedger(dir);
  const other = new TenantBudgetLedger(dir);
  try {
    store.configure(alice, {
      currency: 'CNY', perRequestMinor: 800, perUtcDayMinor: 1000
    });
    const first = store.previewHold(alice, {
      currency: 'CNY', requestId: randomUUID(), requestedMinor: 800
    });
    assert.throws(() => other.previewHold(alice, {
      currency: 'CNY', requestId: randomUUID(), requestedMinor: 800
    }), /budget_preview_exceeds_configured_limit/);
    assert.equal(other.policy(alice, 'CNY')?.holdsAndSettledTodayMinor, 800);
    assert.equal(store.policy(alice, 'USD'), null);
    assert.equal(other.cancelPreview(alice, first.holdId).status, 'cancelled');
    assert.equal(store.policy(alice, 'CNY')?.holdsAndSettledTodayMinor, 0);
  } finally {
    store.close(); other.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
});


test('paid egress journal scopes IDs per tenant and restart makes sending uncertain', () => {
  const dir = mkdtempSync(join(tmpdir(), 'daming-egress-ledger-'));
  let clock = Date.UTC(2026, 10, 13, 23, 58);
  const a = principal(randomUUID()), b = principal(randomUUID());
  const requestId = randomUUID();
  const intent = { requestId, credentialId: randomUUID(), provider: 'deepseek' as const,
    modelId: 'deepseek-flash', currency: 'CNY' as const,
    reservedMinor: 60, payloadDigest: 'a'.repeat(128) };
  let store = new TenantBudgetLedger(dir, () => clock);
  try {
    for (const user of [a,b]) store.configure(user,
      { currency: 'CNY', perRequestMinor: 90, perUtcDayMinor: 100 });
    assert.equal(store.preparePaid(a, intent).status, 'prepared');
    assert.equal(store.preparePaid(b, intent).status, 'prepared');
    assert.deepEqual(store.listPaid(a).map(x => x.tenantId), [a.tenantId]);
    assert.deepEqual(store.listPaid(b).map(x => x.tenantId), [b.tenantId]);
    store.cancelPaidBeforeSend(b, requestId);
    store.beginPaidSend(a, intent);
    store.close();
    clock += 4 * 60 * 1000;
    store = new TenantBudgetLedger(dir, () => clock);
    assert.equal(store.listPaid(a)[0].status, 'uncertain');
    assert.equal(store.listPaid(b)[0].status, 'cancelled');
    assert.equal(store.policy(a, 'CNY')?.holdsAndSettledTodayMinor, 0);
    assert.equal(store.policy(a, 'CNY')?.canReservePreview, false);
    assert.throws(() => store.preparePaid(a,
      { ...intent, requestId: randomUUID(), reservedMinor: 1 }),
      /paid_egress_budget_denied/);
    assert.equal(store.preparePaid(b,
      { ...intent, requestId: randomUUID(), reservedMinor: 10 }).status, 'prepared');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
});
