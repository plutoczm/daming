import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listAvailableModels } from '../src/agent-catalog.ts';
import type { MagpieUnifiedCatalog, MagpieUnifiedTarget } from '../src/magpie-unified-targets.ts';

function catalog(targets: readonly MagpieUnifiedTarget[]): MagpieUnifiedCatalog {
  return {
    source: 'magpie-native-routing', checkedAt: '2026-11-19T00:00:00.000Z',
    targets, dispatchEnabled: false, managesCredentialsInMagpie: true
  };
}
function target(targetId: string, kind: MagpieUnifiedTarget['kind'], providerId: string | null): MagpieUnifiedTarget {
  return { targetId, label: targetId, kind, providerId, members: 1, ready: true };
}

test('统一目录归一来源/计费/额度窗口并判定可派工', () => {
  const source = {
    catalog: catalog([
      target('deepseek/deepseek-flash', 'llm', 'deepseek'),
      target('codex/gpt-6.1-sol', 'agent-backed', 'codex'),
      target('group/fast', 'route-group', null)
    ]),
    quotas: [
      { providerId: 'deepseek', remainingPercent: 42, resetsAt: '2026-11-20T00:00:00Z' },
      { providerId: 'codex', remainingPercent: 0 }
    ]
  };
  const view = listAvailableModels({ tenantId: 'tenant-a', source });
  assert.equal(view.tenantId, 'tenant-a');
  assert.equal(view.dispatchEnabled, false);
  const byId = new Map(view.models.map((model) => [model.modelId, model]));
  const ds = byId.get('deepseek/deepseek-flash')!;
  assert.equal(ds.sourceKind, 'official_api');
  assert.equal(ds.billing, 'cash');
  assert.equal(ds.quota.remainingPercent, 42);
  assert.equal(ds.quota.resetsAt, '2026-11-20T00:00:00Z');
  assert.equal(ds.dispatchable, true);
  const cx = byId.get('codex/gpt-6.1-sol')!;
  assert.equal(cx.sourceKind, 'subscription');
  assert.equal(cx.billing, 'quota');
  assert.equal(cx.dispatchable, false);
  assert.equal(cx.reason, 'quota_exhausted');
  const grp = byId.get('group/fast')!;
  assert.equal(grp.sourceKind, 'relay');
  assert.equal(grp.billing, 'cash');
  assert.equal(grp.dispatchable, true);
});

test('白名单之外不可派工，且视图不含凭据类字段', () => {
  const source = { catalog: catalog([target('deepseek/deepseek-flash', 'llm', 'deepseek')]), allowlist: ['other/model'] };
  const view = listAvailableModels({ tenantId: 'tenant-a', source });
  assert.equal(view.models[0]!.dispatchable, false);
  assert.equal(view.models[0]!.reason, 'not_allowed');
  assert.doesNotMatch(JSON.stringify(view), /sk-|bearer|token|password|api[_-]?key/i);
});

test('跨租户不可见：目录只由本租户来源生成', () => {
  const a = listAvailableModels({ tenantId: 'tenant-a', source: { catalog: catalog([target('deepseek/deepseek-flash', 'llm', 'deepseek')]) } });
  const b = listAvailableModels({ tenantId: 'tenant-b', source: { catalog: catalog([target('ollama/qwen3:8b', 'llm', 'ollama')]) } });
  assert.deepEqual(a.models.map((model) => model.modelId), ['deepseek/deepseek-flash']);
  assert.deepEqual(b.models.map((model) => model.modelId), ['ollama/qwen3:8b']);
  assert.equal(b.models.some((model) => model.modelId === 'deepseek/deepseek-flash'), false);
});

test('非法租户与非法目录抛错', () => {
  assert.throws(() => listAvailableModels({ tenantId: 'bad tenant!', source: { catalog: catalog([]) } }), /tenant_id_invalid/);
  assert.throws(() => listAvailableModels({ tenantId: 'tenant-a', source: { catalog: {} as never } }), /model_catalog_invalid/);
});
