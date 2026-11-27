import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { IdentityPrincipal } from './identity-registry.ts';

export type BudgetCurrency = 'USD' | 'CNY';
type Row = Record<string, unknown>;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const MAX_MINOR = 100_000_000; // one million units, never floating-point cash.
const isMinor = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) &&
  value >= 1 && value <= MAX_MINOR;

export class TenantBudgetError extends Error {
  readonly status: number;
  constructor(status: number, reason: string) { super(reason); this.status = status; }
}

export type TenantBudgetPolicyView = {
  tenantId: string; currency: BudgetCurrency;
  perRequestMinor: number; perUtcDayMinor: number;
  holdsAndSettledTodayMinor: number;
  canReservePreview: boolean;
  authorizedPaidDispatch: false;
  vendorGuaranteedCashCap: false;
  invoiceReconciliationVerified: false;
};
export type TenantBudgetHoldView = {
  holdId: string; requestId: string; tenantId: string;
  currency: BudgetCurrency; reservedMinor: number;
  utcDay: string; status: 'held_preview' | 'cancelled' | 'uncertain';
  createdAt: string; paidDispatchPermitted: false; externalVendorCalled: false;
};

/** A reserved amount is a LOCAL soft envelope, never an upstream cash guarantee. */
export type TrustedPaidAttemptView = {
  requestId: string; tenantId: string; credentialId: string;
  provider: 'openai' | 'deepseek'; modelId: string;
  currency: BudgetCurrency; reservedMinor: number;
  status: 'prepared' | 'sending' | 'uncertain' | 'cancelled' | 'expired';
  createdAt: string; expiresAt: string; vendorInvoiceVerified: false;
  vendorHardCapGuaranteed: false; autoRetryPermitted: false;
};
export type TrustedPaidIntent = {
  requestId: string; credentialId: string;
  provider: 'openai' | 'deepseek'; modelId: string;
  currency: BudgetCurrency; reservedMinor: number; payloadDigest: string;
};

function owner(principal: IdentityPrincipal): void {
  if (!principal || principal.memberRole !== 'owner') {
    throw new TenantBudgetError(403, 'tenant_owner_required');
  }
}
function member(principal: IdentityPrincipal): void {
  if (!principal || principal.memberRole === 'viewer') {
    throw new TenantBudgetError(403, 'tenant_operator_required');
  }
}

/** Offline budgeting only. All amounts are integer cents/fen.
 * This ledger does NOT mediate real upstream calls or certify provider invoices.
 * Held/uncertain amounts retain a reservation until explicitly resolved.
 */
