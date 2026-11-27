import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AvailableModelView, AvailableModelsView } from '@daming/contracts';
import { ModelBindingStore, resolveAgentRuntime } from '../src/model-binding.ts';
import { ExecutorInjectionError, executorInjection } from '../src/executor-model-injection.ts';

function catalogFor(tenantId: string, models: readonly AvailableModelView[]): AvailableModelsView {
  return { tenantId, models, checkedAt: '2026-11-19T00:00:00.000Z', dispatchEnabled: false };
}
function model(modelId: string, providerId: string, extra: Partial<AvailableModelView> = {}): AvailableModelView {
  return { modelId, providerId, sourceKind: 'official_api', billing: 'cash', quota: {}, dispatchable: true, ...extra };
}

test('S5 选模型绑定解析出的模型与一次性 key 注入到三种执行器启动参数', () => {
  const dir = mkdtempSync(join(tmpdir(), 'daming exec injection '));
  const store = new ModelBindingStore(dir, () => Date.now());
  try {
    const catalog = catalogFor('tenant-a', [
      model('codex/gpt-6.2-sol', 'codex', { sourceKind: 'subscription', billing: 'quota' }),
      model('workbuddy/deepseek-v4.1-flash', 'workbuddy')
    ]);
    const codexRuntime = resolveAgentRuntime(
      store.bind({ tenantId: 'tenant-a', agent: 'codex', modelId: 'codex/gpt-6.2-sol', scope: { kind: 'tenant' } }, catalog),
      () => ({ token: 'a'.repeat(32), baseUrl: 'http://127.0.0.1:46300/v1', expiresMs: Date.now() + 1_800_000 })
    );
    const codex = executorInjection(codexRuntime);
    if (codex.agent !== 'codex') throw new Error('expected codex');
    assert.equal(codex.model, 'codex/gpt-6.2-sol');
    assert.equal(codex.modelProvider, 'daming');
    assert.equal(codex.baseUrl, 'http://127.0.0.1:46300/v1');
    assert.equal(codex.token, 'a'.repeat(32));

    const claudeRuntime = resolveAgentRuntime(
      store.bind({ tenantId: 'tenant-a', agent: 'claude-code', modelId: 'workbuddy/deepseek-v4.1-flash', scope: { kind: 'task', taskId: 't-claude' } }, catalog),
      () => ({ token: 'b'.repeat(32), baseUrl: 'http://127.0.0.1:46301/v1', expiresMs: Date.now() + 1_800_000 })
    );
    const claude = executorInjection(claudeRuntime);
    if (claude.agent !== 'claude-code') throw new Error('expected claude-code');
    assert.equal(claude.model, 'workbuddy/deepseek-v4.1-flash');
    assert.equal(claude.baseUrl, 'http://127.0.0.1:46301/v1');
    assert.equal(claude.token, 'b'.repeat(32));

    const dshRuntime = resolveAgentRuntime(
      store.bind({ tenantId: 'tenant-a', agent: 'dsh', modelId: 'workbuddy/deepseek-v4.1-flash', scope: { kind: 'task', taskId: 't-dsh' } }, catalog),
      () => ({ token: 'c'.repeat(32), baseUrl: 'http://127.0.0.1:46302/v1', expiresMs: Date.now() + 1_800_000 })
    );
    const dsh = executorInjection(dshRuntime);
    if (dsh.agent !== 'dsh') throw new Error('expected dsh');
    assert.equal(dsh.model, 'workbuddy/deepseek-v4.1-flash');
    assert.equal(dsh.env.DEEPSEEK_MODEL, 'workbuddy/deepseek-v4.1-flash');
    assert.equal(dsh.env.DEEPSEEK_BASE_URL, 'http://127.0.0.1:46302/v1');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('注入字段缺失或未知执行器时拒绝', () => {
  assert.throws(() => executorInjection({ agent: 'codex', env: {} } as never), /runtime_missing_MAGPIE_BASE_URL/);
  assert.throws(() => executorInjection({ agent: 'claude-code', env: { ANTHROPIC_BASE_URL: 'x', ANTHROPIC_MODEL: 'm' } } as never), /runtime_missing_ANTHROPIC_API_KEY/);
  assert.throws(() => executorInjection({ agent: 'unknown', env: {} } as never), /agent_unsupported/);
  assert.throws(() => executorInjection(null as never), ExecutorInjectionError);
});
