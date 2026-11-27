import { request as httpsRequest } from 'node:https';

export type FinancialObservation = {
  readonly provider: 'openai' | 'deepseek';
  readonly source: 'openai_admin_cost_api' | 'deepseek_balance_api';
  readonly scope: 'project' | 'api_account';
  readonly scopeRef: string; // Host-only; must never be sent to the browser.
  readonly periodStart: number | null;
  readonly periodEnd: number | null;
  readonly amounts: ReadonlyArray<{ currency: 'USD' | 'CNY'; minor: number }>;
  readonly administratorReadAccess: boolean;
  readonly billingOwnerVerified: false;
  readonly modelKeyProjectLinkVerified: false;
  readonly vendorInvoiceVerified: false;
  readonly perRequestCashCapGuaranteed: false;
  readonly productionDispatchEnabled: false;
};
export type OfficialReadTransport = (
  hostname: 'api.openai.com' | 'api.deepseek.com',
  path: string, key: string
) => Promise<unknown>;
export class BillingProbeError extends Error {
  readonly status: number;
  constructor(status: number, reason: string) { super(reason); this.status = status; }
}
type Dict = Record<string, unknown>;
function object(value: unknown): value is Dict {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function wholeMinor(input: unknown): number {
  if (typeof input !== 'string' || !/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,2})?$/.test(input)) {
    throw new BillingProbeError(422, 'balance_amount_invalid');
  }
  const [major, fractional = ''] = input.split('.');
  const result = Number(major) * 100 + Number(fractional.padEnd(2, '0'));
  if (!Number.isSafeInteger(result) || result > 1000000000000) {
    throw new BillingProbeError(422, 'balance_amount_out_of_range');
  }
  return result;
}
function usdFloatMinor(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e8) {
    throw new BillingProbeError(422, 'vendor_cost_amount_invalid');
  }
  // Vendor costs can have more precision than cents. Observations are *not*
  // invoices; round only the displayed aggregate and never use for settlement.
  const cents = Math.ceil(value * 100);
  if (!Number.isSafeInteger(cents)) throw new BillingProbeError(422, 'vendor_cost_amount_invalid');
  return cents;
}
function keyValid(secret: string): boolean {
  return typeof secret === 'string' && secret.length >= 12 && secret.length <= 4096 &&
    !/[\r\n\0]/.test(secret);
}

/** Single fixed-host read only; does not follow redirects or user URLs. */
export const readOfficialBillingJson: OfficialReadTransport = async (hostname, path, key) => {
  if (!['api.openai.com', 'api.deepseek.com'].includes(hostname) ||
      typeof path !== 'string' || !path.startsWith('/') || path.includes('#') ||
      path.includes('\r') || path.includes('\n') || path.includes('@') ||
      !keyValid(key)) throw new BillingProbeError(400, 'official_billing_request_invalid');
  return await new Promise<unknown>((resolve, reject) => {
    let finished = false;
    const finish = (error?: Error, result?: unknown) => {
      if (finished) return;
      finished = true;
      if (error) reject(error);
      else resolve(result);
    };
    const req = httpsRequest({
      hostname, port: 443, protocol: 'https:', path, method: 'GET',
      headers: { Authorization: 'Bearer ' + key, Accept: 'application/json',
        'User-Agent': 'Daming-Billing-ReadOnly/1' },
      timeout: 7000, rejectUnauthorized: true
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        finish(new BillingProbeError(422, 'vendor_billing_read_denied'));
        return;
      }
      let total = 0;
      const chunks: Buffer[] = [];
      response.on('data', (data: Buffer) => {
        total += data.length;
        if (total > 128 * 1024) {
          req.destroy();
          finish(new BillingProbeError(422, 'vendor_billing_response_too_large'));
        } else chunks.push(data);
      });
      response.on('end', () => {
        try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown); }
        catch { finish(new BillingProbeError(422, 'vendor_billing_response_invalid')); }
      });
      response.on('error', () => finish(new BillingProbeError(502, 'vendor_billing_connection_failed')));
    });
    req.on('timeout', () => { req.destroy(); finish(new BillingProbeError(504, 'vendor_billing_timeout')); });
    req.on('error', () => finish(new BillingProbeError(502, 'vendor_billing_connection_failed')));
    req.end();
  });
};

