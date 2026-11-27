import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAutoloopService } from '../src/autoloop-service.ts';

test('vendored Autoloop kernel ingests an event, routes it and completes a run', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'daming autoloop '));
  const service = createAutoloopService({ dataDir: dir });
  t.after(() => { service.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const initial = service.state();
  assert.equal(initial.sources.length, 1);
  assert.equal(initial.agents.length, 4);
  assert.equal(initial.rules.length, 4);
  assert.ok(initial.agents.some((agent) => agent.id === 'mission' && agent.use === 'mission'));
  const emitted = await service.emit({ id: 'evt-1', type: 'task.requested', subject: 'demo', summary: '流程演示事件' });
  assert.deepEqual(emitted.routed, ['手动测试']);
  assert.equal(emitted.duplicate, false);
  const after = service.state();
  assert.equal(after.totals.done, 1);
  assert.equal(after.runs[0].state, 'done');
  assert.match(after.runs[0].summary ?? '', /流程演示事件/);
  const duplicate = await service.emit({ id: 'evt-1', type: 'task.requested', subject: 'demo', summary: '重复事件' });
  assert.equal(duplicate.duplicate, true);
});
