import { createHash } from 'node:crypto';
import { SseReader } from '@daming/model-gateway';
import type { ProjectSendIntent } from '@daming/governance';
import type { CodexModelForward } from '@daming/worker-process';
import type { MagpieUnifiedCatalog, MagpieUnifiedTarget } from './magpie-unified-targets.ts';
import type { ProviderKind } from './identity-registry.ts';
import type { MagpieHost, MagpiePinnedBinding } from './magpie-host.ts';
import type { ProjectPaidEgress } from './trusted-paid-egress.ts';
import type { MagpieProjectWire } from './magpie-codex-turn.ts';

/**
 * Magpie remains the ROUTE CATALOG owner. This planner never obtains a
 * subscription OAuth token, chooses a dynamic group member, or changes
 * Magpie's native fallback algorithm. Cash-governed calls must PIN one
 * verified Daming BYOA credential before the first network byte.
 */
export type TenantRouteAccount = {
  credentialId: string;
  provider: ProviderKind;
  modelId: string;
  expiresAt: string;
};
export type TenantRouteCandidate = {
  targetId: string;
  kind: 'llm' | 'agent-backed' | 'route-group';
  eligibility: 'pinned_independent_api' |
    'subscription_agent_requires_native_isolation_and_entitlement' |
    'native_group_requires_final_account_receipt' |
    'model_and_tenant_account_not_bound';
  credentialId: string | null;
  provider: ProviderKind | null;
  modelId: string | null;
  autoPaidDispatchPermitted: false;
};
export type FrozenTenantRoutePlan = {
  source: 'magpie-native-routing';
  checkedAt: string;
  selected: TenantRouteCandidate | null;
  candidates: readonly TenantRouteCandidate[];
  routeSelectionOnly: true;
  nativeMagpieFallbackDisabled: true;
  paidDispatchPermitted: false;
  guaranteedCashCeiling: false;
};
const SAFE_TARGET = /^[a-z0-9][a-z0-9._:/+\-]{0,159}$/i;
function eligibleAccount(target: MagpieUnifiedTarget,
  accounts: readonly TenantRouteAccount[], nowMs: number): TenantRouteAccount | null {
  if (target.kind !== 'llm' || target.providerId == null ||
      !['openai','deepseek'].includes(target.providerId) ||
      !target.targetId.startsWith(target.providerId + '/')) return null;
  const model = target.targetId.slice(target.providerId.length + 1);
  if (!model || model.includes('://') || model.includes('..') || !SAFE_TARGET.test(model)) return null;
  const matching = accounts.filter(a =>
    a.provider === target.providerId && a.modelId === model &&
    typeof a.credentialId === 'string' &&
    /^[a-f0-9-]{36}$/i.test(a.credentialId) &&
    Number.isFinite(Date.parse(a.expiresAt)) && Date.parse(a.expiresAt) > nowMs);
  // A duplicated model may belong to two different billing accounts. Route
  // selection must not guess which one to charge.
  return matching.length === 1 ? matching[0] : null;
}
export function planGovernedMagpieTargets(
  catalog: MagpieUnifiedCatalog,
  accounts: readonly TenantRouteAccount[],
  options: { preferredTargets?: readonly string[]; nowMs?: number } = {}
): FrozenTenantRoutePlan {
  const nowMs = options.nowMs ?? Date.now();
  const age = nowMs - Date.parse(catalog?.checkedAt ?? '');
  if (!catalog || catalog.source !== 'magpie-native-routing' ||
      !Number.isFinite(age) || age < 0 || age > 120000 ||
      !Array.isArray(catalog.targets) || catalog.targets.length > 160 ||
      !Array.isArray(accounts) || accounts.length > 100) {
    throw new Error('governed_magpie_catalog_missing_or_stale');
  }
  const usedTargets = new Set<string>();
  const candidates = catalog.targets.map(target => {
    if (!target || target.ready !== true ||
        typeof target.targetId !== 'string' ||
        !SAFE_TARGET.test(target.targetId) ||
        target.targetId.includes('..') || target.targetId.includes('://') ||
        usedTargets.has(target.targetId) ||
        !['llm','agent-backed','route-group'].includes(target.kind)) {
      throw new Error('governed_magpie_target_invalid');
    }
    usedTargets.add(target.targetId);
    const linked = eligibleAccount(target, accounts, nowMs);
    let eligibility: TenantRouteCandidate['eligibility'];
    if (target.kind === 'agent-backed') {
      eligibility = 'subscription_agent_requires_native_isolation_and_entitlement';
    } else if (target.kind === 'route-group') {
      // Native group membership, account rotation and fallbacks are opaque
      // to Daming's ledger. No arbitrary group redirect into the paid proxy.
      eligibility = 'native_group_requires_final_account_receipt';
    } else eligibility = linked ? 'pinned_independent_api' :
      'model_and_tenant_account_not_bound';
    return {
      targetId: target.targetId, kind: target.kind,
      eligibility, credentialId: linked?.credentialId ?? null,
      provider: linked?.provider ?? null, modelId: linked?.modelId ?? null,
      autoPaidDispatchPermitted: false as const
    };
  });
  const priority = options.preferredTargets ?? [];
  if (!Array.isArray(priority) || priority.length > 20 ||
      priority.some(s => typeof s !== 'string' || !SAFE_TARGET.test(s))) {
    throw new Error('governed_magpie_preference_invalid');
  }
  const eligible = candidates.filter(c => c.eligibility === 'pinned_independent_api');
  // Deterministic, non-paid automatic TARGET SELECTION, not automatic paid
  // execution. Per request owner consent and a settled vendor invoice remain
  // independent hard blockers.
  eligible.sort((a,b) => {
    const ai = priority.indexOf(a.targetId), bi = priority.indexOf(b.targetId);
    const ar = ai === -1 ? Number.MAX_SAFE_INTEGER : ai;
    const br = bi === -1 ? Number.MAX_SAFE_INTEGER : bi;
    return ar - br || a.targetId.localeCompare(b.targetId);
  });
  return {
    source: 'magpie-native-routing', checkedAt: catalog.checkedAt,
    selected: eligible[0] ?? null, candidates,
    routeSelectionOnly: true, nativeMagpieFallbackDisabled: true,
    paidDispatchPermitted: false, guaranteedCashCeiling: false
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** A native Messages client uses the vendor model name; Magpie addresses a fixed provider/model. */
export function qualifyNativeMessagesRequest(binding: MagpiePinnedBinding, raw: string, maximumOutputTokens: number): string {
  const body = asRecord(JSON.parse(raw));
  if (body?.model !== binding.modelId || body.stream !== true || !Array.isArray(body.messages) ||
      !Number.isSafeInteger(maximumOutputTokens) || maximumOutputTokens < 1 || typeof body.max_tokens !== 'number' ||
      !Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > maximumOutputTokens) {
    throw new Error('Magpie native Messages model binding denied');
  }
  return JSON.stringify({ ...body, model: binding.providerId + '/' + binding.modelId });
}

function observeModelStream(upstream: Response, signal: AbortSignal, wire: MagpieProjectWire) {
  if (upstream.status !== 200 || !/^text\/event-stream(?:\s*;|$)/i.test(upstream.headers.get('content-type') ?? '') ||
      !upstream.body) {
    void upstream.body?.cancel().catch(() => {});
    throw new Error('Magpie terminal receipt unavailable');
  }
  const raw = upstream.body.getReader();
  const terminal = Promise.withResolvers<string>();
  let responseId: string | undefined;
  let complete = false;
  let stopReason: string | undefined;
  const messages = wire === 'messages_http';
  let closed = false;
  const decoder = new SseReader((value, name) => {
    const frame = asRecord(value);
    const type = frame?.type;
    if (typeof type !== 'string' || (name && name !== type) || complete ||
        ['error', 'response.failed', 'response.incomplete'].includes(type)) {
      throw new Error('Invalid Magpie terminal stream');
    }
    const response = asRecord(messages ? frame?.message : frame?.response);
    if (type === (messages ? 'message_start' : 'response.created')) {
      if (responseId || typeof response?.id !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(response.id)) {
        throw new Error('Invalid Magpie response identity');
      }
      responseId = response.id;
    } else if (messages && type === 'message_delta') {
      const stop = asRecord(frame?.delta)?.stop_reason;
      if (stop !== undefined && stop !== null) {
        if (!responseId || stopReason || typeof stop !== 'string' ||
            !['end_turn', 'tool_use', 'max_tokens', 'stop_sequence', 'refusal'].includes(stop)) {
          throw new Error('Invalid Magpie Messages stop reason');
        }
        stopReason = stop;
      }
    } else if (messages && type === 'message_stop') {
      if (!responseId || !stopReason) throw new Error('Invalid Magpie Messages terminal receipt');
      complete = true;
    } else if (!messages && type === 'response.completed') {
      if (!responseId || response?.id !== responseId || response.status !== 'completed') {
        throw new Error('Invalid Magpie terminal receipt');
      }
      complete = true;
    }
  });
  function settle(error?: unknown) {
    if (closed) return;
    closed = true;
    signal.removeEventListener('abort', abort);
    if (error) terminal.reject(error);
    else terminal.resolve((messages ? 'Magpie Messages terminal ' : 'Magpie Responses terminal ') + responseId!);
    void raw.cancel().catch(() => {});
  }
  function abort() { settle(new Error('Magpie terminal receipt interrupted')); }
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (signal.aborted) throw new Error('Magpie terminal receipt interrupted');
        const chunk = await raw.read();
        if (chunk.done) throw new Error('Magpie stream ended without terminal receipt');
        decoder.push(chunk.value);
        if (complete) {
          decoder.finish();
          settle();
        }
        controller.enqueue(chunk.value);
        if (complete) controller.close();
      } catch (error) {
        settle(error);
        controller.error(error);
      }
    },
    cancel() { settle(new Error('Magpie terminal receipt cancelled')); },
  });
  return {
    response: new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } }),
    terminal: terminal.promise,
  };
}

