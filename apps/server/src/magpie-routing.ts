import { createHmac } from 'node:crypto';
import type { MagpieRouteCatalogView, MagpieRouteCandidateView } from '@daming/contracts';

// The public catalog never includes a Magpie key fingerprint, masked key,
// provider URLs, login identity, raw model object, or billing detail.
export interface MagpieRoutingCandidate extends MagpieRouteCandidateView {
  readonly accountRef: string; // Host-only stable Magpie KeyInfo.ID
}
export interface MagpieRoutingCatalog {
  readonly instanceId: string;
  readonly candidates: readonly MagpieRoutingCandidate[];
  readonly checkedAt: string;
}

const ROUTE_ID = /^[a-z0-9][a-z0-9._:/-]{0,99}$/i;
const KEY_ID = /^[a-f0-9]{10}$/i;
function record(value: unknown): Record<string, unknown> | null {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function routeId(value: unknown): value is string {
  return typeof value === 'string' && ROUTE_ID.test(value) && !value.includes('..') &&
    !/^(?:sk-|bearer|ghp_|token[-_]|key[-_])/i.test(value);
}
function keyUsable(value: unknown): value is Record<string, unknown> {
  const k = record(value);
  return !!k && typeof k.id === 'string' && KEY_ID.test(k.id) && k.on === true &&
    k.rest == null && !(record(k.spend)?.held === true);
}

/**
 * Catalog is a snapshot, not a provider execution permit. When there are
 * multiple API keys, an HMAC using the private instance admin secret names a
 * specific key without disclosing its fingerprint to the browser.
 */
export function projectMagpieRoutingCatalog(raw: unknown, instanceId: string, privateKey?: string): MagpieRoutingCatalog {
  if (!/^[a-f0-9]{32}$/i.test(instanceId)) throw new Error('magpie_route_instance_invalid');
  const source = record(raw);
  const providers = Array.isArray(raw) ? raw : source?.providers;
  if (!Array.isArray(providers)) throw new Error('magpie_route_catalog_invalid');
  const candidates: MagpieRoutingCandidate[] = [];
  const seen = new Set<string>();
  for (const item of providers.slice(0, 100)) {
    const p = record(item);
    if (!p || !routeId(p.id) || p.ready !== true || p.off === true || p.account != null) continue;
    if (!Array.isArray(p.keyList) || p.keyList.length === 0 || p.keyList.length > 100 ||
        !Array.isArray(p.models)) continue;
    const usable = p.keyList.filter(keyUsable);
    // Do not create a public guessable account ref when multiple keys exist.
    if (p.keyList.length > 1 && (!privateKey || privateKey.length < 16)) continue;
    for (const model of p.models.slice(0, 100)) {
      const modelId = typeof model === 'string' ? model : record(model)?.id;
      if (!routeId(modelId)) continue;
      for (const [index, key] of usable.entries()) {
        const ref = String(key.id);
        const suffix = p.keyList.length === 1 ? '' : '|' +
          createHmac('sha512', privateKey!).update(instanceId + '\0' + p.id + '\0' + modelId + '\0' + ref)
            .digest('hex').slice(0, 24);
        const candidateId = p.id + '|' + modelId + suffix;
        if (seen.has(candidateId)) continue;
        seen.add(candidateId);
        candidates.push({
          candidateId, providerId: p.id, modelId,
          accountType: p.keyList.length === 1 ? 'single-api-key' : 'api-key',
          accountLabel: p.keyList.length === 1 ? '唯一已启用 API Key' : 'API Key ' + (index + 1),
          accountRef: ref
        });
        if (candidates.length >= 64) break;
      }
      if (candidates.length >= 64) break;
    }
    if (candidates.length >= 64) break;
  }
  return { instanceId, candidates, checkedAt: new Date().toISOString() };
}

export function publicMagpieRoutingCatalog(catalog: MagpieRoutingCatalog | null): MagpieRouteCatalogView {
  return {
    source: 'magpie', status: catalog ? 'ready' : 'unavailable',
    checkedAt: catalog?.checkedAt ?? new Date().toISOString(),
    accountIdentityExposed: false, dispatchEnabled: false,
    candidates: catalog?.candidates.map(({ accountRef: _private, ...item }) => item) ?? []
  };
}
