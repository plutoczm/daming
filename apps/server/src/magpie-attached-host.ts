import { randomBytes } from 'node:crypto';
import { projectMagpieGatewayTargets } from './magpie-unified-targets.ts';
import { summarizeMagpieRead } from './magpie-safe.ts';
import type { MagpieHost } from './magpie-host.ts';
import type { MagpieStatusView } from '@daming/contracts';

/**
 * Non-invasive attachment to an existing Magpie DESKTOP / gateway instance.
 * Only loopback is allowed; does not copy accounts, start/stop Magpie,
 * install plugins, change routes, issue keys or send inference requests.
 *
 * A user-issued gateway key must be injected via environment variables.
 * The key never enters the browser, SQLite, mission events or logs.
 */
export function createAttachedMagpieHost(config: {
  readonly port: number; readonly key: string
}): MagpieHost {
  if (!config || !Number.isSafeInteger(config.port) ||
      config.port < 1 || config.port > 65535 ||
      typeof config.key !== 'string' || config.key.length < 16 ||
      config.key.length > 4096 || /[\r\n\0]/.test(config.key)) {
    throw new Error('existing_magpie_configuration_invalid');
  }
  const id = randomBytes(16).toString('hex');
  async function readModels(): Promise<unknown> {
    // Verify the loopback listener really presents the Magpie gateway
    // identity BEFORE sending the gateway key in an Authorization header.
    const hello = await fetch('http://127.0.0.1:' + config.port + '/api/hello', {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(2000)
    });
    if (!hello.ok || Number(hello.headers.get('content-length')) > 4096) {
      throw new Error('existing_magpie_gateway_identity_unavailable');
    }
    const greeting: unknown = await hello.json();
    if (!greeting || typeof greeting !== 'object' ||
        (greeting as Record<string, unknown>).name !== 'magpie') {
      throw new Error('existing_magpie_gateway_identity_mismatch');
    }
    const response = await fetch('http://127.0.0.1:' + config.port + '/v1/models', {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + config.key, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(4000)
    });
    if (!response.ok) throw new Error('existing_magpie_gateway_unavailable');
    if (!(response.headers.get('content-type') ?? '').includes('json')) {
      throw new Error('existing_magpie_gateway_invalid_content');
    }
    if (Number(response.headers.get('content-length')) > 256 * 1024) {
      throw new Error('existing_magpie_catalog_too_large');
    }
    if (!response.body) throw new Error('existing_magpie_empty_response');
    const reader = response.body.getReader();
    const blocks: Buffer[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 256 * 1024) throw new Error('existing_magpie_catalog_too_large');
        blocks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    let result: unknown;
    try { result = JSON.parse(Buffer.concat(blocks).toString('utf8')); }
    catch { throw new Error('existing_magpie_catalog_json_invalid'); }
    // Trust only Magpie-compatible model syntax; never return the raw
    // account-bearing payload to a browser.
    projectMagpieGatewayTargets(result);
    return result;
  }
  const status = async (): Promise<MagpieStatusView> => {
    try {
      await readModels();
      return { enabled: true, running: true, configured: true,
        version: 'existing-gateway', checkedAt: new Date().toISOString(),
        reason: 'connected_existing_magpie_without_modifications' };
    } catch {
      return { enabled: true, running: false, configured: false,
        version: 'existing-gateway', checkedAt: new Date().toISOString(),
        reason: 'existing_magpie_gateway_unavailable_or_key_invalid' };
    }
  };
  return {
    ensure: status, status,
    async unifiedTargets() {
      return projectMagpieGatewayTargets(await readModels());
    },
    async read(alias) {
      if (alias !== 'models') throw new Error('existing_magpie_read_not_allowed');
      return summarizeMagpieRead('models', await readModels());
    },
    async post() {
      throw new Error('existing_magpie_mutations_not_allowed');
    },
    // Intentional: this attached key does NOT authorize account-level pinning,
    // key issuance, plugin management, or production model dispatch.
    async routingCatalog() {
      return { instanceId: id, candidates: [], checkedAt: new Date().toISOString() };
    },
    async scopeCapability() { return false; },
    stop() { /* Existing Magpie instance belongs to the user. Never stop it. */ }
  };
}
