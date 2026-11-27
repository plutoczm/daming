import type { CodexModelForward } from '@daming/worker-process';
import type { MagpiePinnedBinding } from './magpie-host.ts';
import { validPinnedMagpieBinding } from './magpie-codex-subscription.ts';

export type MagpieForwardAuthorization =
  (body: string, signal: AbortSignal, launch: () => Promise<Response>) => Promise<Response>;
export type MagpieProjectWire = 'responses_http' | 'messages_http';

export interface PinnedMagpieTurnOptions {
  readonly binding: MagpiePinnedBinding;
  /** Recheck the running binary capability and exact live catalog binding. */
  readonly checkCurrent: () => Promise<void>;
  readonly request: (method: 'POST' | 'DELETE', path: string, body?: object) => Promise<unknown>;
  readonly forward: (key: string, body: string, signal: AbortSignal) => Promise<Response>;
  readonly authorizeForward?: MagpieForwardAuthorization;
}

/** Host capability only: callers must perform identity/approval/budget admission.
 * This function does not authorize a paid task or settle any cash reservation.
 */
export async function withPinnedMagpieTurn<T>(options: PinnedMagpieTurnOptions,
  use: (send: CodexModelForward) => Promise<T>): Promise<T> {
  const binding = { ...options.binding };
  if (!validPinnedMagpieBinding(binding)) {
    throw new Error('magpie_codex_binding_invalid');
  }
  const model = binding.providerId + '/' + binding.modelId;
  const account = binding.providerId + '/' + binding.accountRef;
  await options.checkCurrent();
  let keyId: string | undefined;
  let closed = false;
  let consumed = false;
  const lifetime = new AbortController();
  try {
    const raw = await options.request('POST', '/v1/magpie/keys', {
      name: 'daming-codex-one-turn', ttl: '1m', models: [model], accounts: [account],
      tokens: 32768, cost: 0, singleUpstream: true
    });
    const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    if (typeof value.id === 'string' && /^[a-zA-Z0-9_-]{10,80}$/.test(value.id)) keyId = value.id;
    if (!keyId || typeof value.key !== 'string' || !/^sk-magpie-key-[A-Za-z0-9_-]+$/.test(value.key) ||
        !Array.isArray(value.models) || value.models.length !== 1 || value.models[0] !== model ||
        !Array.isArray(value.accounts) || value.accounts.length !== 1 || value.accounts[0] !== account ||
        value.singleUpstream !== true || value.readOnly === true ||
        typeof value.expires !== 'string' || !Number.isFinite(Date.parse(value.expires)) ||
        Date.parse(value.expires) <= Date.now() || Date.parse(value.expires) > Date.now() + 65000) {
      throw new Error('magpie_codex_key_scope_unverified');
    }
    const key = value.key;
    return await use(async (body, signal) => {
      if (closed) throw new Error('magpie_codex_turn_closed');
      if (consumed) throw new Error('magpie_codex_turn_consumed');
      if (signal.aborted) throw new Error('magpie_codex_turn_aborted');
      if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > 256 * 1024) throw new Error('magpie_codex_request_invalid');
      let value: unknown;
      try { value = JSON.parse(body); } catch { throw new Error('magpie_codex_request_invalid'); }
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
          (value as Record<string, unknown>).model !== model || (value as Record<string, unknown>).stream !== true) {
        throw new Error('magpie_codex_request_invalid');
      }
      consumed = true;
      // Bind/recheck before network, with the permit already permanently consumed.
      await options.checkCurrent();
      const outbound = AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(60000)]);
      if (outbound.aborted) throw new Error('magpie_codex_turn_aborted');
      const launch = () => options.forward(key, body, outbound);
      if (options.authorizeForward) return options.authorizeForward(body, outbound, launch);
      try {
        return await launch();
      } catch { throw new Error('magpie_codex_transport_failed_cash_unknown'); }
    });
  } finally {
    closed = true;
    lifetime.abort();
    if (keyId) {
      try { await options.request('DELETE', '/v1/magpie/keys/' + keyId); }
      catch { throw new Error('magpie_codex_key_revocation_uncertain'); }
    }
  }
}
