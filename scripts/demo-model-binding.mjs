import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectMagpieUnifiedTargets } from '../apps/server/src/magpie-unified-targets.ts';
import { listAvailableModels } from '../apps/server/src/agent-catalog.ts';
import { ModelBindingStore, governedDispatch } from '../apps/server/src/model-binding.ts';

const dir = mkdtempSync(join(tmpdir(), 'daming model binding demo '));
const store = new ModelBindingStore(dir, () => Date.parse('2026-11-19T00:00:00Z'));
try {
  // 复用已脱敏的 Magpie 统一路由投影作为目录来源。
  const projection = projectMagpieUnifiedTargets(
    { models: [{ id: 'deepseek/deepseek-flash', name: 'DeepSeek Flash' }, { id: 'codex/gpt-6.1-sol', name: 'Codex', sub: true }], groups: [] },
    () => new Date('2026-11-19T00:00:00Z')
  );
  const catalog = listAvailableModels({
    tenantId: 'tenant-a',
    source: { catalog: projection, quotas: [{ providerId: 'deepseek', remainingPercent: 42 }, { providerId: 'codex', remainingPercent: 0 }] }
  });
  const bound = store.bind({ tenantId: 'tenant-a', agent: 'dsh', modelId: 'deepseek/deepseek-flash', scope: { kind: 'tenant' } }, catalog);
  let runs = 0;
  const dispatched = await governedDispatch({
    store,
    issueKey: () => ({ token: 'd'.repeat(32), baseUrl: 'http://127.0.0.1:46100/v1', expiresMs: Date.parse('2026-11-19T00:30:00Z') }),
    run: async () => { runs += 1; return { status: 'completed', output: 'OK' }; }
  }, { tenantId: 'tenant-a', agent: 'dsh', gate: { quotaRemainingPercent: 42, budgetRemainingMinor: 1000, requiredMinor: 100 } });
  let quotaRejected = false;
  try {
    store.bind({ tenantId: 'tenant-a', agent: 'codex', modelId: 'codex/gpt-6.1-sol', scope: { kind: 'tenant' } }, catalog);
  } catch (error) { quotaRejected = String(error instanceof Error ? error.message : error); }
  console.log(JSON.stringify({
    mode: 'model_binding_governed_dispatch',
    catalog: { tenantId: catalog.tenantId, models: catalog.models.map((m) => ({ modelId: m.modelId, sourceKind: m.sourceKind, billing: m.billing, dispatchable: m.dispatchable, ...(m.reason ? { reason: m.reason } : {}) })) },
    bound: { bindingId: bound.bindingId, agent: bound.agent, modelId: bound.modelId, status: bound.status },
    dispatch: { status: dispatched.result.status, runs, injectedEnvKeys: Object.keys(dispatched.runtime.env).sort(), tokenRefLength: dispatched.runtime.tokenRef.length, externalModelRequests: 0 },
    quotaExhaustedRejected: quotaRejected,
    crossTenantBinding: store.resolve('tenant-b', 'dsh') ?? null
  }, null, 2));
} finally { store.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
