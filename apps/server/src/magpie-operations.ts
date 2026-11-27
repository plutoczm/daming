import { randomBytes, randomUUID, timingSafeEqual, scryptSync } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MagpieActionView, MagpieOperationStatus, MagpieOperationRisk, MagpieOperationView, MagpiePreparationView } from '@daming/contracts';
import { magpieActionRisk, validateMagpieAction } from './magpie-host.ts';
import { protectWindowsSecret } from './windows-secret.ts';

export class MagpieOperationError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, reason: string) { super(reason); this.statusCode = statusCode; }
}

interface Row {
  id: string;
  session_id: string;
  approval_token: string;
  action: string;
  risk: MagpieOperationRisk | null;
  actor_sid: string | null;
  windows_approved_at: string | null;
  body_json: string;
  status: MagpieOperationStatus;
  requested_at: string;
  expires_at: string;
  started_at: string | null;
  completed_at: string | null;
  result_json: string | null;
  reason: string | null;
  resolution: string | null;
  evidence: string | null;
  reconciled_by: string | null;
}

function safeView(row: Row): MagpieOperationView {
  let checkin: MagpieActionView['checkin'];
  if (row.result_json) {
    try {
      const value = JSON.parse(row.result_json) as MagpieActionView;
      checkin = value.checkin;
    } catch { /* only a safe summary is stored */ }
  }
  const params = JSON.parse(row.body_json) as { spec?: string };
  return {
    id: row.id, action: row.action, risk: row.risk ?? magpieActionRisk(row.action), ...(params.spec ? { target: params.spec } : {}),
    status: row.status, requestedAt: row.requested_at, expiresAt: row.expires_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    ...(checkin ? { checkin } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.resolution === 'succeeded' || row.resolution === 'not_executed'
      ? { resolution: row.resolution } : {})
  };
}

function approvalVerifier(token: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(token, salt, 32);
  return 's2.' + salt.toString('base64url') + '.' + key.toString('base64url');
}

function equalToken(stored: string, supplied: string): boolean {
  if (stored.startsWith('s2.')) {
    const parts = stored.split('.');
    if (parts.length !== 3 || parts[1].length !== 22 || parts[2].length !== 43) return false;
    const salt = Buffer.from(parts[1], 'base64url');
    const expected = Buffer.from(parts[2], 'base64url');
    if (salt.length !== 16 || expected.length !== 32) return false;
    const result = scryptSync(supplied, salt, 32);
    return timingSafeEqual(expected, result);
  }
  // Compatibility for old prepared records; startup expires them before use.
  const one = Buffer.from(stored);
  const two = Buffer.from(supplied);
  return one.length === two.length && timingSafeEqual(one, two);
}

/**
 * All outward actions are written to durable SQLite BEFORE making a vendor request.
 * Crashed or timed-out requests become unknown and are NEVER automatically replayed.
 * Only sanitized action arguments and outcome counts are persisted.
 */
export class MagpieOperationJournal {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(baseDir: string, now: () => number = Date.now) {
    mkdirSync(join(baseDir, 'host'), { recursive: true });
    this.db = new DatabaseSync(join(baseDir, 'host', 'magpie-operations.sqlite'));
    this.now = now;
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    this.db.exec('CREATE TABLE IF NOT EXISTS magpie_operations (' +
      'id TEXT PRIMARY KEY, session_id TEXT NOT NULL, approval_token TEXT NOT NULL, ' +
      'action TEXT NOT NULL, body_json TEXT NOT NULL, status TEXT NOT NULL, ' +
      'requested_at TEXT NOT NULL, expires_at TEXT NOT NULL, started_at TEXT, ' +
      'completed_at TEXT, result_json TEXT, reason TEXT, resolution TEXT, evidence TEXT, reconciled_by TEXT, ' +
      'risk TEXT, actor_sid TEXT, windows_approved_at TEXT)');
    const existing = new Set((this.db.prepare('PRAGMA table_info(magpie_operations)').all() as { name: string }[]).map((c) => c.name));
    for (const name of ['risk', 'actor_sid', 'windows_approved_at']) {
      if (!existing.has(name)) this.db.exec('ALTER TABLE magpie_operations ADD COLUMN ' + name + ' TEXT');
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS magpie_operations_recent ON magpie_operations(requested_at DESC)');
    this.db.prepare("UPDATE magpie_operations SET status='unknown', reason='interrupted_before_receipt', completed_at=? WHERE status='executing'")
      .run(new Date(this.now()).toISOString());
    this.db.prepare("UPDATE magpie_operations SET status='expired', reason='session_ended' WHERE status='prepared'").run();
  }

