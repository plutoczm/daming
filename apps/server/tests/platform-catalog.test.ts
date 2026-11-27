import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentProfileStore, ProviderStore, runtimeForProvider } from '../src/platform-catalog.ts';

function dir() { return mkdtempSync(join(tmpdir(), 'daming platform catalog ')); }

test('provider store: add / list / persist / upsert / remove + validation', () => {
  const d = dir();
  try {
    const store = new ProviderStore(d);
    const added = store.add({ id: 'deepseek', api: 'openai-completions', baseUrl: 'https://api.deepseek.com', models: ['deepseek-chat'], apiKeyEnv: 'DEEPSEEK_API_KEY' });
    assert.equal(added.id, 'deepseek');
    assert.equal(store.list().length, 1);
    assert.equal(store.defaultModel(), 'deepseek-chat');

    // 持久化
    const reopened = new ProviderStore(d);
    assert.equal(reopened.list()[0].id, 'deepseek');
    assert.equal(reopened.list()[0].apiKeyEnv, 'DEEPSEEK_API_KEY');

    // 同 id upsert 不新增
    reopened.add({ id: 'deepseek', api: 'anthropic-messages', baseUrl: 'https://api.deepseek.com/anthropic', models: ['deepseek-chat', 'deepseek-reasoner'] });
    assert.equal(reopened.list().length, 1);
    assert.equal(reopened.list()[0].api, 'anthropic-messages');
    assert.deepEqual(reopened.list()[0].models, ['deepseek-chat', 'deepseek-reasoner']);

    // 校验
    assert.throws(() => store.add({ id: 'xx', api: 'bad', baseUrl: 'https://x', models: ['m'] }), /invalid_provider_api/);
    assert.throws(() => store.add({ id: 'xx', api: 'openai-completions', baseUrl: 'ftp://x', models: ['m'] }), /invalid_base_url/);
    assert.throws(() => store.add({ id: 'xx', api: 'openai-completions', baseUrl: 'https://x', models: [] }), /missing_models/);
    assert.throws(() => store.add({ id: 'xx', api: 'openai-completions', baseUrl: 'https://x', models: ['m'], apiKeyEnv: '9bad env' }), /invalid_api_key_env/);

    assert.equal(store.remove('deepseek'), true);
    assert.equal(store.remove('deepseek'), false);
    assert.equal(store.list().length, 0);
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 }); }
});

test('agent store: add / list / setModel (LLM 切换) / persist / remove + validation', () => {
  const d = dir();
  try {
    const store = new AgentProfileStore(d);
    const agent = store.add({ agentId: 'reviewer', name: '代码评审', runtime: 'claude-code', providerId: 'deepseek', modelId: 'deepseek-chat', instructions: '只评审不改代码' });
    assert.equal(agent.agentId, 'reviewer');
    assert.equal(agent.runtime, 'claude-code');
    assert.equal(store.list().length, 1);

    // 切换 LLM
    const switched = store.setModel('reviewer', 'zcode', 'glm-5.3');
    assert.equal(switched.providerId, 'zcode');
    assert.equal(switched.modelId, 'glm-5.3');
    assert.equal(store.get('reviewer')?.modelId, 'glm-5.3');

    // 持久化
    const reopened = new AgentProfileStore(d);
    assert.equal(reopened.get('reviewer')?.modelId, 'glm-5.3');

    // 校验 + 未找到
    assert.throws(() => store.add({ agentId: 'bad id', name: 'x', runtime: 'dsh' }), /invalid_agent_id/);
    assert.throws(() => store.add({ agentId: 'aa', name: 'x', runtime: 'vscode' }), /invalid_agent_runtime/);
    assert.throws(() => store.setModel('ghost', 'p', 'm'), /agent_not_found/);

    assert.equal(store.remove('reviewer'), true);
    assert.equal(store.remove('reviewer'), false);
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 }); }
});

test('agent runtime follows model provider (codex / claude) instead of staying claude-code', () => {
  const d = dir();
  try {
    assert.equal(runtimeForProvider('codex'), 'codex');
    assert.equal(runtimeForProvider('openai'), 'codex');
    assert.equal(runtimeForProvider('anthropic'), 'claude-code');
    assert.equal(runtimeForProvider('claude'), 'claude-code');
    assert.equal(runtimeForProvider('deepseek'), undefined);
    assert.equal(runtimeForProvider(undefined), undefined);

    const store = new AgentProfileStore(d);
    store.add({ agentId: 'reviewer', name: '评审员', runtime: 'claude-code', providerId: 'claude', modelId: 'claude-sonnet-4' });
    const toCodex = store.setModel('reviewer', 'codex', 'codex/gpt-6.2-sol');
    assert.equal(toCodex.runtime, 'codex');
    assert.equal(toCodex.providerId, 'codex');
    // 持久化后重新加载仍一致
    const reopened = new AgentProfileStore(d);
    assert.equal(reopened.get('reviewer')?.runtime, 'codex');
    // 切回非确定供应商则保留当前 runtime，不被强改
    const toDeepseek = store.setModel('reviewer', 'deepseek', 'deepseek-chat');
    assert.equal(toDeepseek.runtime, 'codex');
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 }); }
});
