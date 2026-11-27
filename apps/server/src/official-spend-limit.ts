import { readOfficialBillingJson } from './vendor-billing-readonly.ts';
import type { OfficialReadTransport } from './vendor-billing-readonly.ts';

export class OfficialSpendLimitError extends Error {
  readonly status: number;
  constructor(status: number, code: string) { super(code); this.status = status; }
}
type Scope = 'project' | 'organization';
type Limit = { enforcementStatus: 'enforcing' | 'inactive'; thresholdMinor: number };
export type OfficialSpendLimitEvidence = {
  source: 'openai_admin_spend_limit_api';
  projectHint: string;
  observedAt: string;
  project: Limit; organization: Limit;
  effectiveMonthlyThresholdMinor: number | null;
  officialMonthlyLimitsObserved: true;
  providerMonthlyEnforcementVerified: boolean;
  spendingThresholdCurrency: 'USD';
  spendingThresholdInterval: 'month';
  limitMayOvershoot: true;
  precisePerRequestCashCapVerified: false;
  vendorInvoiceAuthenticated: false;
  enablesAutomaticPaidDispatch: false;
};
function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function parseLimit(raw: unknown, scope: Scope): Limit {
  const name = scope === 'project' ? 'project.spend_limit' : 'organization.spend_limit';
  if (!isObject(raw) || raw.object !== name ||
      raw.currency !== 'USD' || raw.interval !== 'month' ||
      !Number.isSafeInteger(raw.threshold_amount) ||
      Number(raw.threshold_amount) <= 0 || Number(raw.threshold_amount) > 100000000 ||
      !isObject(raw.enforcement) ||
      (raw.enforcement.status !== 'enforcing' && raw.enforcement.status !== 'inactive')) {
    throw new OfficialSpendLimitError(422, 'official_spend_limit_response_invalid');
  }
  return {
    enforcementStatus: raw.enforcement.status,
    thresholdMinor: Number(raw.threshold_amount)
  };
}
/** Two official read-only Admin API requests. No POST, grant, quota mutation,
 * provider authorization or invoice settlement. The project must be a
 * Daming-issued and tenant-owned service key scope before caller invokes us.
 */
export async function readOpenAiSpendLimitState(
  input: { projectId: string; adminKey: string; nowMs?: number },
  transport: OfficialReadTransport = readOfficialBillingJson
): Promise<OfficialSpendLimitEvidence> {
  const now = input?.nowMs ?? Date.now();
  if (!input || !/^proj_[A-Za-z0-9_-]{3,100}$/.test(input.projectId) ||
      typeof input.adminKey !== 'string' || input.adminKey.length < 12 ||
      input.adminKey.length > 4096 || /[\r\n\0]/.test(input.adminKey) ||
      !Number.isSafeInteger(now) || now <= 86400000) {
    throw new OfficialSpendLimitError(400, 'official_spend_limit_query_invalid');
  }
  // Fixed paths are constructed exclusively from a verified Admin-issued
  // project ID; redirects, proxies and user-controlled targets are forbidden.
  const [project, organization] = await Promise.all([
    transport('api.openai.com',
      '/v1/organization/projects/' + input.projectId + '/spend_limit', input.adminKey),
    transport('api.openai.com', '/v1/organization/spend_limit', input.adminKey)
  ]);
  const proj = parseLimit(project, 'project');
  const org = parseLimit(organization, 'organization');
  const active = [proj, org].filter(item => item.enforcementStatus === 'enforcing');
  return {
    source: 'openai_admin_spend_limit_api',
    projectHint: 'proj…' + input.projectId.slice(-4),
    observedAt: new Date(now).toISOString(),
    project: proj, organization: org,
    effectiveMonthlyThresholdMinor: active.length > 0
      ? Math.min(...active.map(item => item.thresholdMinor)) : null,
    officialMonthlyLimitsObserved: true,
    providerMonthlyEnforcementVerified: active.length > 0,
    spendingThresholdCurrency: 'USD', spendingThresholdInterval: 'month',
    limitMayOvershoot: true,
    precisePerRequestCashCapVerified: false,
    vendorInvoiceAuthenticated: false,
    enablesAutomaticPaidDispatch: false
  };
}
