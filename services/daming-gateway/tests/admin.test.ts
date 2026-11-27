import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGatewayServer, listen } from '../src/index.ts';

test('gateway admin: /api/accounts, /api/plugins, /admin render', async () => {
  const h = createGatewayServer({ models: ['m'], pluginsDir: process.cwd() + '/examples/plugins' });
  const base = await listen(h, 0);
  try {
    const acc = await (await fetch(base + '/api/accounts')).json() as { accounts: unknown[] };
    assert.ok(Array.isArray(acc.accounts));
    const pl = await (await fetch(base + '/api/plugins')).json() as { plugins: unknown[] };
    assert.ok(Array.isArray(pl.plugins));
    assert.ok((pl.plugins as unknown[]).length >= 1);
    const admin = await (await fetch(base + '/admin')).text();
    assert.ok(admin.includes('Daming Admin') && admin.includes('Accounts') && admin.includes('Plugins') && admin.includes('Model catalog'));
  } finally { await h.close(); }
});
