import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createMagpieHost } from '../src/magpie-host.ts';

test('subscription preparation refuses a binary without read-only login capability', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'daming subscription readiness '));
  let readOnly = false;
  const upstream = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/hello') res.end(JSON.stringify({ name: 'magpie' }));
    else if (req.url === '/api/groups') res.end('[]');
    else if (req.url === '/v1/magpie/daming-task-scope') {
      res.end(JSON.stringify({ schemaVersion: 1, fixedAccount: true, singleUpstream: true,
        revokedLocalKeyFailsClosed: true, codexPersonalLoginReadOnly: readOnly }));
    } else if (req.url === '/api/caller-keys/models') {
      res.end(JSON.stringify({ models: [{ id: 'codex/gpt-6.1-sol', provider: 'codex' }],
        accounts: [{ id: 'codex/0123456789abcdef', provider: 'codex', account: true }] }));
    } else { res.statusCode = 404; res.end('{}'); }
  });
  const port = await listen(upstream);
  const admin = createServer((req, res) => { upstream.emit('request', req, res); });
  const adminPort = await listen(admin);
  t.after(async () => { await close(admin); await close(upstream); rmSync(dir, { recursive: true, force: true }); });
  writeFileSync(join(dir, 'instance.json'), JSON.stringify({ version: 2, port, adminPort,
    adminKey: 'test-magpie-readonly-key-0123456789', instanceId: 'a'.repeat(32), dataDir: dir }));
  const host = createMagpieHost({ dataDir: dir });
  await assert.rejects(host.codexSubscriptionBinding!('gpt-6.1-sol'), /scope_binary_outdated/);
  readOnly = true;
  assert.equal((await host.codexSubscriptionBinding!('gpt-6.1-sol')).accountRef, '0123456789abcdef');
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test('Magpie host reports missing binary without launching a process', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'daming magpie host '));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const host = createMagpieHost({ dataDir: dir, binary: join(dir, 'missing.exe'), port: 3499 });
  const status = await host.ensure();
  assert.equal(status.enabled, false);
  assert.equal(status.running, false);
  assert.equal(status.reason, 'binary_missing');
});

test('Magpie Host authenticates the private admin service and never forwards secret fields', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'daming magpie secure '));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const KEY = 'test-magpie-admin-key-0123456789';
  let adminPort = 0;
  const seen: string[] = [];
  const gateway = createServer((req, res) => {
    seen.push((req.method ?? '') + ' ' + req.url);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/hello') res.end(JSON.stringify({ name: 'magpie', version: 'v1' }));
    else if (req.url === '/v1/models') res.end(JSON.stringify({ data: [{ id: 'model-safe' }, { id: 'model-other' }], apiKey: 'secret-gw' }));
    else if (req.url === '/v1/magpie/quotas/cards') res.end(JSON.stringify({ cards: [{ id: 'private-user@provider.example' }] }));
    else if (req.url === '/v1/magpie/quotas/refresh' && req.method === 'POST') res.end(JSON.stringify({ cookies: 'private-cookie' }));
    else { res.statusCode = 404; res.end('{}'); }
  });
  const port = await listen(gateway);
  t.after(async () => close(gateway));
  const admin = createServer((req, res) => {
    seen.push((req.method ?? '') + ' ' + req.url);
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.cookie !== 'magpie_web_' + adminPort + '=' + KEY) {
      res.statusCode = 401;
      res.end('{}');
      return;
    }
    if (req.url === '/api/groups') res.end(JSON.stringify([{ name: 'Safe group' }]));
    else if (req.url === '/api/providers') res.end(JSON.stringify([{ name: 'private@provider.example', apiKey: 'ultra-secret-key', token: 'ultra-secret-token' }]));
    else if (req.url === '/api/plugins/check' && req.method === 'POST') res.end(JSON.stringify({ plugins: [{ apiKey: 'secret-from-action' }] }));
    else if (req.url === '/api/usage/quotas?asked=1&all=1' && req.method === 'GET') res.end('[]');
    else if (req.url === '/api/plugins') res.end(JSON.stringify({ plugins: [{ spec: 'safe-plugin', off: false }] }));
    else if (req.url === '/api/plugins/off' && req.method === 'POST') res.end('{}');
    else if (req.url === '/api/plugins/add' && req.method === 'POST') res.end('{}');
    else { res.statusCode = 404; res.end('{}'); }
  });
  adminPort = await listen(admin);
  t.after(async () => close(admin));
  const binary = join(dir, 'dummy.exe');
  writeFileSync(binary, 'dummy');
  writeFileSync(join(dir, 'instance.json'), JSON.stringify({
    version: 2, port, adminPort, adminKey: KEY,
    instanceId: 'a'.repeat(32), dataDir: dir
  }));
  const host = createMagpieHost({ dataDir: dir, binary, port, adminPort });
  const status = await host.status();
  assert.equal(status.running, true);
  assert.equal(status.configured, true);
  const models = await host.read('models');
  assert.equal(models.count, 2);
  assert.deepEqual(models.labels, ['model-safe', 'model-other']);
  const providers = await host.read('providers');
  assert.equal(providers.count, 1);
  assert.deepEqual(providers.labels, []);
  assert.doesNotMatch(JSON.stringify(providers), /ultra-secret|private@|apiKey|token/);
  const groups = await host.read('groups');
  assert.deepEqual(groups.labels, ['Safe group']);
  const cards = await host.read('quota-cards');
  assert.equal(cards.count, 1);
  assert.deepEqual(cards.labels, []);
  await assert.rejects(host.read('private-path'), /unsupported_magpie_path/);
  await assert.rejects(host.post('plugin-add', { spec: 'https://evil.example/plugin.js' }), /invalid_magpie_action_body/);
  await assert.rejects(host.post('plugin-toggle', { spec: 'missing-plugin', off: false }), /magpie_plugin_not_installed/);
  await assert.rejects(host.post('plugin-check', { spec: 'inject' }), /invalid_magpie_action_body/);
  const pending = host.post('plugin-check', {});
  await assert.rejects(host.post('plugin-check', {}), /magpie_action_in_progress/);
  const checked = await pending;
  assert.equal(checked.completed, true);
  assert.doesNotMatch(JSON.stringify(checked), /secret/);
  const refresh = await host.post('refresh-quotas', {});
  assert.equal(refresh.action, 'refresh-quotas');
  assert.equal(seen.filter((call) => call === 'POST /api/plugins/check').length, 1);
  assert.ok(seen.includes('GET /api/usage/quotas?asked=1&all=1'));
  assert.equal((await host.post('plugin-toggle', { spec: 'safe-plugin', off: true })).completed, true);
  assert.equal((await host.post('plugin-add', { spec: '@safe/plugin' })).completed, true);
});

