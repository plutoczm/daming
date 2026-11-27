import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AvailableModelView, AvailableModelsView } from '@daming/contracts';
import { governedDispatch, ModelBindingStore, resolveAgentRuntime } from '../src/model-binding.ts';

function catalogFor(tenantId: string, models: readonly AvailableModelView[]): AvailableModelsView {
  return { tenantId, models, checkedAt: '2026-11-19T00:00:00.000Z', dispatchEnabled: false };
}
function model(modelId: string, providerId: string, extra: Partial<AvailableModelView> = {}): AvailableModelView {
  return { modelId, providerId, sourceKind: 'official_api', billing: 'cash', quota: {}, dispatchable: true, ...extra };
}
function tempStore(clock: () => number = () => Date.parse('2026-11-19T00:00:00Z')) {
  const dir = mkdtempSync(join(tmpdir(), 'daming-model-binding-'));
  const store = new ModelBindingStore(dir, clock);
  return {
    dir, store,
    cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  };
}

test('选模型绑定 Agent 后按租户解析，重启保留、可撤销', () => {
  const { dir, store, cleanup } = tempStore();
  try {
    const catalog = catalogFor('tenant-a', [model('deepseek/deepseek-flash', 'deepseek')]);
    const bound = store.bind({ tenantId: 'tenant-a', agent: 'dsh', modelId: 'deepseek/deepseek-flash', scope: { kind: 'tenant' } }, catalog);
    assert.equal(bound.status, 'active');
    assert.equal(bound.sourceKind, 'official_api');
    assert.equal(store.resolve('tenant-a', 'dsh')!.bindingId, bound.bindingId);
    assert.equal(store.list('tenant-a').length, 1);

    // 重启（同一文件新实例）后仍保留
    const reopened = new ModelBindingStore(dir);
    try {
      assert.equal(reopened.resolve('tenant-a', 'dsh')!.bindingId, bound.bindingId);
      const revoked = reopened.revoke('tenant-a', bound.bindingId);
      assert.equal(revoked.status, 'revoked');
      assert.equal(reopened.resolve('tenant-a', 'dsh'), undefined);
      assert.equal(reopened.list('tenant-a')[0]!.status, 'revoked');
    } finally { reopened.close(); }
    void store;
  } finally { cleanup(); }
});

test('不可用或额度耗尽的模型被拒', () => {
  const { store, cleanup } = tempStore();
  try {
    const catalog = catalogFor('tenant-a', [
      model('codex/gpt-6.1-sol', 'codex', { sourceKind: 'subscription', billing: 'quota', dispatchable: false, reason: 'quota_exhausted' })
    ]);
    assert.throws(() => store.bind({ tenantId: 'tenant-a', agent: 'codex', modelId: 'codex/gpt-6.1-sol', scope: { kind: 'tenant' } }, catalog), /quota_exhausted/);
    assert.throws(() => store.bind({ tenantId: 'tenant-a', agent: 'codex', modelId: 'deepseek/absent', scope: { kind: 'tenant' } }, catalog), /model_unavailable/);
  } finally { cleanup(); }
});

test('跨租户不可见：不能解析、列取或借用他人目录绑定', () => {
  const { store, cleanup } = tempStore();
  try {
    const catA = catalogFor('tenant-a', [model('deepseek/deepseek-flash', 'deepseek')]);
    store.bind({ tenantId: 'tenant-a', agent: 'dsh', modelId: 'deepseek/deepseek-flash', scope: { kind: 'tenant' } }, catA);
    assert.equal(store.resolve('tenant-b', 'dsh'), undefined);
    assert.deepEqual(store.list('tenant-b'), []);
    // 用 A 的目录替 B 绑定必须被租户校验拦下
    assert.throws(() => store.bind(
      { tenantId: 'tenant-b', agent: 'dsh', modelId: 'deepseek/deepseek-flash', scope: { kind: 'tenant' } }, catA
    ), /catalog_tenant_mismatch/);
  } finally { cleanup(); }
});

test('任务级绑定优先于租户级绑定', () => {
  const { store, cleanup } = tempStore();
  try {
    const catalog = catalogFor('tenant-a', [
      model('deepseek/deepseek-flash', 'deepseek'),
      model('deepseek/deepseek-chat', 'deepseek')
    ]);
    const tenantBinding = store.bind({ tenantId: 'tenant-a', agent: 'dsh', modelId: 'deepseek/deepseek-flash', scope: { kind: 'tenant' } }, catalog);
    const taskBinding = store.bind({ tenantId: 'tenant-a', agent: 'dsh', modelId: 'deepseek/deepseek-chat', scope: { kind: 'task', taskId: 'task-42' } }, catalog);
    assert.equal(store.resolve('tenant-a', 'dsh')!.bindingId, tenantBinding.bindingId);
    assert.equal(store.resolve('tenant-a', 'dsh', { taskId: 'task-42' })!.bindingId, taskBinding.bindingId);
    assert.equal(store.resolve('tenant-a', 'dsh', { taskId: 'other' })!.bindingId, tenantBinding.bindingId);
  } finally { cleanup(); }
});

