import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MagpieOperationJournal } from '../src/magpie-operations.ts';
import { unprotectWindowsSecret } from '../src/windows-secret.ts';

test('Magpie operation approval is bound to session, one-time, durable, and redacted', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'daming-op-'));
  t.after(() => rmSync(dir, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 }));
  const db = new MagpieOperationJournal(dir);
  const prepared = db.prepare('session-a', 'plugin-add', { spec: '@magpie-community/opencode-workbuddy-auth' });
  assert.equal(prepared.operation.status, 'prepared');
  const reader = new DatabaseSync(join(dir, 'host', 'magpie-operations.sqlite'));
  const storedToken = reader.prepare('SELECT approval_token FROM magpie_operations WHERE id=?').get(prepared.operation.id) as { approval_token: string };
  assert.ok(storedToken.approval_token.startsWith('s2.'));
  assert.notEqual(storedToken.approval_token, prepared.approvalToken);
  reader.close();
  assert.throws(() => db.prepare('session-b', 'plugin-add', { spec: '@magpie-community/opencode-workbuddy-auth' }), /magpie_operation_requires_review/);
  assert.throws(() => db.begin(prepared.operation.id, 'session-b', prepared.approvalToken), /session_rejected/);
  assert.throws(() => db.begin(prepared.operation.id, 'session-a', 'invalid'), /approval_rejected/);
  assert.equal(prepared.operation.risk, 'high');
  assert.throws(() => db.begin(prepared.operation.id, 'session-a', prepared.approvalToken), /magpie_windows_confirmation_required/);
  const first = db.begin(prepared.operation.id, 'session-a', prepared.approvalToken, 'local_test', true);
  assert.equal(first.execute, true);
  assert.equal(first.body?.spec, '@magpie-community/opencode-workbuddy-auth');
  const duplicate = db.begin(prepared.operation.id, 'session-a', prepared.approvalToken);
  assert.equal(duplicate.execute, false);
  assert.equal(duplicate.operation.status, 'executing');
  const done = db.complete(prepared.operation.id, { action: 'plugin-add', completed: true, checkedAt: new Date().toISOString(), result: 'succeeded' });
  assert.equal(done.status, 'succeeded');
  assert.equal(db.begin(prepared.operation.id, 'session-a', prepared.approvalToken).execute, false);
  const serialized = JSON.stringify(db.list());
  assert.doesNotMatch(serialized, /approvalToken|approval_token|session-a|session_id/);
  db.close();
  const reopened = new MagpieOperationJournal(dir);
  assert.equal(reopened.get(prepared.operation.id)?.status, 'succeeded');
  reopened.close();
});

test('Magpie interrupted calls remain unknown after restart; human reconciliation removes retry block', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'daming-op-crash-'));
  t.after(() => rmSync(dir, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 }));
  let db = new MagpieOperationJournal(dir);
  const created = db.prepare('s', 'workbuddy-checkin', {});
  assert.equal(db.begin(created.operation.id, 's', created.approvalToken, 'local_test', true).execute, true);
  db.close();
  db = new MagpieOperationJournal(dir);
  assert.equal(db.get(created.operation.id)?.status, 'unknown');
  assert.throws(() => db.prepare('s2', 'workbuddy-checkin', {}), /magpie_operation_requires_review/);
  const late = db.begin(created.operation.id, 's', created.approvalToken);
  assert.equal(late.execute, false);
  assert.equal(late.operation.status, 'unknown');
  assert.throws(() => db.reconcile(created.operation.id, 'not_executed', 'short', 's2'), /invalid_magpie_evidence/);
  const reconciled = db.reconcile(created.operation.id, 'not_executed', 'Verified upstream records before retry', 's2');
  assert.equal(reconciled.status, 'reconciled');
  assert.equal(reconciled.resolution, 'not_executed');
  assert.doesNotMatch(JSON.stringify(reconciled), /Verified upstream/);
  const check = new DatabaseSync(join(dir, 'host', 'magpie-operations.sqlite'));
  const stored = check.prepare('SELECT evidence FROM magpie_operations WHERE id=?').get(created.operation.id) as { evidence: string };
  if (process.platform === 'win32') {
    assert.ok(stored.evidence.startsWith('dpapi:'));
    assert.doesNotMatch(stored.evidence, /Verified upstream/);
    assert.equal(unprotectWindowsSecret(stored.evidence.slice(6)), 'Verified upstream records before retry');
  } else {
    assert.equal(stored.evidence, 'Verified upstream records before retry');
  }
  check.close();
  assert.equal(db.prepare('s2', 'workbuddy-checkin', {}).operation.status, 'prepared');
  db.close();
});

