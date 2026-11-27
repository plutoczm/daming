import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GatewayRequestView, AgentProfileView, ModelBindingView, TaskDetailView } from '@daming/contracts';
import type { CrewPlan } from '../src/crew-planner.ts';
import { buildExecutionGraph, stepState } from '../src/execution-graph.ts';
import { buildCrewOverview, findCrewContext } from '../src/crew-overview.ts';

const AT = '2026-11-22T10:00:00.000Z';
const LATER = '2026-11-22T10:05:00.000Z';

function detailFixture(overrides: Partial<TaskDetailView> = {}): TaskDetailView {
  return {
    taskId: 'task-graph-1',
    title: '整理本周研究',
    goal: '汇总本周资料，形成研究摘要。',
    status: 'completed',
    createdAt: AT,
    updatedAt: LATER,
    budget: { currency: 'CNY', limitMinor: 500, spentMinor: 120, heldMinor: 0, breached: false },
    progress: { totalSteps: 2, completedSteps: 2, assignmentCount: 2, reviewCount: 2 },
    blockedReason: null,
    plan: {
      planId: 'plan-1', version: 1, category: 'local-delivery', policyVersion: 'policy-1',
      steps: [
        { stepId: 's1', description: '分析资料', workerId: 'local-analyst', dependsOn: [], maxReworks: 1 },
        { stepId: 's2', description: '撰写报告', workerId: 'local-writer', dependsOn: ['s1'], maxReworks: 1 }
      ]
    },
    assignments: [
      {
        assignmentId: 'a1', stepId: 's1', workerId: 'local-analyst', stepAttempt: 1,
        effectStatus: 'succeeded', effectId: 'effect-0001-analyst', deliveryStatus: 'completed', reviewVerdict: 'pass',
        artifactKeys: ['analysis.json'], resultPreview: '{"ok":true}', startedAt: AT, endedAt: LATER
      },
      {
        assignmentId: 'a2', stepId: 's2', workerId: 'local-writer', stepAttempt: 1,
        effectStatus: 'succeeded', effectId: 'effect-0002-writer', deliveryStatus: 'completed', reviewVerdict: 'pass',
        artifactKeys: ['report.md'], resultPreview: '{"ok":true}', startedAt: AT, endedAt: LATER
      }
    ],
    reviews: [
      { assignmentId: 'a1', verdict: 'pass', reasons: [] },
      { assignmentId: 'a2', verdict: 'pass', reasons: [] }
    ],
    decisions: [],
    workerRoutes: [],
    approvals: [],
    reconciliations: [],
    events: [
      { sequence: 1, type: 'task_created', occurredAt: AT, sourceId: 'host:test' },
      { sequence: 2, type: 'workflow_install', occurredAt: AT, sourceId: 'host:test' },
      { sequence: 3, type: 'workflow_assign', occurredAt: AT, sourceId: 'host:test' },
      { sequence: 4, type: 'tool_settled', occurredAt: LATER, sourceId: 'host:test' }
    ],
    audit: [],
    ...overrides
  };
}

function binding(overrides: Partial<ModelBindingView>): ModelBindingView {
  return {
    bindingId: 'binding-1', tenantId: 'tenant-a', agent: 'dsh', modelId: 'deepseek-v4-pro',
    providerId: 'workbuddy', sourceKind: 'subscription', billing: 'quota',
    scope: { kind: 'tenant' }, status: 'active', createdAt: AT,
    ...overrides
  };
}

function gatewayRow(overrides: Partial<GatewayRequestView>): GatewayRequestView {
  return {
    requestId: 'r1', at: LATER, agent: 'dsh', providerId: 'deepseek', modelId: 'deepseek/deepseek-chat',
    status: 'ok', latencyMs: 900, inputTokens: 1000, outputTokens: 200, costMinor: 12, maskedCount: 0,
    attribution: 'unattributed', ...overrides
  };
}

