import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanAccounts } from '../src/index.ts';

test('scanAccounts: logins.json (codex oauth) + plugin-auth.json (kiro/zcode/workbuddy)', () => {
  const d = mkdtempSync(join(tmpdir(), 'acct-'));
  try {
    writeFileSync(join(d, 'logins.json'), JSON.stringify([
      { agent: 'codex', auth: { tokens: { access_token: 'at', refresh_token: 'rt', account_id: 'acct-1', expires_at: 123 } } },
    ]));
    writeFileSync(join(d, 'plugin-auth.json'), JSON.stringify({
      kiro: { access: 'k', refresh: 'rk', type: 'oauth', region: 'us-east-1', profileArn: 'arn:...' },
      zcode: { access: 'z', type: 'oauth', accountId: 'ZCode' },
      'workbuddy#tnpqwu': { access: 'w', domain: 'www.workbuddy.cn', accountId: 'wb2' },
    }));
    const { accounts, errors } = scanAccounts({ magpieDir: d });
    assert.deepEqual(errors, []);
    const codex = accounts.find((a) => a.provider === 'codex')!;
    assert.equal(codex.hasAccess, true); assert.equal(codex.hasRefresh, true); assert.equal(codex.accountId, 'acct-1');
    assert.equal(accounts.find((a) => a.provider === 'kiro')!.hasRefresh, true);
    assert.equal(accounts.find((a) => a.provider === 'zcode')!.accountId, 'ZCode');
    const wb = accounts.find((a) => a.id === 'workbuddy#tnpqwu')!;
    assert.equal(wb.provider, 'workbuddy'); assert.equal(wb.accountId, 'wb2');
    assert.equal(accounts.length, 4);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('scanAccounts: missing files → empty + no throw', () => {
  const d = mkdtempSync(join(tmpdir(), 'acct-'));
  try { const r = scanAccounts({ magpieDir: d }); assert.deepEqual(r.accounts, []); }
  finally { rmSync(d, { recursive: true, force: true }); }
});