test('Magpie expired approval cannot execute, but a new one can be prepared', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'daming-op-expiry-'));
  t.after(() => rmSync(dir, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 }));
  let tick = 1_700_000_000_000;
  const db = new MagpieOperationJournal(dir, () => tick);
  const prepared = db.prepare('s', 'plugin-check', {});
  tick += 120_001;
  assert.equal(db.begin(prepared.operation.id, 's', prepared.approvalToken).operation.status, 'expired');
  assert.equal(db.prepare('s', 'plugin-check', {}).operation.status, 'prepared');
  db.close();
});

test('Magpie check-in mixed outcomes are persisted as a safe partial receipt', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'daming-op-checkin-'));
  t.after(() => rmSync(dir, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 }));
  const db = new MagpieOperationJournal(dir);
  const p = db.prepare('s', 'workbuddy-checkin', {});
  db.begin(p.operation.id, 's', p.approvalToken, 'local_test', true);
  const result = db.complete(p.operation.id, {
    action: 'workbuddy-checkin', completed: true, checkedAt: new Date().toISOString(), result: 'partial',
    checkin: { total: 3, claimed: 2, already: 0, captcha: 1, failed: 0, other: 0, creditsReported: 200 }
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.checkin?.claimed, 2);
  assert.equal(result.checkin?.captcha, 1);
  db.close();
});

test('high-risk Magpie actions require same Windows SID and explicit native approval', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'daming-highrisk-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const db = new MagpieOperationJournal(dir);
  const approval = db.prepare('browser-session', 'plugin-toggle', { spec: '@trusted/example', off: true }, 'windows-user-1');
  assert.equal(approval.operation.risk, 'high');
  assert.throws(() =>
    db.inspectApproval(approval.operation.id, 'browser-session', approval.approvalToken, 'windows-user-2'),
    /magpie_windows_account_changed/
  );
  assert.throws(() =>
    db.begin(approval.operation.id, 'browser-session', approval.approvalToken, 'windows-user-1', false),
    /magpie_windows_confirmation_required/
  );
  const cancelled = db.cancelBeforeExecution(approval.operation.id, 'browser-session', approval.approvalToken, 'windows-user-1');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(db.begin(approval.operation.id, 'browser-session', approval.approvalToken, 'windows-user-1', true).execute, false);
  assert.equal(db.prepare('another-session', 'plugin-toggle', { spec: '@trusted/example', off: true }, 'windows-user-1').operation.status, 'prepared');
  db.close();
});

test('existing Magpie journals upgrade risk and SID columns without losing old rows', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'daming-legacy-journal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  mkdirSync(join(dir, 'host'), { recursive: true });
  const dbPath = join(dir, 'host', 'magpie-operations.sqlite');
  const old = new DatabaseSync(dbPath);
  old.exec('CREATE TABLE magpie_operations(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,approval_token TEXT NOT NULL,action TEXT NOT NULL,body_json TEXT NOT NULL,status TEXT NOT NULL,requested_at TEXT NOT NULL,expires_at TEXT NOT NULL,started_at TEXT,completed_at TEXT,result_json TEXT,reason TEXT,resolution TEXT,evidence TEXT,reconciled_by TEXT)');
  old.prepare('INSERT INTO magpie_operations(id,session_id,approval_token,action,body_json,status,requested_at,expires_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('legacy-id', 's', 'token', 'plugin-check', '{}', 'succeeded', new Date().toISOString(), new Date().toISOString());
  old.close();
  const upgraded = new MagpieOperationJournal(dir);
  assert.equal(upgraded.get('legacy-id')?.status, 'succeeded');
  assert.equal(upgraded.get('legacy-id')?.risk, 'medium');
  upgraded.close();
});
