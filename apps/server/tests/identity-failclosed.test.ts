import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startBoardHost } from '../src/http.ts';
import type { MagpieHost } from '../src/magpie-host.ts';
import { IdentityRegistry } from '../src/identity-registry.ts';

const TOKEN = 'synthetic-bootstrap-only-credential-001';
const mockMagpie = {
  async ensure() { return { configured: false, running: false, enabled: false, version: 'offline', checkedAt: new Date().toISOString() }; },
  async status() { return { configured: false, running: false, enabled: false, version: 'offline', checkedAt: new Date().toISOString() }; },
  async read() { throw new Error('offline'); },
  async post() { throw new Error('offline'); },
  stop() {}
} as MagpieHost;
const dummy = { protectMaster: (s: string) => 'fixture:' + s,
  unprotectMaster: (s: string) => s.slice(8) };

test('lost identity DB with a completed migration marker cannot restore bootstrap privilege', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daming-identity-fail-closed-'));
  const webRoot = join(dir, 'web');
  mkdirSync(webRoot);
  writeFileSync(join(webRoot, 'index.html'), '<title>fixture</title>');
  const dataDir = join(dir, 'host');
  let host = await startBoardHost({ dataDir, port: 0, bootstrapToken: TOKEN, webRoot, magpie: mockMagpie });
  try {
    const open = await fetch(host.url + '?token=' + TOKEN, { redirect: 'manual' });
    assert.equal(open.status, 302);
    const cookie = open.headers.getSetCookie()[0].split(';')[0];
    const s = await fetch(host.url + 'api/session', { headers: { cookie } });
    const session = await s.json() as { csrfToken: string };
    const setup = await fetch(host.url + 'api/identity/setup', {
      method: 'POST',
      headers: { cookie, origin: new URL(host.url).origin,
        'content-type': 'application/json', 'x-daming-csrf': session.csrfToken },
      body: JSON.stringify({ username: 'rootadmin', password: 'secure-root-password-fixture-2026',
        tenantName: 'Test team' })
    });
    assert.equal(setup.status, 200);
    await host.close();
    unlinkSync(join(dataDir, 'identity', 'identities.db'));
    await assert.rejects(
      startBoardHost({ dataDir, port: 0, bootstrapToken: TOKEN, webRoot, magpie: mockMagpie }),
      /Persistent identity database missing; refusing unsafe legacy bootstrap fallback/
    );
    // Recreating an empty SQLite file must not restore the bootstrap path.
    writeFileSync(join(dataDir, 'identity', 'identities.db'), '');
    await assert.rejects(
      startBoardHost({ dataDir, port: 0, bootstrapToken: TOKEN, webRoot, magpie: mockMagpie }),
      /Persistent root identity missing; refusing legacy bootstrap fallback/
    );
  } finally {
    try { await host.close(); } catch {}
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('unknown usernames are throttled, and throttling persists across registry restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daming-identity-unknown-lock-'));
  let current = Date.now();
  let registry = new IdentityRegistry(dir, { ...dummy, clock: () => current });
  try {
    await registry.setup({ username: 'rootadmin', password: 'secure-root-password-fixture-2026',
      tenantName: 'Test team' });
    for (let i = 0; i < 5; i++) {
      await assert.rejects(registry.login({
        username: 'unknown-user', password: 'incorrect-password-fixture-2026'
      }), /identity_login_failed/);
    }
    await assert.rejects(registry.login({
      username: 'unknown-user', password: 'incorrect-password-fixture-2026'
    }), /identity_login_delayed/);
    registry.close();
    registry = new IdentityRegistry(dir, { ...dummy, clock: () => current });
    await assert.rejects(registry.login({
      username: 'unknown-user', password: 'incorrect-password-fixture-2026'
    }), /identity_login_delayed/);
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
