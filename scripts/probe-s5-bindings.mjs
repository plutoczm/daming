// 只读探针：从本机 Magpie /v1/models 建 S5 统一目录，逐个“供应商模型 × 执行器”组合
// 通过 S5 的 ModelBindingStore / governedDispatch 试绑定并跑一次受治理派工（合成执行，不发真实模型请求）。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectMagpieGatewayTargets } from '../apps/server/src/magpie-unified-targets.ts';
import { listAvailableModels } from '../apps/server/src/agent-catalog.ts';
import { ModelBindingStore, governedDispatch } from '../apps/server/src/model-binding.ts';

const BASE = process.env.MAGPIE_BASE_URL || 'http://127.0.0.1:3425';
const tenantId = 'tenant-local';
const combos = [
  { combo: 'workbuddy的deepseek-v4.1-flash + DeepSeek Harness', modelId: 'workbuddy/deepseek-v4.1-flash', agent: 'dsh', taskId: 'wb-dsh' },
  { combo: 'workbuddy的deepseek-v4.1-flash + Claude Code', modelId: 'workbuddy/deepseek-v4.1-flash', agent: 'claude-code', taskId: 'wb-claude' },
  { combo: 'Codex的gpt-6.2-sol + DeepSeek Harness', modelId: 'codex/gpt-6.2-sol', agent: 'dsh', taskId: 'codex-dsh' }
];

try {
  const res = await fetch(BASE + '/v1/models', { headers: { authorization: 'Bearer magpie-daming' }, redirect: 'error' });
  if (!res.ok) throw new Error('models_http_' + res.status);
  const raw = await res.json();
  const projection = projectMagpieGatewayTargets(raw, () => new Date());
  const catalog = listAvailableModels({ tenantId, source: { catalog: projection } });
  const available = catalog.models.map((model) => model.modelId);
  const dir = mkdtempSync(join(tmpdir(), 'daming s5 bind '));
  const store = new ModelBindingStore(dir, () => Date.now());
  const results = [];
  try {
    for (const combo of combos) {
      if (!available.includes(combo.modelId)) {
        results.push({ combo: combo.combo, modelId: combo.modelId, agent: combo.agent, result: 'model_not_in_live_catalog', available });
        continue;
      }
      try {
        const bound = store.bind(
          { tenantId, agent: combo.agent, modelId: combo.modelId, scope: { kind: 'task', taskId: combo.taskId } },
          catalog
        );
        let runs = 0;
        const dispatched = await governedDispatch({
          store,
          issueKey: () => ({ token: 'e'.repeat(32), baseUrl: 'http://127.0.0.1:46200/v1', expiresMs: Date.now() + 1_800_000 }),
          run: async () => { runs += 1; return { status: 'completed', output: 'OK' }; }
        }, { tenantId, agent: combo.agent, taskId: combo.taskId, gate: { quotaRemainingPercent: 100, budgetRemainingMinor: 1000, requiredMinor: 100 } });
        results.push({
          combo: combo.combo, modelId: combo.modelId, agent: combo.agent,
          binding: bound.status, dispatch: dispatched.result.status, runs,
          injectedEnvKeys: Object.keys(dispatched.runtime.env).sort(),
          injectedModel: dispatched.runtime.env.DEEPSEEK_MODEL ?? dispatched.runtime.env.ANTHROPIC_MODEL ?? dispatched.runtime.env.CODEX_MODEL,
          realExternalModelRequest: false
        });
      } catch (error) {
        results.push({ combo: combo.combo, modelId: combo.modelId, agent: combo.agent, error: String(error instanceof Error ? error.message : error) });
      }
    }
    console.log(JSON.stringify({ magpie: BASE, modelCount: available.length, tenantId, results }, null, 2));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
} catch (error) {
  console.log(JSON.stringify({ magpie: BASE, error: String(error instanceof Error ? error.message : error) }, null, 2));
}
