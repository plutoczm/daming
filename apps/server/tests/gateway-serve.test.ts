import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GatewayServeManager } from '../src/gateway-serve.ts';

function dir() { return mkdtempSync(join(tmpdir(), 'daming gateway serve ')); }

test('gateway serve manager: start / status / stop / reload (fake gateway script)', async () => {
  const d = dir();
  try {
    const script = join(d, 'fake-gateway.mjs');
    writeFileSync(script, "console.log('daming-gateway on http://127.0.0.1:' + process.env.DAMING_GATEWAY_PORT); setInterval(()=>{}, 1000);\n");
    const providersFile = join(d, 'providers.json');
    writeFileSync(providersFile, JSON.stringify({ providers: [] }));

    const manager = new GatewayServeManager({ scriptPath: script, providersFile, port: 3499, readyTimeoutMs: 8000 });
    assert.equal(manager.status().state, 'stopped');
    const started = await manager.start();
    assert.equal(started.state, 'running');
    assert.equal(started.port, 3499);
    assert.equal(started.providersFile, providersFile);

    const stopped = await manager.stop();
    assert.equal(stopped.state, 'stopped');

    const reloaded = await manager.reload();
    assert.equal(reloaded.state, 'running');
    await manager.stop();
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 }); }
});

test('gateway serve manager: failing script rejects and reports failed', async () => {
  const d = dir();
  try {
    const script = join(d, 'bad-gateway.mjs');
    writeFileSync(script, 'process.exit(3);\n');
    const providersFile = join(d, 'providers.json');
    writeFileSync(providersFile, '{}');
    const manager = new GatewayServeManager({ scriptPath: script, providersFile, port: 3498, readyTimeoutMs: 5000 });
    await assert.rejects(() => manager.start());
    assert.equal(manager.status().state, 'failed');
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 }); }
});