test('graph projects goal → orchestrator → plan → agent → tool → review → artifact → delivery', () => {
  const graph = buildExecutionGraph({
    detail: detailFixture(), crew: null, agents: [], bindings: [], generatedAt: LATER
  });
  const kinds = graph.nodes.map((node) => `${node.kind}:${node.nodeId}`);
  for (const expected of [
    'goal:goal', 'orchestrator:orchestrator', 'planner:planner',
    'agent:agent:s1', 'agent:agent:s2', 'delivery:delivery'
  ]) assert.ok(kinds.includes(expected), 'missing node ' + expected);
  assert.ok(graph.nodes.some((node) => node.kind === 'tool' && node.assignmentId === 'a1'));
  assert.ok(graph.nodes.some((node) => node.kind === 'review' && node.state === 'done'));
  assert.ok(graph.nodes.some((node) => node.kind === 'artifact' && node.label === 'report.md'));

  const edge = (from: string, to: string) => graph.edges.find((item) => item.from === from && item.to === to);
  assert.ok(edge('goal', 'orchestrator'));
  assert.ok(edge('planner', 'agent:s1'));
  assert.ok(edge('agent:s1', 'tool:a1'));
  assert.ok(edge('tool:a1', 'review:a1'));
  assert.ok(edge('artifact:report.md', 'delivery'));
  assert.equal(graph.crew, null);
  assert.ok(!graph.nodes.some((node) => node.nodeId === 'crew:plan'));
});

test('agent runtime, provider and model come from persisted bindings and profiles, never invented', () => {
  const profile: AgentProfileView = {
    agentId: 'writer', name: '写作 Agent', runtime: 'claude-code',
    providerId: 'zcode', modelId: 'glm-5.3', createdAt: AT
  };
  const graph = buildExecutionGraph({
    detail: detailFixture({
      plan: {
        planId: 'plan-2', version: 2, category: 'task8-project-agent-preview', policyVersion: 'policy-2',
        steps: [
          { stepId: 's1', description: '只读评审', workerId: 'dsh-real', dependsOn: [], maxReworks: 1 },
          { stepId: 's2', description: '只读复核', workerId: 'claude-native', dependsOn: [], maxReworks: 1 },
          { stepId: 's3', description: '不可推导', workerId: 'local-writer', dependsOn: [], maxReworks: 1 }
        ]
      },
      assignments: [], reviews: [], progress: { totalSteps: 3, completedSteps: 0, assignmentCount: 0, reviewCount: 0 }
    }),
    crew: null,
    agents: [profile],
    bindings: [
      binding({ bindingId: 'b-tenant', agent: 'dsh', scope: { kind: 'tenant' }, providerId: 'workbuddy', modelId: 'deepseek-v4-pro' }),
      binding({ bindingId: 'b-task', agent: 'dsh', scope: { kind: 'task', taskId: 'task-graph-1' }, providerId: 'deepseek', modelId: 'deepseek-chat' })
    ],
    generatedAt: LATER
  });
  const dsh = graph.nodes.find((node) => node.nodeId === 'agent:s1')!;
  assert.equal(dsh.runtime, 'dsh');
  // Task-scoped binding wins, exactly like dispatch injection.
  assert.equal(dsh.providerId, 'deepseek');
  assert.equal(dsh.modelId, 'deepseek-chat');
  assert.ok(dsh.evidence.includes('model-binding'));
  assert.deepEqual(dsh.unknown, ['tokens', 'cost']);

  const claude = graph.nodes.find((node) => node.nodeId === 'agent:s2')!;
  assert.equal(claude.runtime, 'claude-code');
  assert.equal(claude.providerId, 'zcode');
  assert.equal(claude.modelId, 'glm-5.3');
  assert.ok(claude.evidence.includes('agent-profile'));

  const local = graph.nodes.find((node) => node.nodeId === 'agent:s3')!;
  assert.equal(local.providerId, null);
  assert.equal(local.modelId, null);
  assert.ok(local.unknown.includes('provider'));
  assert.ok(local.unknown.includes('runtime'));
  assert.equal(local.tokens, null);
  assert.equal(local.costMinor, null);
});

