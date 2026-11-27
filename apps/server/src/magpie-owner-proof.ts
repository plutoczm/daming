import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import type { ProviderKind, CredentialBinding } from './identity-registry.ts';

export class KeyControlError extends Error {}

/**
 * This code is the only place using Magpie's 40-bit legacy SHA-256 KeyID.
 * It is used solely to locate a candidate, NEVER as proof by itself: a
 * constant-time full-byte match and an official vendor read are mandatory.
 */
function magpieCompatibilityKeyId(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 10);
}
function exactKey(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8'), right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function officialChatEndpoint(raw: unknown, provider: ProviderKind): boolean {
  if (typeof raw !== 'string') return false;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password ||
        url.port || url.search || url.hash) return false;
    if (provider === 'openai') return url.hostname === 'api.openai.com' &&
      (url.pathname === '/v1' || url.pathname === '/v1/');
    if (provider === 'deepseek') return url.hostname === 'api.deepseek.com' &&
      ['', '/', '/v1', '/v1/'].includes(url.pathname);
    return false;
  } catch { return false; }
}

/**
 * Read the Host-owned Magpie profile to compare the ENTIRE credential, not
 * the 10-hex fingerprint. A custom relay, symlink, or changed account fails
 * closed. This never writes to the profile or sends any request.
 */
export function proveExactMagpieCredential(
  configDir: string, binding: CredentialBinding, provider: ProviderKind, candidateKey: string
): boolean {
  if (!/^[a-f0-9]{32}$/i.test(binding.instanceId) ||
      !/^[a-f0-9]{10}$/i.test(binding.accountRef) ||
      !/^[a-z0-9][a-z0-9._/-]{0,99}$/i.test(binding.providerId) ||
      !['openai','deepseek'].includes(provider) ||
      !candidateKey || candidateKey.length > 4096) return false;
  const path = join(configDir, 'magpie', 'providers.json');
  try {
    if (!lstatSync(join(configDir, 'magpie')).isDirectory() ||
        lstatSync(join(configDir, 'magpie')).isSymbolicLink() ||
        lstatSync(path).isSymbolicLink() ||
        lstatSync(path).size > 2 * 1024 * 1024) return false;
    const payload: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    const providers = (payload as Record<string, unknown>).providers;
    if (!Array.isArray(providers)) return false;
    const matching = providers.filter((v) => v && typeof v === 'object' && !Array.isArray(v) &&
      (v as Record<string, unknown>).id === binding.providerId);
    if (matching.length !== 1) return false;
    const p = matching[0] as Record<string, unknown>;
    if (p.off === true || p.account != null || !officialChatEndpoint(p.chat, provider)) return false;
    // Initial trust policy: only a single official OpenAI-compatible wire.
    // Alternate protocols, proxies and account fallbacks might send the
    // credential to a different endpoint or change who is billed.
    if (p.insecureTLS === true ||
        ['responses', 'anthropic', 'gemini', 'decide', 'proxy', 'accountProxies'].some(name => {
          const value = p[name];
          return value != null && value !== '' &&
            (!Array.isArray(value) || value.length > 0);
        }) ||
        (Array.isArray(p.fallback) ? p.fallback.length > 0 : p.fallback != null)) return false;
    const possible = [p.key, ...(Array.isArray(p.keys)
      ? p.keys.map((v) => v && typeof v === 'object' ? (v as Record<string, unknown>).key : undefined)
      : [])].filter((v): v is string => typeof v === 'string' && v.length > 0);
    const located = possible.filter((key) => magpieCompatibilityKeyId(key) === binding.accountRef);
    return located.length === 1 && exactKey(located[0], candidateKey);
  } catch { return false; }
}

const OFFICIAL_ENDPOINTS: Record<ProviderKind, { host: string; path: string }> = {
  openai: { host: 'api.openai.com', path: '/v1/models' },
  deepseek: { host: 'api.deepseek.com', path: '/models' }
};

/**
 * A successful *read-only* authenticated GET demonstrates control of the API
 * key, not ownership of the billing account. No chat, tools, or token billing.
 * No user-supplied URLs, redirects, proxies, or custom CAs.
 */
export async function verifyVendorKeyControl(provider: ProviderKind, secret: string, modelId: string): Promise<boolean> {
  const endpoint = OFFICIAL_ENDPOINTS[provider];
  if (!endpoint || secret.length < 12 || secret.length > 4096 || /[\r\n\0]/.test(secret) ||
      !/^[a-z0-9][a-z0-9._:/-]{0,99}$/i.test(modelId)) return false;
  return await new Promise<boolean>((resolve) => {
    let done = false, count = 0;
    const finish = (result: boolean) => { if (!done) { done = true; resolve(result); } };
    const req = httpsRequest({
      protocol: 'https:', host: endpoint.host, port: 443, path: endpoint.path, method: 'GET',
      headers: { Authorization: 'Bearer ' + secret, Accept: 'application/json',
        'User-Agent': 'Daming-BYOA-KeyControl/1' },
      rejectUnauthorized: true, timeout: 7000
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); finish(false); return; }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        count += chunk.length;
        if (count > 256 * 1024) { req.destroy(); finish(false); return; }
        chunks.push(chunk);
      });
      res.on('end', () => {
        try {
          const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const valid = !!data && typeof data === 'object' && !Array.isArray(data) &&
            (data as Record<string, unknown>).object === 'list' &&
            Array.isArray((data as Record<string, unknown>).data) &&
            ((data as Record<string, unknown>).data as unknown[]).some(item =>
              !!item && typeof item === 'object' && !Array.isArray(item) &&
              (item as Record<string, unknown>).id === modelId);
          finish(valid);
        } catch { finish(false); }
      });
      res.on('error', () => finish(false));
    });
    req.on('error', () => finish(false));
    req.on('timeout', () => { req.destroy(); finish(false); });
    req.end();
  });
}
