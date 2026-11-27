import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentProfileStore } from '../src/platform-catalog.ts';
import { ProfileStore, RoutingGroupStore, applyProfile } from '../src/platform-routing.ts';
import { maskText, unmaskText } from '../src/secret-mask.ts';

function dir() { return mkdtempSync(join(tmpdir(), 'daming platform adv ')); }

test('secret mask: detects api key / bearer / kv secret / private key, masks, and restores', () => {
  const anthropicKey = 'sk-ant-abcdefghijklmnopqrstuvwxyz123456';
  const bearer = 'abcDEF1234567890ghijKLMN';
  const kvSecret = 'SuperSecretValue12345';
  const privateKey = '-----BEGIN ' + 'PRIVATE KEY-----\nMIIBVAIBADANBgkqhkiG9w0BAQEFAASCAT4wggE6\n-----END ' + 'PRIVATE KEY-----';
  const text = `OPENAI=${anthropicKey}\nAuthorization: Bearer ${bearer}\npassword = "${kvSecret}"\n${privateKey}`;
  const result = maskText(text);
  const labels = result.findings.map((finding) => finding.label);
  for (const label of ['anthropic_key', 'bearer_token', 'kv_secret', 'private_key']) assert.ok(labels.includes(label), 'missing ' + label);
  assert.equal(result.masked.includes(anthropicKey), false);
  assert.equal(result.masked.includes(kvSecret), false);
  assert.equal(result.masked.includes('BEGIN PRIVATE KEY'), false);
  assert.equal(unmaskText(result.masked, result.mapping), text);

  // 相同值复用同一占位符
  const again = maskText(`a=${anthropicKey} b=${anthropicKey}`);
  assert.equal(new Set(again.findings.map((finding) => finding.placeholder)).size, 1);
});

test('routing groups: add / list / persist / remove / validation', () => {
  const d = dir();
  try {
    const store = new RoutingGroupStore(d);
    const group = store.add({ groupId: 'fast', name: '极速组', strategy: 'order', members: [{ providerId: 'deepseek', modelId: 'deepseek-chat' }, { providerId: 'zcode', modelId: 'glm-5.3' }] });
    assert.equal(group.members.length, 2);
    assert.equal(store.list().length, 1);
    assert.equal(new RoutingGroupStore(d).list()[0].groupId, 'fast');
    assert.throws(() => store.add({ groupId: 'bad id', members: [{ providerId: 'p', modelId: 'm' }] }), /invalid_group_id/);
    assert.throws(() => store.add({ groupId: 'gg', members: [] }), /missing_members/);
    assert.equal(store.remove('fast'), true);
    assert.equal(store.remove('fast'), false);
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 }); }
});

test('profiles: add + apply switches agent models in one move (batch)', () => {
  const d = dir();
  try {
    const agents = new AgentProfileStore(d);
    agents.add({ agentId: 'reviewer', name: '评审', runtime: 'claude-code' });
    agents.add({ agentId: 'coder', name: '开发', runtime: 'codex' });
    const profiles = new ProfileStore(d);
    const profile = profiles.add({ profileId: 'budget', name: '省钱档', assignments: [
      { agentId: 'reviewer', providerId: 'deepseek', modelId: 'deepseek-chat' },
      { agentId: 'coder', providerId: 'zcode', modelId: 'glm-5.3-flash' },
      { agentId: 'ghost', providerId: 'p', modelId: 'm' },
    ] });
    assert.equal(new ProfileStore(d).get('budget')?.assignments.length, 3);
    const result = applyProfile(profile, agents);
    assert.deepEqual(result.applied.sort(), ['coder', 'reviewer']);
    assert.deepEqual(result.skipped, ['ghost']);
    assert.equal(agents.get('reviewer')?.modelId, 'deepseek-chat');
    assert.equal(agents.get('coder')?.modelId, 'glm-5.3-flash');
    assert.equal(profiles.remove('budget'), true);
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 }); }
});
