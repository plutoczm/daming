import type { OfficialReadTransport } from './vendor-billing-readonly.ts';
import { readOfficialBillingJson } from './vendor-billing-readonly.ts';

export class OfficialCostEvidenceError extends Error {
  readonly status: number;
  constructor(status: number, code: string) { super(code); this.status = status; }
}
export type OfficialKeyScopedCost = {
  source: 'openai_admin_daily_costs_api';
  projectIdHint: string; keyIdHint: string;
  utcDay: string; observedAt: string;
  totalMicroUsd: number;
  scope: 'official_project_and_api_key';
  officialAggregateObserved: true;
  issuedKeyProjectBindingChecked: true;
  settledSingleRequest: false;
  invoiceAuthenticated: false;
  providerHardSpendLimitEnforcementVerified: false;
  strictPerRequestCashCapVerified: false;
  automaticallyReleasesUnknownHold: false;
};
type Dict = Record<string, unknown>;
const dict = (a: unknown): a is Dict =>
  a !== null && typeof a === 'object' && !Array.isArray(a);

/**
 * Official ADMIN API only: a complete, single-UTC-day aggregate scoped to
 * exactly the service key and project Daming previously issued. This is
 * stronger evidence than a token estimate, but NOT a vendor invoice, a
 * request-id charge, or a guaranteed spending limit.
 */
export async function readOpenAiIssuedKeyDailyCost(
  input: { projectId: string; keyId: string; adminKey: string; nowMs?: number },
  read: OfficialReadTransport = readOfficialBillingJson
): Promise<OfficialKeyScopedCost> {
  const now = input.nowMs ?? Date.now();
  if (!/^proj_[A-Za-z0-9_-]{3,100}$/.test(input.projectId) ||
      !/^key_[A-Za-z0-9_-]{3,100}$/.test(input.keyId) ||
      typeof input.adminKey !== 'string' || input.adminKey.length < 12 ||
      input.adminKey.length > 4096 || /[\r\n\0]/.test(input.adminKey) ||
      !Number.isSafeInteger(now) || now <= 86400000) {
    throw new OfficialCostEvidenceError(400, 'official_cost_query_invalid');
  }
  const project = await read('api.openai.com',
    '/v1/organization/projects/' + encodeURIComponent(input.projectId), input.adminKey);
  if (!dict(project) || project.object !== 'organization.project' ||
      project.id !== input.projectId) {
    throw new OfficialCostEvidenceError(422, 'official_cost_project_admin_access_invalid');
  }
  const end = Math.floor(now / 86400000) * 86400;
  const start = end - 86400; // Only the last COMPLETE UTC day.
  const params = new URLSearchParams();
  params.set('start_time', String(start));
  params.set('end_time', String(end));
  params.set('bucket_width', '1d');
  params.set('limit', '1');
  params.append('project_ids[]', input.projectId);
  params.append('api_key_ids[]', input.keyId);
  params.append('group_by[]', 'project_id');
  params.append('group_by[]', 'api_key_id');
  const raw = await read('api.openai.com',
    '/v1/organization/costs?' + params.toString(), input.adminKey);
  if (!dict(raw) || raw.object !== 'page' ||
      raw.has_more !== false || raw.next_page !== null ||
      !Array.isArray(raw.data) || raw.data.length > 1) {
    throw new OfficialCostEvidenceError(422, 'official_cost_page_incomplete');
  }
  let centsMicros = 0;
  for (const item of raw.data) {
    if (!dict(item) || item.object !== 'bucket' ||
        item.start_time !== start || item.end_time !== end ||
        !Array.isArray(item.results) || item.results.length > 100) {
      throw new OfficialCostEvidenceError(422, 'official_cost_bucket_invalid');
    }
    const unique = new Set<string>();
    for (const line of item.results) {
      if (!dict(line) || line.object !== 'organization.costs.result' ||
          line.project_id !== input.projectId || line.api_key_id !== input.keyId ||
          !dict(line.amount) || line.amount.currency !== 'usd' ||
          typeof line.amount.value !== 'number' ||
          !Number.isFinite(line.amount.value) ||
          line.amount.value < 0 || line.amount.value > 1000000) {
        throw new OfficialCostEvidenceError(422, 'official_cost_scope_or_amount_invalid');
      }
      // Different line items can be billed separately. Duplicate indistinguishable
      // records fail closed rather than silently multiplying/mislabeling costs.
      const lineItem = line.line_item;
      if (lineItem != null && (typeof lineItem !== 'string' || lineItem.length > 120)) {
        throw new OfficialCostEvidenceError(422, 'official_cost_line_item_invalid');
      }
      const marker = JSON.stringify([lineItem ?? '', line.amount.value, line.api_source ?? '']);
      if (unique.has(marker)) {
        throw new OfficialCostEvidenceError(422, 'official_cost_duplicate_record');
      }
      unique.add(marker);
      centsMicros += Math.ceil(line.amount.value * 1000000);
      if (!Number.isSafeInteger(centsMicros) || centsMicros > 1e12) {
        throw new OfficialCostEvidenceError(422, 'official_cost_sum_unsafe');
      }
    }
  }
  return {
    source: 'openai_admin_daily_costs_api',
    projectIdHint: 'proj…' + input.projectId.slice(-4),
    keyIdHint: 'key…' + input.keyId.slice(-4),
    utcDay: new Date(start * 1000).toISOString().slice(0,10),
    observedAt: new Date(now).toISOString(),
    totalMicroUsd: centsMicros,
    scope: 'official_project_and_api_key',
    officialAggregateObserved: true,
    issuedKeyProjectBindingChecked: true,
    settledSingleRequest: false,
    invoiceAuthenticated: false,
    providerHardSpendLimitEnforcementVerified: false,
    strictPerRequestCashCapVerified: false,
    automaticallyReleasesUnknownHold: false
  };
}
