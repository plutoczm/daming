import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileLuluRunStore } from '../src/lulu-run-store.ts';

test('Lulu evidence store persists completed submissions across reopen', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'daming lulu evidence '));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const file = join(dir, 'lulu', 'runs.json');
  const first = new FileLuluRunStore(file);
  first.save({ runId: 'run-1', status: 'completed', evidence: { bestReply: 'OK' }, completedAt: '2026-11-10T05:00:00.000Z' });
  const reopened = new FileLuluRunStore(file);
  assert.deepEqual(reopened.get('run-1'), {
    runId: 'run-1', status: 'completed', evidence: { bestReply: 'OK' }, completedAt: '2026-11-10T05:00:00.000Z'
  });
});