export class TenantBudgetLedger {
  private readonly db: DatabaseSync;
  private readonly clock: () => number;
  constructor(dataDir: string, clock: () => number = Date.now) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dataDir, 'tenant-budget.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;' +
      'PRAGMA busy_timeout=5000;PRAGMA foreign_keys=ON;');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS policies(' +
      'tenant_id TEXT NOT NULL,currency TEXT NOT NULL,' +
      'per_request_minor INTEGER NOT NULL,day_minor INTEGER NOT NULL,' +
      'updated_by TEXT NOT NULL,updated_ms INTEGER NOT NULL,' +
      'PRIMARY KEY(tenant_id,currency));' +
      'CREATE TABLE IF NOT EXISTS holds(' +
      'id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,' +
      'request_id TEXT NOT NULL,currency TEXT NOT NULL,reserved_minor INTEGER NOT NULL,' +
      'utc_day TEXT NOT NULL,status TEXT NOT NULL,created_ms INTEGER NOT NULL,' +
      'UNIQUE(tenant_id,request_id));' +
      'CREATE INDEX IF NOT EXISTS holds_total ON holds(tenant_id,currency,utc_day,status);' +
      'CREATE TABLE IF NOT EXISTS paid_egress_attempts(' +
      'request_id TEXT NOT NULL,tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,' +
      'credential_id TEXT NOT NULL,provider TEXT NOT NULL,model_id TEXT NOT NULL,' +
      'currency TEXT NOT NULL,reserved_minor INTEGER NOT NULL,utc_day TEXT NOT NULL,' +
      'payload_digest TEXT NOT NULL,status TEXT NOT NULL,created_ms INTEGER NOT NULL,' +
      'expires_ms INTEGER NOT NULL,updated_ms INTEGER NOT NULL,' +
      'PRIMARY KEY(tenant_id,request_id));' +
      'CREATE INDEX IF NOT EXISTS paid_egress_tenant ON paid_egress_attempts(tenant_id,created_ms);'
    );
    // "sending" means an effect MAY have reached the vendor. Never replay
    // or release its cash envelope on restart.
    this.db.prepare("UPDATE paid_egress_attempts SET status='uncertain' WHERE status='sending'").run();
    this.clock = clock;
  }
  close(): void { this.db.close(); }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }
  private day(): string {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TenantBudgetError(503, 'budget_clock_unavailable');
    }
    return new Date(value).toISOString().slice(0, 10);
  }
  private used(tenantId: string, currency: BudgetCurrency): number {
    const offline = this.db.prepare(
      "SELECT COALESCE(SUM(reserved_minor),0) total FROM holds WHERE tenant_id=? " +
      "AND currency=? AND utc_day=? AND status IN ('held_preview','uncertain')"
    ).get(tenantId, currency, this.day()) as { total: number };
    const paid = this.db.prepare(
      "SELECT COALESCE(SUM(reserved_minor),0) total FROM paid_egress_attempts WHERE tenant_id=? " +
      "AND currency=? AND utc_day=? AND status IN ('prepared','sending','uncertain')"
    ).get(tenantId, currency, this.day()) as { total: number };
    return Number(offline.total) + Number(paid.total);
  }
  configure(principal: IdentityPrincipal, input: {
    currency: BudgetCurrency; perRequestMinor: number; perUtcDayMinor: number;
  }): TenantBudgetPolicyView {
    owner(principal);
    if (!input || (input.currency !== 'USD' && input.currency !== 'CNY') ||
        !isMinor(input.perRequestMinor) || !isMinor(input.perUtcDayMinor) ||
        input.perRequestMinor > input.perUtcDayMinor) {
      throw new TenantBudgetError(400, 'budget_policy_invalid');
    }
    return this.transaction(() => {
      const used = this.used(principal.tenantId, input.currency);
      if (input.perUtcDayMinor < used) {
        throw new TenantBudgetError(409, 'budget_policy_below_uncleared_holds');
      }
      this.db.prepare(
        'INSERT INTO policies(tenant_id,currency,per_request_minor,day_minor,updated_by,updated_ms)' +
        ' VALUES(?,?,?,?,?,?) ON CONFLICT(tenant_id,currency) DO UPDATE SET ' +
        'per_request_minor=excluded.per_request_minor,day_minor=excluded.day_minor,' +
        'updated_by=excluded.updated_by,updated_ms=excluded.updated_ms'
      ).run(principal.tenantId, input.currency, input.perRequestMinor,
        input.perUtcDayMinor, principal.userId, this.clock());
      return this.policy(principal, input.currency)!;
    });
  }
  policy(principal: IdentityPrincipal, currency: BudgetCurrency): TenantBudgetPolicyView | null {
    if (currency !== 'USD' && currency !== 'CNY') {
      throw new TenantBudgetError(400, 'budget_currency_invalid');
    }
    const row = this.db.prepare(
      'SELECT * FROM policies WHERE tenant_id=? AND currency=?'
    ).get(principal.tenantId, currency) as Row | undefined;
    if (!row) return null;
    const used = this.used(principal.tenantId, currency);
    const uncertain = !!this.db.prepare("SELECT 1 FROM holds WHERE tenant_id=? AND status='uncertain' LIMIT 1")
      .get(principal.tenantId) ||
      !!this.db.prepare("SELECT 1 FROM paid_egress_attempts WHERE tenant_id=? " +
        "AND status IN ('sending','uncertain') LIMIT 1").get(principal.tenantId);
    return {
      tenantId: principal.tenantId, currency,
      perRequestMinor: Number(row.per_request_minor),
      perUtcDayMinor: Number(row.day_minor),
      holdsAndSettledTodayMinor: used,
      canReservePreview: !uncertain && used < Number(row.day_minor),
      authorizedPaidDispatch: false, vendorGuaranteedCashCap: false,
      invoiceReconciliationVerified: false
    };
  }
  policies(principal: IdentityPrincipal): TenantBudgetPolicyView[] {
    return (['USD','CNY'] as const).map(v => this.policy(principal, v))
      .filter((v): v is TenantBudgetPolicyView => v !== null);
  }
  /** This reservation is never allowed to be used as permission to call a
   * paid endpoint; caller's amount is untrusted and only for offline planning. */
  previewHold(principal: IdentityPrincipal, input: {
    currency: BudgetCurrency; requestId: string; requestedMinor: number;
  }): TenantBudgetHoldView {
    member(principal);
    if (!input || (input.currency !== 'USD' && input.currency !== 'CNY') ||
        typeof input.requestId !== 'string' || !UUID.test(input.requestId) ||
        !isMinor(input.requestedMinor)) throw new TenantBudgetError(400, 'budget_hold_invalid');
    return this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM holds WHERE tenant_id=? AND request_id=?')
        .get(principal.tenantId, input.requestId) as Row | undefined;
      if (old) {
        if (old.currency !== input.currency || old.reserved_minor !== input.requestedMinor) {
          throw new TenantBudgetError(409, 'budget_request_id_conflict');
        }
        return this.view(old);
      }
      const p = this.policy(principal, input.currency);
      if (p && !p.canReservePreview) throw new TenantBudgetError(409, 'budget_held_or_uncertain');
      if (!p || input.requestedMinor > p.perRequestMinor ||
          input.requestedMinor > p.perUtcDayMinor - p.holdsAndSettledTodayMinor) {
        throw new TenantBudgetError(409, 'budget_preview_exceeds_configured_limit');
      }
      const id = randomUUID();
      this.db.prepare(
        'INSERT INTO holds(id,tenant_id,user_id,request_id,currency,reserved_minor,' +
        'utc_day,status,created_ms) VALUES(?,?,?,?,?,?,?,?,?)'
      ).run(id, principal.tenantId, principal.userId, input.requestId,
        input.currency, input.requestedMinor, this.day(), 'held_preview', this.clock());
      return this.view(this.db.prepare('SELECT * FROM holds WHERE id=?').get(id) as Row);
    });
  }
  private view(row: Row): TenantBudgetHoldView {
    return {
      holdId: String(row.id), requestId: String(row.request_id),
      tenantId: String(row.tenant_id), currency: String(row.currency) as BudgetCurrency,
      reservedMinor: Number(row.reserved_minor), utcDay: String(row.utc_day),
      status: String(row.status) as TenantBudgetHoldView['status'],
      createdAt: new Date(Number(row.created_ms)).toISOString(),
      paidDispatchPermitted: false, externalVendorCalled: false
    };
  }
  listHolds(principal: IdentityPrincipal): TenantBudgetHoldView[] {
    return (this.db.prepare('SELECT * FROM holds WHERE tenant_id=? ' +
      'ORDER BY created_ms DESC,id DESC LIMIT 100'
    ).all(principal.tenantId) as Row[]).map(row => this.view(row));
  }
  /** A local-only plan has *never* been dispatched; cancelling frees its
   * local preview budget. An uncertain hold is NOT releasable. */
  cancelPreview(principal: IdentityPrincipal, holdId: string): TenantBudgetHoldView {
    member(principal);
    if (!UUID.test(holdId)) throw new TenantBudgetError(404, 'budget_hold_not_found');
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM holds WHERE tenant_id=? AND id=?')
        .get(principal.tenantId, holdId) as Row | undefined;
      if (!row) throw new TenantBudgetError(404, 'budget_hold_not_found');
      if (row.user_id !== principal.userId && principal.memberRole !== 'owner') {
        throw new TenantBudgetError(403, 'budget_hold_not_owned');
      }
      if (row.status !== 'held_preview') {
        throw new TenantBudgetError(409, 'budget_hold_cannot_release');
      }
      this.db.prepare("UPDATE holds SET status='cancelled' WHERE id=? AND status='held_preview'")
        .run(holdId);
      return this.view({ ...row, status: 'cancelled' });
    });
  }
  /** Reserved for connection uncertainty; only an independent future vendor
   * reconciliation system can clear it. There is intentionally no manual
   * "mark invoice verified" API that would claim legal settlement. */
  markUncertain(principal: IdentityPrincipal, holdId: string): TenantBudgetHoldView {
    owner(principal);
    if (!UUID.test(holdId)) throw new TenantBudgetError(404, 'budget_hold_not_found');
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM holds WHERE tenant_id=? AND id=?')
        .get(principal.tenantId, holdId) as Row | undefined;
      if (!row) throw new TenantBudgetError(404, 'budget_hold_not_found');
      if (row.status !== 'held_preview') throw new TenantBudgetError(409, 'budget_hold_invalid_state');
      this.db.prepare("UPDATE holds SET status='uncertain' WHERE id=?").run(holdId);
      return this.view({ ...row, status: 'uncertain' });
    });
  }

  private paidView(row: Row): TrustedPaidAttemptView {
    return {
      requestId: String(row.request_id), tenantId: String(row.tenant_id),
      credentialId: String(row.credential_id),
      provider: String(row.provider) as 'openai' | 'deepseek',
      modelId: String(row.model_id), currency: String(row.currency) as BudgetCurrency,
      reservedMinor: Number(row.reserved_minor),
      status: String(row.status) as TrustedPaidAttemptView['status'],
      createdAt: isoAt(Number(row.created_ms)), expiresAt: isoAt(Number(row.expires_ms)),
      vendorInvoiceVerified: false, vendorHardCapGuaranteed: false,
      autoRetryPermitted: false
    };
  }
  /** Full journal query: listPaid() is a limited UI view and must never
   * be used to prove absence of older uncertain charges. */
  hasUnknownCash(principal: IdentityPrincipal): boolean {
    owner(principal);
    const holds = this.db.prepare("SELECT 1 FROM holds WHERE tenant_id=? AND status='uncertain' LIMIT 1")
      .get(principal.tenantId);
    const paid = this.db.prepare("SELECT 1 FROM paid_egress_attempts WHERE tenant_id=? AND status IN ('sending','uncertain') LIMIT 1")
      .get(principal.tenantId);
    return !!holds || !!paid;
  }
  listPaid(principal: IdentityPrincipal): TrustedPaidAttemptView[] {
    owner(principal);
    return (this.db.prepare('SELECT * FROM paid_egress_attempts WHERE tenant_id=? ' +
      'ORDER BY created_ms DESC,request_id DESC LIMIT 50').all(principal.tenantId) as Row[])
      .map(row => this.paidView(row));
  }
  /**
   * Prepare an immutable, one-shot operation. This is NOT a vendor cash
   * guarantee. Prepared attempts share the SAME budget with offline holds.
   */
  preparePaid(principal: IdentityPrincipal, input: TrustedPaidIntent): TrustedPaidAttemptView {
    owner(principal);
    if (!input || !UUID.test(input.requestId) || !UUID.test(input.credentialId) ||
        !['openai','deepseek'].includes(input.provider) ||
        !/^[a-z0-9][a-z0-9._:/-]{1,99}$/i.test(input.modelId) ||
        (input.currency !== 'USD' && input.currency !== 'CNY') ||
        !isMinor(input.reservedMinor) || !/^[a-f0-9]{128}$/i.test(input.payloadDigest)) {
      throw new TenantBudgetError(400, 'paid_egress_input_invalid');
    }
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM paid_egress_attempts WHERE tenant_id=? AND request_id=?')
        .get(principal.tenantId, input.requestId) as Row | undefined;
      if (existing) {
        if (existing.user_id !== principal.userId ||
            existing.credential_id !== input.credentialId ||
            existing.provider !== input.provider || existing.model_id !== input.modelId ||
            existing.currency !== input.currency || existing.reserved_minor !== input.reservedMinor ||
            existing.payload_digest !== input.payloadDigest) {
          throw new TenantBudgetError(409, 'paid_egress_request_conflict');
        }
        return this.paidView(existing);
      }
      if (this.db.prepare('SELECT 1 FROM holds WHERE tenant_id=? AND request_id=?')
        .get(principal.tenantId, input.requestId)) {
        throw new TenantBudgetError(409, 'paid_egress_request_conflict');
      }
      const activeDrafts = this.db.prepare(
        "SELECT COUNT(*) count FROM paid_egress_attempts WHERE tenant_id=? AND status='prepared'"
      ).get(principal.tenantId) as { count: number };
      if (activeDrafts.count >= 20) {
        throw new TenantBudgetError(409, 'paid_egress_too_many_prepared');
      }
      const budget = this.policy(principal, input.currency);
      if (!budget || !budget.canReservePreview ||
          input.reservedMinor > budget.perRequestMinor ||
          input.reservedMinor > budget.perUtcDayMinor - budget.holdsAndSettledTodayMinor) {
        throw new TenantBudgetError(409, 'paid_egress_budget_denied');
      }
      const created = this.clock();
      this.db.prepare('INSERT INTO paid_egress_attempts(request_id,tenant_id,user_id,credential_id,' +
        'provider,model_id,currency,reserved_minor,utc_day,payload_digest,status,' +
        'created_ms,expires_ms,updated_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(input.requestId, principal.tenantId, principal.userId,
          input.credentialId, input.provider, input.modelId, input.currency,
          input.reservedMinor, this.day(), input.payloadDigest, 'prepared',
          created, created + 5 * 60_000, created);
      return this.paidView(this.db.prepare('SELECT * FROM paid_egress_attempts WHERE tenant_id=? AND request_id=?')
        .get(principal.tenantId, input.requestId) as Row);
    });
  }
  /** Durable before the first outbound byte. A crash cannot make it retryable. */
  beginPaidSend(principal: IdentityPrincipal, intent: TrustedPaidIntent): TrustedPaidAttemptView {
    owner(principal);
    if (!UUID.test(intent.requestId)) throw new TenantBudgetError(404, 'paid_egress_request_missing');
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM paid_egress_attempts WHERE tenant_id=? AND request_id=?')
        .get(principal.tenantId, intent.requestId) as Row | undefined;
      if (!row) throw new TenantBudgetError(404, 'paid_egress_request_missing');
      if (row.user_id !== principal.userId || row.credential_id !== intent.credentialId ||
          row.provider !== intent.provider || row.model_id !== intent.modelId ||
          row.currency !== intent.currency || row.reserved_minor !== intent.reservedMinor ||
          row.payload_digest !== intent.payloadDigest) {
        throw new TenantBudgetError(409, 'paid_egress_request_conflict');
      }
      if (row.status !== 'prepared') throw new TenantBudgetError(409, 'paid_egress_already_claimed');
      if (Number(row.expires_ms) <= this.clock() || row.utc_day !== this.day())
        throw new TenantBudgetError(409, 'paid_egress_authorization_expired');
      // A prior request with unknown cash blocks ALL new provider traffic for
      // the tenant, even if the other attempt was prepared concurrently.
      if (this.db.prepare("SELECT 1 FROM paid_egress_attempts WHERE tenant_id=? " +
          "AND request_id!=? AND status IN ('sending','uncertain') LIMIT 1")
        .get(principal.tenantId, intent.requestId) ||
          this.db.prepare("SELECT 1 FROM holds WHERE tenant_id=? AND status='uncertain' LIMIT 1")
            .get(principal.tenantId)) {
        throw new TenantBudgetError(409, 'paid_egress_uncertain_cash_block');
      }
      this.db.prepare("UPDATE paid_egress_attempts SET status='sending',updated_ms=? WHERE tenant_id=? AND request_id=?")
        .run(this.clock(), principal.tenantId, intent.requestId);
      return this.paidView({ ...row, status: 'sending' });
    });
  }
  /** Success is still CASH-UNKNOWN until authoritative reconciliation. */
  finishPaidUnknown(principal: IdentityPrincipal, requestId: string): TrustedPaidAttemptView {
    owner(principal);
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM paid_egress_attempts WHERE tenant_id=? AND request_id=?')
        .get(principal.tenantId, requestId) as Row | undefined;
      if (!row || row.status !== 'sending') {
        throw new TenantBudgetError(409, 'paid_egress_effect_not_claimed');
      }
      this.db.prepare("UPDATE paid_egress_attempts SET status='uncertain',updated_ms=? WHERE tenant_id=? AND request_id=?")
        .run(this.clock(), principal.tenantId, requestId);
      return this.paidView({ ...row, status: 'uncertain' });
    });
  }
  cancelPaidBeforeSend(principal: IdentityPrincipal, requestId: string): TrustedPaidAttemptView {
    owner(principal);
    if (!UUID.test(requestId)) throw new TenantBudgetError(404, 'paid_egress_request_missing');
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM paid_egress_attempts WHERE tenant_id=? AND request_id=?')
        .get(principal.tenantId, requestId) as Row | undefined;
      if (!row) throw new TenantBudgetError(404, 'paid_egress_request_missing');
      if (row.status !== 'prepared') throw new TenantBudgetError(409, 'paid_egress_cannot_release');
      this.db.prepare("UPDATE paid_egress_attempts SET status='cancelled',updated_ms=? WHERE tenant_id=? AND request_id=?")
        .run(this.clock(), principal.tenantId, requestId);
      return this.paidView({ ...row, status: 'cancelled' });
    });
  }
}
function isoAt(ms: number): string { return new Date(ms).toISOString(); }