  private row(id: string): Row | undefined {
    return this.db.prepare('SELECT * FROM magpie_operations WHERE id = ?').get(id) as Row | undefined;
  }

  list(): MagpieOperationView[] {
    const rows = this.db.prepare('SELECT * FROM magpie_operations ORDER BY requested_at DESC LIMIT 30').all() as unknown as Row[];
    return rows.map(safeView);
  }

  get(id: string): MagpieOperationView | undefined {
    const value = this.row(id);
    return value ? safeView(value) : undefined;
  }

  prepare(sessionId: string, action: string, body: unknown, actorSid = 'local_test'): MagpiePreparationView {
    const validated = validateMagpieAction(action, body);
    const bodyJson = JSON.stringify(validated);
    this.db.prepare("UPDATE magpie_operations SET status='expired', reason='approval_expired' WHERE status='prepared' AND expires_at <= ?")
      .run(new Date(this.now()).toISOString());
    const conflict = this.db.prepare(
      "SELECT id FROM magpie_operations WHERE action = ? AND body_json = ? AND status IN ('prepared','executing','unknown') LIMIT 1"
    ).get(action, bodyJson);
    if (conflict) throw new MagpieOperationError(409, 'magpie_operation_requires_review');
    const id = randomUUID();
    const token = randomBytes(24).toString('base64url');
    const requested = new Date(this.now()).toISOString();
    const expires = new Date(this.now() + 120_000).toISOString();
    this.db.prepare(
      'INSERT INTO magpie_operations(id,session_id,approval_token,action,body_json,status,requested_at,expires_at,risk,actor_sid) VALUES(?,?,?,?,?,?,?,?,?,?)'
    ).run(id, sessionId, approvalVerifier(token), action, bodyJson, 'prepared', requested, expires, magpieActionRisk(action), actorSid);
    return { operation: safeView(this.row(id)!), approvalToken: token };
  }

  inspectApproval(id: string, sessionId: string, token: string, actorSid = 'local_test'): MagpieOperationView {
    const row = this.row(id);
    if (!row) throw new MagpieOperationError(404, 'magpie_operation_not_found');
    if (row.session_id !== sessionId) throw new MagpieOperationError(403, 'magpie_operation_session_rejected');
    if (typeof token !== 'string' || !equalToken(row.approval_token, token)) {
      throw new MagpieOperationError(403, 'magpie_operation_approval_rejected');
    }
    if (row.actor_sid && row.actor_sid !== actorSid) {
      throw new MagpieOperationError(403, 'magpie_windows_account_changed');
    }
    if (row.status === 'prepared' && Date.parse(row.expires_at) <= this.now()) {
      this.db.prepare("UPDATE magpie_operations SET status='expired', reason='approval_expired' WHERE id=? AND status='prepared'").run(id);
      return this.get(id)!;
    }
    return safeView(row);
  }

  cancelBeforeExecution(id: string, sessionId: string, token: string, actorSid = 'local_test'): MagpieOperationView {
    const checked = this.inspectApproval(id, sessionId, token, actorSid);
    if (checked.status === 'prepared') {
      this.db.prepare("UPDATE magpie_operations SET status='cancelled', reason='windows_confirmation_declined', completed_at=? WHERE id=? AND status='prepared'")
        .run(new Date(this.now()).toISOString(), id);
    }
    return this.get(id)!;
  }

