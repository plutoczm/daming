import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeOperation } from '../src/binding.ts';
import type { ToolOperation } from '../src/model.ts';

function localOperation(): ToolOperation {
  return {
    id: 'local-op', taskId: 'task', runId: 'run', attemptId: 'attempt',
    executorKind: 'local', toolId: 'workflow.real', toolVersion: '1', target: 'real',
    payload: { stepId: 'outline' }, amountMinor: 0, quoteId: 'quote',
    route: { mode: 'native', provider: 'local', model: 'none', accountRef: 'local' }
  };
}

test('local executor can only be bound to the fixed governed local workflow', () => {
  const allowed = localOperation();
  assert.deepEqual(normalizeOperation(allowed), allowed);
  for (const changed of [
    { ...allowed, toolId: 'native.shell' },
    { ...allowed, toolId: 'native.filesystem' },
    { ...allowed, target: 'external-path' },
    { ...allowed, route: { ...allowed.route, mode: 'magpie' as const } },
    { ...allowed, route: { ...allowed.route, provider: 'deepseek' } },
    { ...allowed, route: { ...allowed.route, accountRef: 'codex' } }
  ]) {
    assert.throws(() => normalizeOperation(changed), /local_executor_scope_invalid/);
  }
});
