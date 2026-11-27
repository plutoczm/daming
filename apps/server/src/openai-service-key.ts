import { request } from 'node:https';

export class OpenAiKeyIssuanceError extends Error {
  readonly status: number;
  constructor(status: number, reason: string) { super(reason); this.status = status; }
}
export const PROJECT_PATTERN = /^proj_[A-Za-z0-9_-]{3,100}$/;
export const SERVICE_PATTERN = /^svc_acct_[A-Za-z0-9_-]{3,100}$/;
export const KEY_PATTERN = /^key_[A-Za-z0-9_-]{3,100}$/;
const ADMIN_KEY = /^[^\r\n\0]{12,4096}$/;

export type OpenAiAdminTransport = (
  method: 'GET' | 'POST', path: string, adminKey: string,
  body?: Record<string, unknown>
) => Promise<unknown>;

export const openAiAdminTransport: OpenAiAdminTransport = async (method, path, adminKey, body) => {
  if ((method !== 'GET' && method !== 'POST') ||
      !/^\/v1\/organization\/projects\/[A-Za-z0-9_-]+(?:\/service_accounts(?:\/[A-Za-z0-9_-]+(?:\/api_keys)?)?)?$/.test(path) ||
      typeof adminKey !== 'string' || !ADMIN_KEY.test(adminKey) ||
      (method === 'GET' && body !== undefined) ||
      (method === 'POST' && (!body || Object.keys(body).some(k =>
        !['name', 'expires_in_seconds', 'scopes'].includes(k))))) {
    throw new OpenAiKeyIssuanceError(400, 'openai_admin_request_invalid');
  }
  const bodyText = method === 'POST' ? JSON.stringify(body) : undefined;
  if (bodyText && Buffer.byteLength(bodyText) > 4096) {
    throw new OpenAiKeyIssuanceError(400, 'openai_admin_body_too_large');
  }
  return await new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(result);
    };
    const req = request({
      hostname: 'api.openai.com', protocol: 'https:', port: 443, method, path,
      rejectUnauthorized: true, timeout: 15000,
      headers: {
        authorization: 'Bearer ' + adminKey,
        accept: 'application/json', 'user-agent': 'Daming-Tenant-Admin-Key-Issuance/1',
        ...(bodyText ? { 'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(bodyText)) } : {})
      }
    }, response => {
      // Never follow redirects; no credentials can be sent to a second host.
      if (response.statusCode !== 200) {
        response.resume();
        finish(new OpenAiKeyIssuanceError(422, 'openai_admin_request_denied'));
        return;
      }
      let total = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > 64 * 1024) {
          req.destroy();
          finish(new OpenAiKeyIssuanceError(422, 'openai_admin_response_too_large'));
        } else chunks.push(chunk);
      });
      response.on('end', () => {
        try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown); }
        catch { finish(new OpenAiKeyIssuanceError(422, 'openai_admin_response_invalid')); }
      });
      response.on('error', () => finish(new OpenAiKeyIssuanceError(502, 'openai_admin_wire_error')));
    });
    req.on('timeout', () => {
      req.destroy();
      finish(new OpenAiKeyIssuanceError(504, 'openai_admin_timeout_unknown_effect'));
    });
    req.on('error', () => finish(new OpenAiKeyIssuanceError(502, 'openai_admin_wire_error')));
    req.end(bodyText);
  });
};

type Dict = Record<string, unknown>;
const obj = (value: unknown): value is Dict =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export interface OpenAiIssuedServiceKey {
  readonly keyId: string;
  readonly secret: string; // NEVER return this to a browser or log.
  readonly projectId: string;
  readonly serviceAccountId: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly officialProjectIssuanceVerified: true;
  readonly vendorBillingOwnerVerified: false;
  readonly invoiceReconciled: false;
  readonly guaranteedCashCap: false;
  readonly paidDispatchPermitted: false;
}

/** The only supported authoritative linkage is to ISSUE the workload key
 * through official Admin API for the specific project/service account.
 * Merely matching a redacted key from a list cannot prove full key identity.
 * A request that may have issued a key must NEVER be retried automatically.
 */
export async function issueOpenAiProjectServiceKey(
  input: {
    adminKey: string;
    projectId: string;
    serviceAccountId: string;
    requestId: string;
  },
  transport: OpenAiAdminTransport = openAiAdminTransport,
  clock: () => number = Date.now
): Promise<OpenAiIssuedServiceKey> {
  if (!input || !PROJECT_PATTERN.test(input.projectId) ||
      !SERVICE_PATTERN.test(input.serviceAccountId) ||
      typeof input.adminKey !== 'string' || !ADMIN_KEY.test(input.adminKey) ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(input.requestId)) {
    throw new OpenAiKeyIssuanceError(400, 'openai_service_key_input_invalid');
  }
  const base = '/v1/organization/projects/' + input.projectId;
  const project = await transport('GET', base, input.adminKey);
  if (!obj(project) || project.id !== input.projectId ||
      project.object !== 'organization.project') {
    throw new OpenAiKeyIssuanceError(422, 'openai_admin_project_not_verified');
  }
  const account = await transport('GET',
    base + '/service_accounts/' + input.serviceAccountId, input.adminKey);
  if (!obj(account) || account.id !== input.serviceAccountId ||
      account.object !== 'organization.project.service_account' ||
      account.role !== 'member') {
    throw new OpenAiKeyIssuanceError(422, 'openai_service_account_role_not_verified');
  }
  const createdAt = clock();
  const response = await transport('POST',
    base + '/service_accounts/' + input.serviceAccountId + '/api_keys',
    input.adminKey,
    {
      name: 'daming-' + input.requestId.slice(0, 8),
      scopes: ['api.responses.write'],
      expires_in_seconds: 3600
    });
  if (!obj(response) ||
      response.object !== 'organization.project.service_account.api_key' ||
      typeof response.id !== 'string' || !KEY_PATTERN.test(response.id) ||
      typeof response.value !== 'string' || !ADMIN_KEY.test(response.value) ||
      !Number.isSafeInteger(response.created_at) ||
      !Number.isSafeInteger(response.expires_at) ||
      Number(response.created_at) * 1000 > createdAt + 60000 ||
      Number(response.expires_at) * 1000 <= createdAt ||
      Number(response.expires_at) * 1000 > createdAt + 3900000) {
    // The key MAY have been created even when the response is malformed;
    // its one-hour TTL is an additional recovery boundary, not a rollback.
    throw new OpenAiKeyIssuanceError(409, 'openai_key_issuance_result_uncertain');
  }
  return {
    keyId: response.id, secret: response.value,
    projectId: input.projectId, serviceAccountId: input.serviceAccountId,
    issuedAtMs: Number(response.created_at) * 1000,
    expiresAtMs: Number(response.expires_at) * 1000,
    officialProjectIssuanceVerified: true,
    vendorBillingOwnerVerified: false,
    invoiceReconciled: false, guaranteedCashCap: false,
    paidDispatchPermitted: false
  };
}