test('派工注入正确环境变量并只签发一次一次性 key', async () => {
  const { store, cleanup } = tempStore();
  try {
    const catalog = catalogFor('tenant-a', [model('deepseek/deepseek-flash', 'deepseek')]);
    store.bind({ tenantId: 'tenant-a', agent: 'dsh', modelId: 'deepseek/deepseek-flash', scope: { kind: 'tenant' } }, catalog);
    let issued = 0; let seenEnv: Readonly<Record<string, string>> | undefined;
    const runtime = resolveAgentRuntime(store.resolve('tenant-a', 'dsh')!, () => {
      issued += 1;
      return { token: 'a'.repeat(32), baseUrl: 'http://127.0.0.1:45999/v1', expiresMs: Date.parse('2026-11-19T00:30:00Z') };
    });
    assert.equal(issued, 1);
    assert.equal(runtime.env.DEEPSEEK_BASE_URL, 'http://127.0.0.1:45999/v1');
    assert.equal(runtime.env.DEEPSEEK_API_KEY, 'a'.repeat(32));
    assert.equal(runtime.env.DEEPSEEK_MODEL, 'deepseek/deepseek-flash');
    assert.equal(runtime.tokenRef.length, 16);
    assert.notEqual(runtime.tokenRef, 'a'.repeat(32));
    void seenEnv;

    // codex / claude 注入名各自正确
    const codexCatalog = catalogFor('tenant-a', [model('codex/gpt-6.1-sol', 'codex', { sourceKind: 'subscription', billing: 'quota' })]);
    const codex = store.bind({ tenantId: 'tenant-a', agent: 'codex', modelId: 'codex/gpt-6.1-sol', scope: { kind: 'tenant' } }, codexCatalog);
    const codexRuntime = resolveAgentRuntime(codex, () => ({ token: 'b'.repeat(32), baseUrl: 'http://127.0.0.1:46000/v1', expiresMs: Date.parse('2026-11-19T00:30:00Z') }));
    assert.equal(codexRuntime.env.CODEX_MODEL_PROVIDER, 'daming-magpie');
    assert.equal(codexRuntime.env.MAGPIE_BASE_URL, 'http://127.0.0.1:46000/v1');
    assert.equal(codexRuntime.env.CODEX_MODEL, 'codex/gpt-6.1-sol');
  } finally { cleanup(); }
});

test('受治理派工跑通一次，并对额度/预算/缺失绑定分别拒绝', async () => {
  const { store, cleanup } = tempStore();
  try {
    const catalog = catalogFor('tenant-a', [model('deepseek/deepseek-flash', 'deepseek')]);
    store.bind({ tenantId: 'tenant-a', agent: 'dsh', modelId: 'deepseek/deepseek-flash', scope: { kind: 'tenant' } }, catalog);
    let runs = 0;
    const deps = {
      store,
      issueKey: () => ({ token: 'c'.repeat(32), baseUrl: 'http://127.0.0.1:46001/v1', expiresMs: Date.parse('2026-11-19T00:30:00Z') }),
      run: async (runtime: { env: Readonly<Record<string, string>> }) => {
        runs += 1;
        assert.equal(runtime.env.DEEPSEEK_BASE_URL, 'http://127.0.0.1:46001/v1');
        return { status: 'completed' as const, output: 'OK' };
      }
    };
    const ok = await governedDispatch(deps, { tenantId: 'tenant-a', agent: 'dsh', gate: { quotaRemainingPercent: 50, budgetRemainingMinor: 1000, requiredMinor: 100 } });
    assert.equal(ok.result.status, 'completed');
    assert.equal(ok.binding.modelId, 'deepseek/deepseek-flash');
    assert.equal(runs, 1);

    await assert.rejects(governedDispatch(deps, { tenantId: 'tenant-a', agent: 'dsh', gate: { quotaRemainingPercent: 0, budgetRemainingMinor: 1000, requiredMinor: 100 } }), /quota_exhausted/);
    await assert.rejects(governedDispatch(deps, { tenantId: 'tenant-a', agent: 'dsh', gate: { quotaRemainingPercent: 50, budgetRemainingMinor: 50, requiredMinor: 100 } }), /budget_denied/);
    await assert.rejects(governedDispatch(deps, { tenantId: 'tenant-a', agent: 'claude-code', gate: { quotaRemainingPercent: 50, budgetRemainingMinor: 1000, requiredMinor: 100 } }), /binding_missing/);
    assert.equal(runs, 1);
  } finally { cleanup(); }
});

test('绑定结构与非本租户等非法输入被拒', () => {
  const { store, cleanup } = tempStore();
  try {
    const catalog = catalogFor('tenant-a', [model('deepseek/deepseek-flash', 'deepseek')]);
    assert.throws(() => store.bind({ tenantId: 'tenant-a', agent: 'dsh', modelId: 'deepseek/deepseek-flash', scope: { kind: 'task' } as never }, catalog), /binding_scope_invalid/);
    assert.throws(() => store.bind({ tenantId: 'tenant-a', agent: 'bogus' as never, modelId: 'deepseek/deepseek-flash', scope: { kind: 'tenant' } }, catalog), /agent_invalid/);
    assert.throws(() => store.revoke('tenant-b', 'not-a-uuid'), /binding_not_found/);
  } finally { cleanup(); }
});
