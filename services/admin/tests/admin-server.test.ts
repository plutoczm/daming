import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdminServer } from '../src/index.ts';
import { installPlugin } from '../../daming-gateway/src/index.ts';

const ECHO = fileURLToPath(new URL('../../../examples/plugins/echo-provider', import.meta.url));

test('admin server: providers CRUD + plugins enable/disable/remove + accounts/models + /admin', async () => {
  const d = mkdtempSync(join(tmpdir(), 'adm-'));
  const providersFile = join(d, 'providers.json');
  const pluginsDir = join(d, 'plugins');
  installPlugin(ECHO, pluginsDir);
  const h = createAdminServer({ providersFile, pluginsDir, magpieDir: d });
  const base = await h.listen(0);
  try {
    // providers empty
    assert.deepEqual((await (await fetch(base + '/api/providers')).json()).providers, []);
    // add
    let r = await (await fetch(base + '/api/providers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'zcode', api: 'anthropic-messages', baseUrl: 'https://api.z.ai/api/anthropic', models: ['glm-5.3'], apiKeyEnv: 'ZCODE_KEY' }) })).json();
    assert.equal(r.ok, true);
    assert.equal((await (await fetch(base + '/api/providers')).json()).providers.length, 1);
    // models include provider + plugin
    const models = (await (await fetch(base + '/api/models')).json()).models;
    assert.ok(models.includes('glm-5.3') && models.includes('echo-1'));
    // delete
    await fetch(base + '/api/providers?id=zcode', { method: 'DELETE' });
    assert.equal((await (await fetch(base + '/api/providers')).json()).providers.length, 0);
    // plugins: echo present, disable→enable→remove
    let pl = (await (await fetch(base + '/api/plugins')).json()).plugins;
    assert.equal(pl.length, 1); assert.equal(pl[0].manifest.id, 'echo'); assert.equal(pl[0].enabled, true);
    await fetch(base + '/api/plugins/disable?id=echo', { method: 'POST' });
    assert.equal((await (await fetch(base + '/api/plugins')).json()).plugins[0].enabled, false);
    await fetch(base + '/api/plugins/enable?id=echo', { method: 'POST' });
    assert.equal((await (await fetch(base + '/api/plugins')).json()).plugins[0].enabled, true);
    await fetch(base + '/api/plugins/remove?id=echo', { method: 'POST' });
    assert.equal((await (await fetch(base + '/api/plugins')).json()).plugins.length, 0);
    // accounts + quotas (temp magpie dir → empty)
    assert.ok(Array.isArray((await (await fetch(base + '/api/accounts')).json()).accounts));
    assert.ok(Array.isArray((await (await fetch(base + '/api/quotas')).json()).quotas));
    // admin page
    const page = await (await fetch(base + '/admin')).text();
    assert.ok(page.includes('Daming Admin') && page.includes('Providers') && page.includes('Plugins'));
  } finally { await h.close(); rmSync(d, { recursive: true, force: true }); }
});

test('admin server: invalid provider rejected', async () => {
  const d = mkdtempSync(join(tmpdir(), 'adm-'));
  const h = createAdminServer({ providersFile: join(d, 'p.json'), pluginsDir: join(d, 'pl'), magpieDir: d });
  const base = await h.listen(0);
  try {
    const r = await (await fetch(base + '/api/providers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'BAD ID', api: 'nope', baseUrl: 'x', models: [] }) })).json();
    assert.ok(r.error);
  } finally { await h.close(); rmSync(d, { recursive: true, force: true }); }
});