  // A second approval returns the stored receipt; it cannot re-send the request.
  begin(id: string, sessionId: string, token: string, actorSid = 'local_test', windowsConfirmed = false): {
    execute: boolean; action?: string; body?: Record<string, unknown>; operation: MagpieOperationView
  } {
    const checked = this.inspectApproval(id, sessionId, token, actorSid);
    if (checked.status !== 'prepared') return { execute: false, operation: checked };
    if (checked.risk === 'high' && !windowsConfirmed) throw new MagpieOperationError(403, 'magpie_windows_confirmation_required');
    const row = this.row(id)!;
    const started = new Date(this.now()).toISOString();
    const changed = this.db.prepare(
      "UPDATE magpie_operations SET status='executing', started_at=?, windows_approved_at=? WHERE id=? AND status='prepared'"
    ).run(started, windowsConfirmed ? started : null, id);
    if (changed.changes !== 1) return { execute: false, operation: this.get(id)! };
    return { execute: true, action: row.action, body: JSON.parse(row.body_json) as Record<string, unknown>, operation: this.get(id)! };
  }

  complete(id: string, result: MagpieActionView): MagpieOperationView {
    const status: MagpieOperationStatus = result.result === 'partial' ? 'partial' :
      result.result === 'needs_attention' ? 'needs_attention' :
      result.result === 'no_accounts' ? 'no_accounts' :
      result.result === 'failed' || result.completed === false ? 'failed' : 'succeeded';
    const sanitized: MagpieActionView = {
      action: result.action, completed: result.completed, checkedAt: result.checkedAt,
      ...(result.result ? { result: result.result } : {}),
      ...(result.checkin ? { checkin: result.checkin } : {})
    };
    this.db.prepare(
      "UPDATE magpie_operations SET status=?, completed_at=?, result_json=? WHERE id=? AND status='executing'"
    ).run(status, new Date(this.now()).toISOString(), JSON.stringify(sanitized), id);
    return this.get(id)!;
  }

  uncertain(id: string): MagpieOperationView {
    this.db.prepare(
      "UPDATE magpie_operations SET status='unknown', completed_at=?, reason='upstream_result_unknown' WHERE id=? AND status='executing'"
    ).run(new Date(this.now()).toISOString(), id);
    return this.get(id)!;
  }

  reconcile(id: string, resolution: unknown, evidence: unknown, actorSessionId: string): MagpieOperationView {
    if (resolution !== 'succeeded' && resolution !== 'not_executed') throw new MagpieOperationError(400, 'invalid_magpie_resolution');
    if (typeof evidence !== 'string' || evidence.trim().length < 8 || evidence.length > 500) {
      throw new MagpieOperationError(400, 'invalid_magpie_evidence');
    }
    const row = this.row(id);
    if (!row) throw new MagpieOperationError(404, 'magpie_operation_not_found');
    if (row.status !== 'unknown') throw new MagpieOperationError(409, 'magpie_operation_not_unknown');
    // Evidence remains private: DPAPI protects it under the current Windows user.
    // Never return human-entered evidence in browser DTOs or server logs.
    // An unavailable DPAPI fails closed rather than writing plaintext on Windows.
    const protectedEvidence = process.platform === 'win32'
      ? 'dpapi:' + protectWindowsSecret(evidence.trim())
      : evidence.trim();
    this.db.prepare(
      "UPDATE magpie_operations SET status='reconciled', resolution=?, evidence=?, reconciled_by=?, reason='manually_reconciled', completed_at=? WHERE id=? AND status='unknown'"
    ).run(resolution, protectedEvidence, actorSessionId, new Date(this.now()).toISOString(), id);
    return this.get(id)!;
  }

  close(): void { this.db.close(); }
}
