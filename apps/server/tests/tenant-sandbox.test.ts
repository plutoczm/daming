import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runIsolatedTenantInspect, TENANT_BWRAP_PREFIX } from '../src/tenant-sandbox.ts';

test('isolated tenant offline worker runs in a new no-network WSL namespace', {
  skip: process.platform !== 'win32' ? 'Windows WSL2 only' : false
}, async () => {
  const text = '任务甲\nSecond line with checks';
  const result = await runIsolatedTenantInspect(text, { timeoutMs: 20000 });
  assert.deepEqual(result, {
    runtime: 'wsl2-bubblewrap', agent: 'offline-inspector',
    tenantScoped: true, allowedExternalTools: false,
    modelCallsEnabled: false, verified: true,
    networkBlocked: true, windowsDrivesHidden: true, homeHidden: true,
    hostConfigHidden: true, unprivileged: true, ephemeralFilesystem: true,
    inspectedCharacters: Array.from(text).length,
    inspectedUtf8Bytes: Buffer.byteLength(text, 'utf8'), lineCount: 2
  });
  assert.deepEqual(await runIsolatedTenantInspect('', { timeoutMs: 20000 })
    .then(x => ({ inspectedCharacters: x.inspectedCharacters,
      ephemeralFilesystem: x.ephemeralFilesystem })),
    { inspectedCharacters: 0, ephemeralFilesystem: true });
});

test('fixed arguments cannot interpolate tenant content, network or host dirs', async () => {
  const joined = TENANT_BWRAP_PREFIX.join(' ');
  assert.match(joined, /--unshare-net/);
  assert.match(joined, /--die-with-parent/);
  assert.match(joined, /--clearenv/);
  assert.match(joined, /--tmpfs \/tmp/);
  assert.ok(!joined.includes('--bind /mnt'));
  assert.ok(!joined.includes('api.openai.com'));
  assert.ok(!joined.includes('api.deepseek.com'));
  assert.ok(!joined.includes('serve --web'));
  await assert.rejects(runIsolatedTenantInspect('x'.repeat(2049)),
    /tenant_sandbox_input_invalid/);
});
