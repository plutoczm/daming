import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { projectMagpieUnifiedTargets, validateMagpieRoleAssignments }
  from '../src/magpie-unified-targets.ts';
import { MissionControl } from '../src/mission-control.ts';

const magpie = {
  models: [
    { id: 'openai/gpt-6', name: 'GPT-6', provider: 'openai', sub: false,
      account: 'never-expose@private', apiKey: 'sk-SHOULD-NOT-LEAK' },
    { id: 'codex/gpt-6', name: 'Codex via subscribed Agent', provider: 'codex',
      sub: true, account: 'private@account', accessToken: 'secret-value' },
    { id: 'claude/opus', sub: true },
    { id: 'https://malicious.example.com', sub: true },
    { id: 'deepseek/deepseek-chat', name: 'mail@example.com', sub: false }
  ],
  groups: [
    { id: 'coding', name: 'Coding team', ref: 'group/coding',
      ready: true, members: ['codex/gpt-6', 'claude/opus'], rules: [
        { headers: { authorization: 'Bearer some-secret' } }
      ] },
    { id: 'off', ref: 'group/off', ready: false, members: ['codex/gpt-6'] },
    { id: 'auto', ref: 'auto/deepseek-chat', ready: true,
      members: ['deepseek/deepseek-chat'] },
    { id: 'private', ref: 'group/private', ready: true, decides: true,
      members: ['openai/gpt-6'] }
  ],
  accounts: { openai: [{ key: 'sk-SECRET' }] },
  templates: [{ key: 'another-secret' }]
};

test('adopts native Magpie model, subscription Agent and route-group choices without copying secrets', () => {
  const catalog = projectMagpieUnifiedTargets(magpie, () => new Date('2026-11-12T00:00:00Z'));
  assert.deepEqual(catalog.targets.map(t => [t.targetId, t.kind]), [
    ['openai/gpt-6','llm'],
    ['codex/gpt-6','agent-backed'],
    ['claude/opus','agent-backed'],
    ['deepseek/deepseek-chat','llm'],
    ['group/coding','route-group'],
    ['auto/deepseek-chat','route-group']
  ]);
  assert.equal(catalog.source, 'magpie-native-routing');
  assert.equal(catalog.dispatchEnabled, false);
  assert.equal(catalog.managesCredentialsInMagpie, true);
  assert.equal(catalog.targets.find(t => t.targetId === 'group/coding')?.members, 2);
  const safe = JSON.stringify(catalog);
  for (const sensitive of ['sk-SHOULD', 'private@account', 'mail@example.com',
    'authorization', 'Bearer', 'accessToken', 'some-secret', 'sk-SECRET']) {
    assert.ok(!safe.includes(sensitive), 'leaked ' + sensitive);
  }
  assert.throws(() => projectMagpieUnifiedTargets({ providers: [] }),
    /magpie_native_routing_schema_invalid/);
  assert.throws(() => validateMagpieRoleAssignments([
    { role: 'router', targetId: 'group/does-not-exist' }
  ], catalog), /magpie_role_plan_invalid/);
  assert.throws(() => validateMagpieRoleAssignments([
    { role: 'router', targetId: 'codex/gpt-6' },
    { role: 'router', targetId: 'claude/opus' }
  ], catalog), /magpie_role_plan_invalid/);
});

test('Magpie multi-agent role plan persists in mission trace, remains offline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'daming-magpie-role-plan-'));
  const missions = new MissionControl(dir);
  try {
    const mission = missions.create({
      requestId: randomUUID(), title: 'Plan multiple Agent suppliers',
      goal: 'Use Magpie to choose Agents and LLM', mode: 'offline-demo'
    });
    const catalog = projectMagpieUnifiedTargets(magpie);
    const assignments = validateMagpieRoleAssignments([
      { role: 'router', targetId: 'group/coding' },
      { role: 'research', targetId: 'codex/gpt-6' },
      { role: 'analysis', targetId: 'claude/opus' },
      { role: 'delivery', targetId: 'openai/gpt-6' }
    ], catalog);
    const rid = randomUUID();
    const planned = missions.assignMagpieRoles(mission.missionId, rid, assignments);
    assert.equal(planned.nodes.find(node => node.id === 'router')?.modelRoute, 'group/coding');
    assert.equal(planned.nodes.find(node => node.id === 'research')?.modelRoute, 'codex/gpt-6');
    assert.equal(planned.nodes.find(node => node.id === 'analysis')?.modelRoute, 'claude/opus');
    assert.equal(planned.nodes.find(node => node.id === 'delivery')?.modelRoute, 'openai/gpt-6');
    assert.equal(planned.mode, 'offline-demo');
    assert.equal(planned.routeAuthorization, null);
    assert.ok(planned.events.some(event => event.type === 'magpie.targets.planned'));
    assert.equal(missions.assignMagpieRoles(mission.missionId, rid, assignments)
      .nodes.find(node => node.id === 'analysis')?.modelRoute, 'claude/opus');
    assert.throws(() => missions.assignMagpieRoles(mission.missionId, rid,
      [{ role: 'analysis', targetId: 'codex/gpt-6' }]), /magpie_plan_request_conflict/);
    assert.equal(missions.detail(mission.missionId).nodes.find(n => n.id === 'router')?.modelRoute,
      'group/coding');
  } finally {
    missions.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  }
});