test('step state follows persisted review / effect / delivery records', () => {
  const base = detailFixture();
  assert.equal(stepState(base, 's1'), 'done');

  const failedReview = detailFixture({
    status: 'running',
    reviews: [{ assignmentId: 'a1', verdict: 'fail', reasons: ['缺少证据'] }]
  });
  assert.equal(stepState(failedReview, 's1'), 'running');

  const unknownEffect = detailFixture({
    status: 'blocked',
    reviews: [],
    assignments: [{ ...base.assignments[0]!, effectStatus: 'needs_reconciliation', reviewVerdict: null }]
  });
  assert.equal(stepState(unknownEffect, 's1'), 'blocked');

  const noAssignment = detailFixture({
    status: 'queued', assignments: [], reviews: [],
    progress: { totalSteps: 2, completedSteps: 0, assignmentCount: 0, reviewCount: 0 }
  });
  assert.equal(stepState(noAssignment, 's1'), 'queued');
});

test('crew context adds a persisted handoff path and keeps sibling status honest', () => {
  const plan: CrewPlan = {
    planId: 'plan-crew', title: '交付多 Agent 功能', goal: '完成功能交付', planner: 'main-agent', createdAt: AT,
    assignments: [
      { id: 'sub-1', title: '调研', description: '调研需求', agent: 'dsh', providerId: 'workbuddy', modelId: 'deepseek-v4-pro', mode: 'dsh', rationale: '沿用绑定', ready: true },
      { id: 'sub-2', title: '实现', description: '实现功能', agent: 'codex', providerId: 'codex', modelId: 'gpt-6.1-sol', mode: 'real', rationale: '代码能力', ready: true }
    ],
    notes: [],
    dispatchedAt: LATER,
    dispatches: [
      { assignmentId: 'sub-1', taskId: 'task-graph-1', agent: 'dsh', modelId: 'deepseek-v4-pro', mode: 'dsh', bound: true, at: LATER },
      { assignmentId: 'sub-2', taskId: 'task-graph-2', agent: 'codex', modelId: 'gpt-6.1-sol', mode: 'real', bound: false, at: LATER }
    ]
  };
  const graph = buildExecutionGraph({
    detail: detailFixture(),
    crew: {
      plan, assignmentId: 'sub-1',
      siblings: [
        { assignmentId: 'sub-1', taskId: 'task-graph-1', status: 'completed' },
        { assignmentId: 'sub-2', taskId: 'task-graph-2', status: 'running' }
      ]
    },
    agents: [], bindings: [], generatedAt: LATER
  });
  assert.equal(graph.crew?.planId, 'plan-crew');
  assert.equal(graph.crew?.siblings.length, 2);
  assert.ok(graph.nodes.some((node) => node.nodeId === 'crew:plan' && node.evidence.includes('crew')));
  assert.ok(graph.edges.some((edge) => edge.kind === 'handoff' && edge.to === 'orchestrator'));
  assert.ok(graph.events.some((event) => event.source === 'crew' && event.eventId.startsWith('crew:plan-crew:')));

  const context = findCrewContext([plan], 'task-graph-2', (id) => id === 'task-graph-2' ? 'running' : null);
  assert.equal(context?.assignmentId, 'sub-2');
  assert.deepEqual(context?.siblings.map((sibling) => sibling.status), [null, 'running']);
});

test('coverage states what the Host does not persist yet', () => {
  const graph = buildExecutionGraph({ detail: detailFixture(), crew: null, agents: [], bindings: [], generatedAt: LATER });
  assert.equal(graph.coverage.modelRequests, 'not_recorded');
  assert.equal(graph.coverage.toolCalls, 'partial');
  assert.equal(graph.coverage.usage, 'not_recorded');
  assert.ok(graph.coverage.notes.some((note) => note.includes('X-Daming-Task-Id')));

  const empty = buildExecutionGraph({
    detail: detailFixture({ status: 'draft', plan: null, assignments: [], reviews: [], events: [] }),
    crew: null, agents: [], bindings: [], generatedAt: LATER
  });
  assert.equal(empty.coverage.toolCalls, 'not_recorded');
  assert.equal(empty.coverage.runtimeBinding, 'not_recorded');
  assert.equal(empty.nodes.filter((node) => node.kind === 'agent').length, 0);
});

test('timeline event ids are stable and unique so the UI can skip replayed history', () => {
  const graph = buildExecutionGraph({ detail: detailFixture(), crew: null, agents: [], bindings: [], generatedAt: LATER });
  const ids = graph.events.map((event) => event.eventId);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids[0], 'task:task-graph-1:1');
  const again = buildExecutionGraph({ detail: detailFixture(), crew: null, agents: [], bindings: [], generatedAt: '2026-11-23T00:00:00.000Z' });
  assert.deepEqual(again.events.map((event) => event.eventId), ids);
  // Events without a persisted step identity are not attributed to a fabricated node.
  const assignEvent = graph.events.find((event) => event.type === 'workflow_assign')!;
  assert.equal(assignEvent.nodeId, null);
  assert.equal(graph.events.find((event) => event.type === 'workflow_install')?.nodeId, 'planner');
});