/** Host-only adapter for a pre-approved exact streaming request on a pinned account. */
export async function withGovernedProjectMagpieTurn<T>(
  host: Pick<MagpieHost, 'withPinnedModel'>, binding: MagpiePinnedBinding, egress: ProjectPaidEgress,
  intent: ProjectSendIntent, use: (send: CodexModelForward) => Promise<T>,
): Promise<T> {
  const wire = intent.protocol;
  if (!host.withPinnedModel || intent.provider !== binding.providerId || intent.model !== binding.modelId ||
      intent.accountRef !== binding.accountRef || (wire !== 'responses_http' && wire !== 'messages_http')) {
    throw new Error('Magpie project route binding denied');
  }
  const approved = { ...intent, quote: { ...intent.quote } };
  let completion: Promise<undefined> | undefined;
  try {
    return await host.withPinnedModel(binding, use, (body, signal, launch) => {
      if (createHash('sha256').update(body, 'utf8').digest('hex') !== approved.requestDigest) {
        throw new Error('Magpie project request binding denied');
      }
      const ready = Promise.withResolvers<Response>();
      completion = egress.send(approved, async () => {
        const observed = observeModelStream(await launch(), signal, wire);
        ready.resolve(observed.response);
        return { value: undefined, reference: await observed.terminal };
      });
      void completion.catch(ready.reject);
      return ready.promise;
    }, wire);
  } finally {
    await completion;
  }
}