/** Read-only official DeepSeek account balance, NOT a spending authorization. */
export async function probeDeepSeekBalance(
  apiKey: string, read: OfficialReadTransport = readOfficialBillingJson
): Promise<FinancialObservation> {
  if (!keyValid(apiKey)) throw new BillingProbeError(400, 'billing_credential_invalid');
  const body = await read('api.deepseek.com', '/user/balance', apiKey);
  if (!object(body) || typeof body.is_available !== 'boolean' ||
      !Array.isArray(body.balance_infos) || body.balance_infos.length < 1 ||
      body.balance_infos.length > 2) throw new BillingProbeError(422, 'vendor_balance_schema_invalid');
  const seen = new Set<string>();
  const amounts = body.balance_infos.map((line: unknown) => {
    if (!object(line) || (line.currency !== 'CNY' && line.currency !== 'USD') ||
        seen.has(line.currency)) throw new BillingProbeError(422, 'vendor_balance_currency_invalid');
    seen.add(line.currency);
    const total = wholeMinor(line.total_balance);
    const topped = wholeMinor(line.topped_up_balance);
    const granted = wholeMinor(line.granted_balance);
    if (Math.abs((topped + granted) - total) > 1) throw new BillingProbeError(422, 'vendor_balance_inconsistent');
    return { currency: line.currency as 'CNY' | 'USD', minor: total };
  });
  return {
    provider: 'deepseek', source: 'deepseek_balance_api', scope: 'api_account',
    scopeRef: 'deepseek-account', periodStart: null, periodEnd: null,
    amounts, administratorReadAccess: false,
    billingOwnerVerified: false, modelKeyProjectLinkVerified: false,
    vendorInvoiceVerified: false, perRequestCashCapGuaranteed: false,
    productionDispatchEnabled: false
  };
}

const PROJECT = /^proj_[A-Za-z0-9_-]{3,100}$/;
/** Official Admin API costs access. Project membership of the inference key
 * is NOT proven by the Admin API key, and reported costs are NOT invoices. */
export async function probeOpenAiProjectCost(
  adminKey: string, projectId: string, nowMs: number,
  read: OfficialReadTransport = readOfficialBillingJson
): Promise<FinancialObservation> {
  if (!keyValid(adminKey) || !PROJECT.test(projectId) ||
      !Number.isSafeInteger(nowMs) || nowMs < 86400000) {
    throw new BillingProbeError(400, 'openai_billing_request_invalid');
  }
  const project = await read('api.openai.com',
    '/v1/organization/projects/' + encodeURIComponent(projectId), adminKey);
  if (!object(project) || project.id !== projectId || project.object !== 'organization.project') {
    throw new BillingProbeError(422, 'openai_project_admin_access_unverified');
  }
  const end = Math.floor(nowMs / 86400000) * 86400;
  const start = end - 86400; // last COMPLETE UTC day
  const params = new URLSearchParams();
  params.set('start_time', String(start));
  params.set('end_time', String(end));
  params.set('limit', '1');
  params.append('project_ids[]', projectId);
  params.append('group_by[]', 'project_id');
  const body = await read('api.openai.com', '/v1/organization/costs?' + params.toString(), adminKey);
  if (!object(body) || body.object !== 'page' || !Array.isArray(body.data) ||
      body.data.length > 1 || body.has_more !== false || body.next_page !== null) {
    throw new BillingProbeError(422, 'openai_cost_page_incomplete');
  }
  let amount = 0;
  for (const bucket of body.data) {
    if (!object(bucket) || bucket.object !== 'bucket' ||
        bucket.start_time !== start || bucket.end_time !== end ||
        !Array.isArray(bucket.results)) {
      throw new BillingProbeError(422, 'openai_cost_bucket_invalid');
    }
    for (const record of bucket.results) {
      if (!object(record) || record.object !== 'organization.costs.result' ||
          record.project_id !== projectId || !object(record.amount) ||
          record.amount.currency !== 'usd') {
        throw new BillingProbeError(422, 'openai_cost_not_project_scoped');
      }
      amount += usdFloatMinor(record.amount.value);
      if (!Number.isSafeInteger(amount) || amount > 1000000000000) {
        throw new BillingProbeError(422, 'openai_cost_out_of_range');
      }
    }
  }
  return {
    provider: 'openai', source: 'openai_admin_cost_api', scope: 'project',
    scopeRef: projectId, periodStart: start * 1000, periodEnd: end * 1000,
    amounts: [{ currency: 'USD', minor: amount }],
    administratorReadAccess: true,
    billingOwnerVerified: false, modelKeyProjectLinkVerified: false,
    vendorInvoiceVerified: false, perRequestCashCapGuaranteed: false,
    productionDispatchEnabled: false
  };
}