test('assignment and review timeline entries point at real nodes and stay deduplicated', () => {
  const graph = buildExecutionGraph({ detail: detailFixture(), crew: null, agents: [], bindings: [], generatedAt: LATER });
  const started = graph.events.filter((event) => event.type === 'assignment_started');
  const ended = graph.events.filter((event) => event.type === 'assignment_ended');
  const reviews = graph.events.filter((event) => event.type === 'review_verdict');
  assert.equal(started.length, 2);
  assert.equal(ended.length, 2);
  assert.equal(reviews.length, 2);
  assert.deepEqual(started.map((event) => event.nodeId).sort(), ['agent:s1', 'agent:s2']);
  assert.deepEqual(reviews.map((event) => event.nodeId).sort(), ['review:a1', 'review:a2']);
  assert.deepEqual(started.map((event) => event.eventId).sort(), ['assignment:a1:started', 'assignment:a2:started']);
  assert.ok(graph.events.every((event) => event.source === 'assignment' || event.source === 'review' || event.source === 'task'));
  assert.equal(new Set(graph.events.map((event) => event.eventId)).size, graph.events.length);
  // Tool nodes expose the persisted effect id so the action is traceable.
  const tool = graph.nodes.find((node) => node.kind === 'tool' && node.assignmentId === 'a1')!;
  assert.ok(tool.detail?.includes('effect-0001-analyst'), 'tool detail carries the persisted effect id');
});

test('gateway rows attributed to the task fill model usage; unattributed rows are ignored', () => {
  const attributed = [
    gatewayRow({ requestId: 'r1', attribution: 'task', taskId: 'task-graph-1' }),
    gatewayRow({ requestId: 'r2', attribution: 'task', taskId: 'task-graph-1', inputTokens: 500, outputTokens: 50, costMinor: 3 })
  ];
  const unattributed = [gatewayRow({ requestId: 'r3' })];
  const otherTask = [gatewayRow({ requestId: 'r4', attribution: 'task', taskId: 'task-other' })];

  const graph = buildExecutionGraph({
    detail: detailFixture({
      plan: {
        planId: 'plan-usage', version: 1, category: 'dsh-real', policyVersion: 'p1',
        steps: [{ stepId: 's1', description: '真实模型调用', workerId: 'dsh-real', dependsOn: [], maxReworks: 1 }]
      },
      assignments: [], reviews: [],
      progress: { totalSteps: 1, completedSteps: 0, assignmentCount: 0, reviewCount: 0 }
    }),
    crew: null,
    agents: [],
    bindings: [binding({ agent: 'dsh', scope: { kind: 'task', taskId: 'task-graph-1' }, providerId: 'deepseek', modelId: 'deepseek-chat' })],
    gatewayRequests: [...attributed, ...unattributed, ...otherTask],
    generatedAt: LATER
  });

  const agent = graph.nodes.find((node) => node.nodeId === 'agent:s1')!;
  assert.deepEqual(agent.tokens, { input: 1500, output: 250 });
  assert.equal(agent.costMinor, 15);
  assert.ok(agent.evidence.includes('gateway'));
  assert.deepEqual(agent.unknown, [], 'usage gaps disappear once attributed rows exist');

  const model = graph.nodes.find((node) => node.kind === 'model')!;
  assert.equal(model.label, 'deepseek/deepseek-chat');
  assert.deepEqual(model.tokens, { input: 1500, output: 250 });
  assert.equal(model.costMinor, 15);
  assert.ok(model.detail?.includes('2 条'));

  assert.equal(graph.coverage.modelRequests, 'persisted');
  assert.equal(graph.coverage.usage, 'persisted');
  assert.ok(graph.coverage.notes.some((note) => note.includes('2 条请求')));
  assert.ok(graph.edges.some((edge) => edge.label === '模型请求' && edge.from === 'agent:s1'));
});

