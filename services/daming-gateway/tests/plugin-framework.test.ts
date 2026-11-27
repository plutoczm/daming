import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGatewayServer, listen, loadPlugins, providerPluginsFromLoaded, validateManifest, listPlugins, setPluginEnabled, pluginDisabled, installPlugin, removePlugin } from '../src/index.ts';

const EXAMPLES = fileURLToPath(new URL('../../../examples/plugins', import.meta.url));

test('loadPlugins loads example provider plugins (echo + workbuddy) and bridges to gateway', async () => {
  const report = await loadPlugins(EXAMPLES);
  const ids = report.loaded.map((p) => p.manifest.id).sort();
  assert.ok(ids.includes('echo'), 'echo plugin discovered');
  assert.ok(ids.includes('workbuddy'), 'workbuddy plugin discovered');
  const bridged = providerPluginsFromLoaded(report.loaded);
  assert.ok(bridged.find((p) => p.id === 'echo')?.models.includes('echo-1'));
});

test('a dropped-in plugin becomes a working model provider through the gateway', async () => {
  const report = await loadPlugins(EXAMPLES);
  const echo = providerPluginsFromLoaded(report.loaded).filter((p) => p.id === 'echo');
  const h = createGatewayServer({ plugins: echo, models: ['echo-1'] });
  const base = await listen(h, 0);
  try {
    const chat = await (await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'echo-1', messages: [{ role: 'user', content: 'hello' }] }) })).json();
    assert.equal(chat.choices[0].message.content, 'ECHO:hello');
  } finally { await h.close(); }
});

test('invalid manifest rejected; duplicate plugin id collected as error', async () => {
  assert.throws(() => validateManifest({ id: 'BAD ID', name: 'x', version: '1', kind: 'provider' }), /plugin_id_invalid/);
  assert.throws(() => validateManifest({ id: 'a', name: 'x', version: '1', kind: 'nope' }), /plugin_kind_invalid/);
  const d = mkdtempSync(join(tmpdir(), 'daming-plug-'));
  try {
    for (const sub of ['a', 'b']) {
      mkdirSync(join(d, sub));
      writeFileSync(join(d, sub, 'plugin.json'), JSON.stringify({ id: 'dup', name: 'x', version: '1', kind: 'provider', models: ['m'] }));
      writeFileSync(join(d, sub, 'index.mjs'), 'export default { async complete(){ return {status:200,contentType:"application/json",bodyText:"{}"}; } };');
    }
    const rep = await loadPlugins(d);
    assert.equal(rep.loaded.length, 1, 'duplicate id loads only once');
    assert.ok(rep.errors.some((e) => e.error.includes('plugin_duplicate_id')));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('plugin manager: list / disable / enable / install / remove', async () => {
  const root = mkdtempSync(join(tmpdir(), 'daming-mkt-'));
  try {
    const dest = installPlugin(fileURLToPath(new URL('../../../examples/plugins/echo-provider', import.meta.url)), root);
    assert.ok(dest.endsWith('echo'));
    let items = listPlugins(root);
    assert.equal(items.length, 1);
    assert.equal(items[0].manifest?.id, 'echo');
    assert.equal(items[0].enabled, true);
    // disable → loadPlugins skips it
    setPluginEnabled(dest, false);
    assert.equal(pluginDisabled(dest), true);
    assert.equal((await loadPlugins(root)).loaded.length, 0);
    assert.equal(listPlugins(root)[0].enabled, false);
    // enable → loads again
    setPluginEnabled(dest, true);
    assert.equal((await loadPlugins(root)).loaded.length, 1);
    // duplicate install rejected; remove works
    assert.throws(() => installPlugin(fileURLToPath(new URL('../../../examples/plugins/echo-provider', import.meta.url)), root), /plugin_exists:echo/);
    removePlugin(root, 'echo');
    assert.equal(listPlugins(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
