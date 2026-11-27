import type { AvailableModelView, AvailableModelsView, ModelBillingBasis, ModelSourceKind } from '@daming/contracts';
import type { MagpieUnifiedCatalog, MagpieUnifiedTarget } from './magpie-unified-targets.ts';

/**
 * S5 统一模型目录（只读、脱敏、按租户）。
 * 输入来自已脱敏的 Magpie 统一目录投影（magpie-unified-targets）+ 该租户的额度窗口，
 * 输出归一视图：来源类型 / 模型 id / 额度窗口 / 是否可派工 / 计费方式。
 * 本模块不持有凭据、不发起任何请求，也不跨租户聚合。
 */
export interface TenantQuotaWindow {
  readonly providerId: string;
  readonly remainingPercent?: number;
  readonly resetsAt?: string;
}
export interface TenantModelSource {
  readonly catalog: MagpieUnifiedCatalog;
  readonly quotas?: readonly TenantQuotaWindow[];
  /** 可选：本租户允许派工的模型白名单；缺省表示目录内可用模型均可派工。 */
  readonly allowlist?: readonly string[];
}
export interface ListAvailableModelsInput {
  readonly tenantId: string;
  readonly source: TenantModelSource;
}

const TENANT_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/i;
const MODEL_ID = /^[a-z0-9][a-z0-9._:/-]{0,159}$/i;

function sourceKind(kind: MagpieUnifiedTarget['kind']): ModelSourceKind {
  if (kind === 'agent-backed') return 'subscription';
  if (kind === 'route-group') return 'relay';
  return 'official_api';
}
function billingOf(kind: ModelSourceKind): ModelBillingBasis {
  return kind === 'subscription' ? 'quota' : 'cash';
}
function sanitizePercent(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

export function listAvailableModels(input: ListAvailableModelsInput): AvailableModelsView {
  if (!input || typeof input !== 'object') throw new Error('model_catalog_invalid');
  const tenantId = input.tenantId;
  if (typeof tenantId !== 'string' || !TENANT_ID.test(tenantId)) throw new Error('tenant_id_invalid');
  const source = input.source;
  const catalog = source?.catalog;
  if (!catalog || catalog.source !== 'magpie-native-routing' || !Array.isArray(catalog.targets)) {
    throw new Error('model_catalog_invalid');
  }
  const allow = Array.isArray(source.allowlist) ? new Set(source.allowlist) : undefined;
  const quotas = new Map<string, TenantQuotaWindow>();
  for (const quota of source.quotas ?? []) {
    if (quota && typeof quota.providerId === 'string' && !quotas.has(quota.providerId)) quotas.set(quota.providerId, quota);
  }
  const models: AvailableModelView[] = [];
  const seen = new Set<string>();
  for (const target of catalog.targets) {
    if (!target || typeof target.targetId !== 'string' || !MODEL_ID.test(target.targetId) ||
        target.targetId.includes('..') || target.targetId.includes('://') || seen.has(target.targetId)) continue;
    seen.add(target.targetId);
    const kind = sourceKind(target.kind);
    const billing = billingOf(kind);
    const quota = target.providerId ? quotas.get(target.providerId) : undefined;
    const percent = sanitizePercent(quota?.remainingPercent);
    const resetsAt = typeof quota?.resetsAt === 'string' ? quota.resetsAt : undefined;
    const window: AvailableModelView['quota'] = {
      ...(percent === undefined ? {} : { remainingPercent: percent }),
      ...(resetsAt === undefined ? {} : { resetsAt })
    };
    let dispatchable = target.ready === true;
    let reason: string | undefined;
    if (allow && !allow.has(target.targetId)) {
      dispatchable = false; reason = 'not_allowed';
    } else if (percent === 0) {
      dispatchable = false; reason = 'quota_exhausted';
    }
    models.push({
      modelId: target.targetId,
      providerId: typeof target.providerId === 'string' ? target.providerId : target.targetId.split('/')[0],
      sourceKind: kind, billing, quota: window, dispatchable,
      ...(reason === undefined ? {} : { reason })
    });
  }
  models.sort((a, b) => (a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0));
  return { tenantId, models, checkedAt: catalog.checkedAt, dispatchEnabled: false };
}