test('a model shared by several steps reports the total on the model node only', () => {
  const graph = buildExecutionGraph({
    detail: detailFixture({
      plan: {
        planId: 'plan-shared', version: 1, category: 'dsh-real', policyVersion: 'p1',
        steps: [
          { stepId: 's1', description: '第一步', workerId: 'dsh-real', dependsOn: [], maxReworks: 1 },
          { stepId: 's2', description: '第二步', workerId: 'dsh-real', dependsOn: ['s1'], maxReworks: 1 }
        ]
      },
      assignments: [], reviews: [],
      progress: { totalSteps: 2, completedSteps: 0, assignmentCount: 0, reviewCount: 0 }
    }),
    crew: null,
    agents: [],
    bindings: [binding({ agent: 'dsh', scope: { kind: 'task', taskId: 'task-graph-1' }, providerId: 'deepseek', modelId: 'deepseek-chat' })],
    gatewayRequests: [gatewayRow({ attribution: 'task', taskId: 'task-graph-1', inputTokens: 800, outputTokens: 40 })],
    generatedAt: LATER
  });
  for (const stepId of ['s1', 's2']) {
    const agent = graph.nodes.find((node) => node.nodeId === `agent:${stepId}`)!;
    assert.equal(agent.tokens, null, 'per-step usage is not invented when the model is shared');
    assert.ok(agent.unknown.includes('tokens'));
  }
  const model = graph.nodes.find((node) => node.kind === 'model')!;
  assert.deepEqual(model.tokens, { input: 800, output: 40 });
  assert.ok(model.detail?.includes('2 个步骤共用'));
});

test('a task with no attributed rows keeps the honest "未接入" state', () => {
  const graph = buildExecutionGraph({
    detail: detailFixture({
      plan: {
        planId: 'plan-usage-2', version: 1, category: 'dsh-real', policyVersion: 'p1',
        steps: [{ stepId: 's1', description: '真实模型调用', workerId: 'dsh-real', dependsOn: [], maxReworks: 1 }]
      },
      assignments: [], reviews: [], progress: { totalSteps: 1, completedSteps: 0, assignmentCount: 0, reviewCount: 0 }
    }),
    crew: null,
    agents: [],
    bindings: [binding({ agent: 'dsh', scope: { kind: 'task', taskId: 'task-graph-1' }, providerId: 'deepseek', modelId: 'deepseek-chat' })],
    gatewayRequests: [],
    generatedAt: LATER
  });
  const agent = graph.nodes.find((node) => node.nodeId === 'agent:s1')!;
  assert.equal(agent.tokens, null);
  assert.equal(agent.costMinor, null);
  assert.deepEqual(agent.unknown, ['tokens', 'cost']);
  const model = graph.nodes.find((node) => node.kind === 'model')!;
  assert.equal(model.state, 'unknown');
  assert.ok(model.unknown.includes('requests'));
  assert.equal(graph.coverage.usage, 'not_recorded');
});

