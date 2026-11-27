import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExecutionEventView, ExecutionNodeView } from '@daming/contracts';
import {
  animatableEvents, columnOf, edgePath, groupNodes, modelLabel, takeNewEventIds
} from '../src/execution-graph-view.ts';

function node(overrides: Partial<ExecutionNodeView>): ExecutionNodeView {
  return {
    nodeId: 'node', kind: 'agent', label: 'agent', detail: null, state: 'pending',
    stepId: null, assignmentId: null, attempt: null, runtime: null,
    providerId: null, modelId: null, tokens: null, costMinor: null,
    lastEventType: null, lastEventAt: null, error: null, evidence: ['task'], unknown: [],
    ...overrides
  };
}

function event(eventId: string, nodeId: string | null): ExecutionEventView {
  return { eventId, at: '2026-11-22T10:00:00.000Z', type: 'task_transitioned', label: '状态变更', nodeId, state: 'running', source: 'task' };
}

test('nodes land in the four reading columns', () => {
  assert.equal(columnOf('goal'), 'origin');
  assert.equal(columnOf('planner'), 'origin');
  assert.equal(columnOf('handoff'), 'origin');
  assert.equal(columnOf('agent'), 'agents');
  assert.equal(columnOf('tool'), 'actions');
  assert.equal(columnOf('artifact'), 'actions');
  assert.equal(columnOf('review'), 'outcome');
  assert.equal(columnOf('delivery'), 'outcome');

  const grouped = groupNodes([
    node({ nodeId: 'goal', kind: 'goal' }),
    node({ nodeId: 'agent:s1', kind: 'agent' }),
    node({ nodeId: 'tool:a1', kind: 'tool' }),
    node({ nodeId: 'review:a1', kind: 'review' }),
    node({ nodeId: 'delivery', kind: 'delivery' })
  ]);
  assert.deepEqual(grouped.origin.map((item) => item.nodeId), ['goal']);
  assert.deepEqual(grouped.agents.map((item) => item.nodeId), ['agent:s1']);
  assert.deepEqual(grouped.actions.map((item) => item.nodeId), ['tool:a1']);
  assert.deepEqual(grouped.outcome.map((item) => item.nodeId), ['review:a1', 'delivery']);
});

test('the first snapshot marks history as played, later snapshots only animate new events', () => {
  const seen = new Set<string>();
  const first = [event('task:t1:1', 'orchestrator'), event('task:t1:2', 'planner')];
  assert.deepEqual(takeNewEventIds(first, seen), ['task:t1:1', 'task:t1:2']);

  // Same persisted history on the next poll: nothing to replay.
  assert.deepEqual(takeNewEventIds(first, seen), []);

  const withNew = [...first, event('task:t1:3', 'orchestrator')];
  assert.deepEqual(takeNewEventIds(withNew, seen), ['task:t1:3']);
  // Repeated refreshes never emit the same event twice.
  assert.deepEqual(takeNewEventIds(withNew, seen), []);
});

test('only events that point at a rendered node become flights', () => {
  const nodes = new Set(['orchestrator', 'planner']);
  const events = [event('e1', 'orchestrator'), event('e2', null), event('e3', 'missing-node')];
  assert.deepEqual(animatableEvents(events, nodes).map((item) => item.eventId), ['e1']);
});

test('model labels never invent a provider', () => {
  assert.equal(modelLabel(node({ providerId: 'workbuddy', modelId: 'deepseek-v4-pro' })), 'workbuddy/deepseek-v4-pro');
  assert.equal(modelLabel(node({ providerId: 'deepseek', modelId: 'deepseek/deepseek-chat' })), 'deepseek/deepseek-chat');
  assert.equal(modelLabel(node({ modelId: 'glm-5.3' })), 'glm-5.3');
  assert.equal(modelLabel(node({})), '未接入供应商模型');
});

test('edge paths stay inside the stage for right-to-left geometry', () => {
  const forward = edgePath({ x: 10, y: 20 }, { x: 210, y: 120 });
  assert.match(forward, /^M 10 20 C 94 20, 126 120, 210 120$/);
  // A wrapped layout (target left of source) still uses a bounded control distance.
  const backward = edgePath({ x: 300, y: 10 }, { x: 20, y: 200 });
  assert.match(backward, /^M 300 10 C 348 10, -28 200, 20 200$/);
});