import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readQuotas } from '../src/index.ts';

test('readQuotas: non-workbuddy providers → unknown (no network)', async () => {
  const d = mkdtempSync(join(tmpdir(), 'q-'));
  try {
    writeFileSync(join(d, 'plugin-auth.json'), JSON.stringify({ zcode: { access: 'z' }, kiro: { access: 'k' } }));
    const q = await readQuotas({ magpieDir: d });
    assert.equal(q.length, 2);
    assert.ok(q.every((e) => e.unknown === true));
    assert.deepEqual(q.map((e) => e.provider).sort(), ['kiro', 'zcode']);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('readQuotas: empty config → []', async () => {
  const d = mkdtempSync(join(tmpdir(), 'q-'));
  try { assert.deepEqual(await readQuotas({ magpieDir: d }), []); }
  finally { rmSync(d, { recursive: true, force: true }); }
});