test('crew overview rebuilds the child tree from persisted dispatch receipts', () => {
  const plan: CrewPlan = {
    planId: 'plan-overview', title: '多 Agent 交付', goal: '交付', planner: 'platform', createdAt: AT,
    assignments: [
      { id: 'sub-1', title: '调研', description: '调研', agent: 'dsh', providerId: 'workbuddy', modelId: 'deepseek-v4-pro', mode: 'dsh', rationale: '沿用绑定', ready: true },
      { id: 'sub-2', title: '实现', description: '实现', agent: 'codex', providerId: 'codex', modelId: 'gpt-6.1-sol', mode: 'real', rationale: '代码能力', ready: true },
      { id: 'sub-3', title: '复核', description: '复核', agent: 'claude-code', providerId: '', modelId: '', mode: 'claude', rationale: '缺模型', ready: false }
    ],
    notes: ['note'],
    dispatchedAt: LATER,
    dispatches: [
      { assignmentId: 'sub-1', taskId: 'child-1', agent: 'dsh', modelId: 'deepseek-v4-pro', mode: 'dsh', bound: true, at: LATER },
      { assignmentId: 'sub-2', taskId: 'child-2', agent: 'codex', modelId: 'gpt-6.1-sol', mode: 'real', bound: false, at: LATER },
      { assignmentId: 'sub-4', taskId: 'child-gone', agent: 'codex', modelId: 'gone', mode: 'real', bound: true, at: LATER }
    ],
    skipped: [{ assignmentId: 'sub-3', reason: 'needs_provider_model', at: LATER }]
  };
  const overview = buildCrewOverview({
    plans: [plan],
    generatedAt: LATER,
    blockedReasons: { 'child-2': 'runtime_unavailable' },
    tasks: [
      {
        taskId: 'child-1', title: '多 Agent 交付 · 调研', goal: '调研', status: 'completed', createdAt: AT, updatedAt: LATER,
        budget: null, progress: { totalSteps: 3, completedSteps: 3, assignmentCount: 3, reviewCount: 3 }
      },
      {
        taskId: 'child-2', title: '多 Agent 交付 · 实现', goal: '实现', status: 'blocked', createdAt: AT, updatedAt: LATER,
        budget: null, progress: { totalSteps: 2, completedSteps: 1, assignmentCount: 1, reviewCount: 1 }
      }
    ]
  });
  const view = overview.plans[0]!;
  assert.equal(view.children.length, 3);
  assert.equal(view.children[0]?.status, 'completed');
  assert.equal(view.children[0]?.completedSteps, 3);
  assert.equal(view.children[1]?.blockedReason, 'runtime_unavailable');
  assert.equal(view.children[2]?.status, null, 'a deleted child task stays unknown, not fabricated');
  assert.deepEqual(view.progress, { dispatched: 3, running: 0, completed: 1, blocked: 1, failed: 0, pending: 0 });
  assert.equal(view.skipped[0]?.reason, 'needs_provider_model');
});

test('crew dependencies are advisory and shown from persisted statuses', () => {
  const plan: CrewPlan = {
    planId: 'plan-deps', title: '顺序编队', goal: '调研→实现', planner: 'platform', createdAt: AT,
    assignments: [
      { id: 'sub-1', title: '调研', description: '调研', agent: 'dsh', providerId: 'workbuddy', modelId: 'deepseek-v4-pro', mode: 'dsh', rationale: 'x', ready: true },
      { id: 'sub-2', title: '实现', description: '实现', agent: 'codex', providerId: 'codex', modelId: 'gpt-6.1-sol', mode: 'real', rationale: 'y', ready: true, dependsOn: ['sub-1'] }
    ],
    notes: [],
    dispatchedAt: LATER,
    dispatches: [
      { assignmentId: 'sub-1', taskId: 'task-a', agent: 'dsh', modelId: 'deepseek-v4-pro', mode: 'dsh', bound: true, at: LATER },
      { assignmentId: 'sub-2', taskId: 'task-graph-1', agent: 'codex', modelId: 'gpt-6.1-sol', mode: 'real', bound: true, at: LATER }
    ]
  };
  const overview = buildCrewOverview({
    plans: [plan], generatedAt: LATER,
    tasks: [
      { taskId: 'task-a', title: '调研', goal: '调研', status: 'running', createdAt: AT, updatedAt: LATER, budget: null, progress: { totalSteps: 1, completedSteps: 0, assignmentCount: 0, reviewCount: 0 } }
    ]
  });
  const child = overview.plans[0]!.children.find((item) => item.assignmentId === 'sub-2')!;
  assert.deepEqual(child.waitingOn, ['sub-1'], 'an unfinished predecessor is reported, not enforced');
  assert.deepEqual(overview.plans[0]!.assignments[1]!.dependsOn, ['sub-1']);

  const graph = buildExecutionGraph({
    detail: detailFixture(),
    crew: {
      plan, assignmentId: 'sub-2',
      siblings: [
        { assignmentId: 'sub-1', taskId: 'task-a', status: 'running' },
        { assignmentId: 'sub-2', taskId: 'task-graph-1', status: 'completed' }
      ]
    },
    agents: [], bindings: [], generatedAt: LATER
  });
  const handoff = graph.nodes.find((node) => node.nodeId === 'crew:handoff')!;
  assert.ok(handoff.detail?.includes('等待前置 sub-1'));
  assert.ok(handoff.detail?.includes('引擎不强制串行'));
  assert.equal(graph.crew?.assignmentId, 'sub-2');
});