test('Magpie Host refuses to overwrite existing legacy metadata', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'daming magpie legacy '));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const binary = join(dir, 'dummy.exe');
  writeFileSync(binary, 'dummy');
  const original = JSON.stringify({ version: 1, port: 49471, instanceId: 'old', dataDir: dir });
  writeFileSync(join(dir, 'instance.json'), original);
  const host = createMagpieHost({ dataDir: dir, binary, port: 49471, adminPort: 49472 });
  const status = await host.ensure();
  assert.equal(status.configured, false);
  assert.equal(status.reason, 'unmanaged_instance_requires_manual_restart');
  const { readFileSync } = await import('node:fs');
  assert.equal(readFileSync(join(dir, 'instance.json'), 'utf8'), original);
});

test('Magpie migration refuses an active legacy port without changing old files', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'daming magpie busy legacy '));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const binary = join(dir, 'dummy.exe');
  writeFileSync(binary, 'dummy');
  const occupied = createServer((_req, res) => res.end('an unrelated service'));
  const busyPort = await listen(occupied);
  t.after(async () => close(occupied));
  const legacy = JSON.stringify({ version: 1, port: busyPort, instanceId: 'c'.repeat(32), dataDir: dir });
  writeFileSync(join(dir, 'instance.json'), legacy);
  const host = createMagpieHost({ dataDir: dir, binary, port: busyPort, adminPort: busyPort + 1 });
  const status = await host.ensure();
  assert.equal(status.running, false);
  assert.equal(status.configured, false);
  assert.equal(status.reason, 'legacy_ports_in_use');
  const { readFileSync, existsSync } = await import('node:fs');
  assert.equal(readFileSync(join(dir, 'instance.json'), 'utf8'), legacy);
  assert.equal(existsSync(join(dir, 'instance.v1.backup.json')), false);
});

test('real Go check-in outcomes are summarized without exposing account identities or messages', async () => {
  const { summarizeMagpieCheckin } = await import('../src/magpie-host.ts');
  const result = summarizeMagpieCheckin([
    { user: 'private@example.com', outcome: 'claimed', credit: 80, msg: 'private-session' },
    { user: 'other@example.com', outcome: 'done' },
    { user: 'third@example.com', outcome: 'captcha', msg: 'complete private challenge' }
  ]);
  assert.equal(result.result, 'partial');
  assert.equal(result.checkin?.claimed, 1);
  assert.equal(result.checkin?.already, 1);
  assert.equal(result.checkin?.captcha, 1);
  assert.equal(result.checkin?.creditsReported, 80);
  assert.doesNotMatch(JSON.stringify(result), /private|example.com|session|challenge/);
  assert.equal(summarizeMagpieCheckin([]).result, 'no_accounts');
  assert.equal(summarizeMagpieCheckin([{ outcome: 'captcha' }]).result, 'needs_attention');
  assert.equal(summarizeMagpieCheckin([{ outcome: 'failed' }]).result, 'failed');
  assert.throws(() => summarizeMagpieCheckin({ error: 'hidden account details' }), /magpie_invalid_checkin_result/);
});
