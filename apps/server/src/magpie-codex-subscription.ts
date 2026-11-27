import type { MagpiePinnedBinding } from './magpie-host.ts';

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Host-only native picker. Never exports login names, plans, tokens or account URLs. */
export function selectCodexSubscriptionBinding(raw: unknown, instanceId: string, modelId: string): MagpiePinnedBinding {
  const value = object(raw);
  if (!/^[a-f0-9]{32}$/i.test(instanceId) || !/^gpt-[a-z0-9][a-z0-9._-]{0,90}$/i.test(modelId) || modelId.includes('..') ||
      !value || !Array.isArray(value.models) || !Array.isArray(value.accounts) || value.models.length > 10000 || value.accounts.length > 500) {
    throw new Error('magpie_codex_subscription_catalog_invalid');
  }
  const target = 'codex/' + modelId;
  const models = value.models.map(object).filter(m => m?.id === target && m.provider === 'codex' && m.group !== true && m.decides !== true);
  if (models.length !== 1) throw new Error('magpie_codex_subscription_model_unavailable');
  const accounts = value.accounts.map(object).filter(a => a?.provider === 'codex' && a.account === true && a.key !== true);
  if (accounts.length !== 1 || typeof accounts[0]?.id !== 'string' || !/^codex\/[a-f0-9]{16}$/i.test(accounts[0].id)) {
    throw new Error('magpie_codex_subscription_account_missing_or_ambiguous');
  }
  return { instanceId, providerId: 'codex', modelId, accountRef: accounts[0].id.slice('codex/'.length), accountKind: 'codex-subscription' };
}

/** Keep the original API-key fingerprint contract distinct from subscription ids. */
export function validPinnedMagpieBinding(binding: MagpiePinnedBinding): boolean {
  return !!binding && /^[a-f0-9]{32}$/i.test(binding.instanceId) &&
    [binding.providerId, binding.modelId].every(s => typeof s === 'string' && /^[a-z0-9][a-z0-9._:/-]{0,99}$/i.test(s) && !s.includes('..') && !s.includes('://')) &&
    (binding.accountKind === 'codex-subscription'
      ? binding.providerId === 'codex' && /^[a-f0-9]{16}$/i.test(binding.accountRef)
      : (binding.accountKind === undefined || binding.accountKind === 'api-key') && /^[a-f0-9]{10}$/i.test(binding.accountRef));
}
