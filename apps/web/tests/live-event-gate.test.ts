import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInvalidationGate, parseInvalidation } from '../src/live-event-gate.ts';

test('gate applies each Host sequence at most once', () => {
  const gate = createInvalidationGate();
  assert.equal(gate.accept({ scope: 'tasks', seq: 1 }), true);
  assert.equal(gate.accept({ scope: 'tasks', seq: 2 }), true);
  // A replayed buffer (same or older sequence) must not trigger another refetch.
  assert.equal(gate.accept({ scope: 'tasks', seq: 2 }), false);
  assert.equal(gate.accept({ scope: 'tasks', seq: 1 }), false);
  assert.equal(gate.accept({ scope: 'gateway', seq: 3 }), true);
  assert.equal(gate.cursor, 3);
});

test('gate rejects malformed sequences and re-anchors on reconnect without rewinding', () => {
  const gate = createInvalidationGate();
  assert.equal(gate.accept({ scope: 'tasks', seq: Number.NaN }), false);
  assert.equal(gate.accept({ scope: 'tasks', seq: 0 }), false);
  assert.equal(gate.accept({ scope: 'tasks', seq: -4 }), false);

  gate.accept({ scope: 'tasks', seq: 10 });
  // Reconnect: `ready` reports the Host's current sequence; only newer frames pass.
  gate.reset(10);
  assert.equal(gate.accept({ scope: 'tasks', seq: 10 }), false);
  assert.equal(gate.accept({ scope: 'tasks', seq: 11 }), true);

  // A Host restart reuses low numbers; the cursor must never move backwards.
  gate.reset(1);
  assert.equal(gate.cursor, 11);
  assert.equal(gate.accept({ scope: 'tasks', seq: 5 }), false);
  assert.equal(gate.accept({ scope: 'tasks', seq: 12 }), true);
});

test('payload parsing ignores unknown keys and malformed frames', () => {
  const parsed = parseInvalidation(JSON.stringify({ scope: 'providers', seq: 7, revision: 2, resource: 'provider', at: 'now', secret: 'nope' }));
  assert.deepEqual(parsed, { scope: 'providers', seq: 7, revision: 2, resource: 'provider', at: 'now' });
  assert.equal(parseInvalidation('not json'), null);
  assert.equal(parseInvalidation(JSON.stringify({ scope: 3, seq: 1 })), null);
  assert.equal(parseInvalidation(JSON.stringify({ scope: 'tasks' })), null);
  assert.equal(parseInvalidation('null'), null);
});