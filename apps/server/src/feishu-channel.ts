import { createHash, timingSafeEqual } from 'node:crypto';
import { ConflictError, DomainError } from '@daming/core';
import type { Engine } from '@daming/core';

/**
 * Feishu (Lark) human-decision channel — Host side.
 *
 * This module is deliberately transport-injected: `send` is the only outbound
 * edge and the ONLY place a real Feishu message may be produced. Tests inject a
 * fake transport. Nothing here reads environment secrets or opens a socket.
 *
 * Trust model (AC-011-3):
 *  - Only the project owner's Feishu `open_id` (bound at publish time by the
 *    authenticated Host) may act. A callback carrying any other open_id is a
 *    spoof attempt and is rejected.
 *  - Every inbound callback must carry a valid Feishu signature
 *    `sha256(timestamp + nonce + encryptKey + rawBody)`, a matching
 *    verification token, and a fresh timestamp; reused nonces / event ids are
 *    rejected (no replay).
 *  - A card is single-use: once answered it is immutable. A duplicate or
 *    expired card is never applied twice (Engine also de-dupes by event id).
 *  - Decisions are written only through the single Engine writer with
 *    `actorId` derived from the authenticated project owner, never from the
 *    callback body.
 */

export type FeishuActionKind = 'approve' | 'reject' | 'accept' | 'reply' | 'pause';
export type FeishuDecisionKind = 'clarification' | 'proposal' | 'acceptance';

export interface FeishuCardButton {
  readonly action: FeishuActionKind;
  readonly label: string;
}

export interface FeishuCard {
  readonly projectId: string;
  readonly decisionId: string;
  readonly targetRevision: number;
  readonly decisionKind: FeishuDecisionKind;
  readonly ownerOpenId: string;
  readonly title: string;
  readonly body: string;
  readonly buttons: readonly FeishuCardButton[];
  readonly expiresAtMs: number;
}

export interface FeishuSendResult {
  readonly messageId: string;
}

export type FeishuTransport = (card: FeishuCard) => Promise<FeishuSendResult>;

export interface FeishuCardRecord {
  readonly messageId: string;
  readonly projectId: string;
  readonly decisionId: string;
  readonly targetRevision: number;
  readonly decisionKind: FeishuDecisionKind;
  readonly ownerOpenId: string;
  readonly expiresAtMs: number;
  readonly actions: readonly FeishuActionKind[];
  status: 'pending' | 'answered' | 'expired';
  chosenAction?: FeishuActionKind;
  answeredByOpenId?: string;
  answeredAt?: string;
}

export interface FeishuCardRepository {
  save(record: FeishuCardRecord): void;
  get(messageId: string): FeishuCardRecord | undefined;
}

export class MemoryFeishuCardRepository implements FeishuCardRepository {
  private readonly records = new Map<string, FeishuCardRecord>();
  save(record: FeishuCardRecord): void {
    this.records.set(record.messageId, Object.freeze({ ...record }));
  }
  get(messageId: string): FeishuCardRecord | undefined {
    const found = this.records.get(messageId);
    return found ? Object.freeze({ ...found }) : undefined;
  }
}

export interface FeishuEnvelope {
  readonly timestamp: string;
  readonly nonce: string;
  readonly signature: string;
  readonly rawBody: string;
}

export interface FeishuCallbackBody {
  readonly schema: '2.0';
  readonly header: {
    readonly event_id: string;
    readonly event_type: 'card.action.trigger';
    readonly token: string;
    readonly create_time: string;
  };
  readonly event: {
    readonly operator: { readonly open_id: string };
    readonly action: {
      readonly tag: 'button';
      /** JSON: { messageId, decisionId, action, text? } */
      readonly value: string;
    };
  };
}

interface FeishuChannelOptionsBase {
  readonly transport: FeishuTransport;
  readonly repository: FeishuCardRepository;
  readonly engine: Engine;
  readonly now: () => number;
  /** Owner pause/stop request. Receives the authenticated project id. */
  readonly pause?: (projectId: string) => void | Promise<void>;
  readonly maxSkewSeconds?: number;
  readonly maxNonces?: number;
}

export type FeishuChannelOptions = FeishuChannelOptionsBase & (
  { readonly encryptKey: string; readonly verificationToken: string; readonly appId?: never } |
  { readonly appId: string; readonly encryptKey?: never; readonly verificationToken?: never }
);

export interface FeishuActionResult {
  readonly status: 'answered' | 'paused';
  readonly messageId: string;
  readonly projectId: string;
  readonly decisionId: string;
  readonly action: FeishuActionKind;
}

const OPEN_ID = /^ou_[A-Za-z0-9_-]{1,64}$/;
const BUTTONS_BY_KIND: Readonly<Record<FeishuDecisionKind, readonly FeishuActionKind[]>> = Object.freeze({
  clarification: ['reply', 'pause'],
  proposal: ['approve', 'reject', 'pause'],
  acceptance: ['accept', 'reject', 'pause'],
});

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireText(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new DomainError(code);
  return value;
}

function safeEqualHex(left: string, right: string): boolean {
  const a = Buffer.from(left.toLowerCase(), 'utf8');
  const b = Buffer.from(right.toLowerCase(), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Feishu request signature: sha256(timestamp + nonce + encryptKey + body). */
export function computeFeishuSignature(
  timestamp: string, nonce: string, encryptKey: string, rawBody: string,
): string {
  return createHash('sha256')
    .update(timestamp + nonce + encryptKey + rawBody, 'utf8')
    .digest('hex');
}

function parseBody(rawBody: string): FeishuCallbackBody {
  let data: unknown;
  try {
    data = JSON.parse(rawBody);
  } catch {
    throw new DomainError('feishu_body_invalid');
  }
  if (!isObject(data) || data.schema !== '2.0' || !isObject(data.header) || !isObject(data.event) ||
      data.header.event_type !== 'card.action.trigger' ||
      typeof data.header.event_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.header.event_id) ||
      typeof data.header.token !== 'string' ||
      typeof data.header.create_time !== 'string' ||
      !isObject(data.event.operator) || typeof data.event.operator.open_id !== 'string' ||
      !isObject(data.event.action) || data.event.action.tag !== 'button' ||
      typeof data.event.action.value !== 'string') {
    throw new DomainError('feishu_callback_invalid');
  }
  return data as unknown as FeishuCallbackBody;
}

function parseActionValue(parsed: unknown, messageId: unknown) {
  if (!isObject(parsed) ||
      typeof messageId !== 'string' || !messageId.trim() || messageId.length > 200 ||
      typeof parsed.decisionId !== 'string' || !parsed.decisionId.trim() ||
      !['approve', 'reject', 'accept', 'reply', 'pause'].includes(parsed.action as string) ||
      (parsed.text !== undefined && (typeof parsed.text !== 'string' || parsed.text.length > 2000))) {
    throw new DomainError('feishu_action_value_invalid');
  }
  return {
    messageId, decisionId: parsed.decisionId,
    action: parsed.action as FeishuActionKind,
    ...(typeof parsed.text === 'string' ? { text: parsed.text } : {}),
  };
}

export class FeishuChannel {
  private readonly options: FeishuChannelOptions;
  private readonly seen = new Map<string, number>();
  private readonly pausing = new Set<string>();

  constructor(options: FeishuChannelOptions) {
    if (!options || typeof options.transport !== 'function' || !options.repository || !options.engine ||
        typeof options.now !== 'function') throw new DomainError('feishu_channel_config_invalid');
    if (options.appId !== undefined) {
      if (!/^cli_[a-zA-Z0-9]{1,64}$/.test(options.appId)) throw new DomainError('feishu_app_id_invalid');
    } else if (typeof options.encryptKey !== 'string' || options.encryptKey.length < 16) {
      throw new DomainError('feishu_encrypt_key_weak');
    } else if (typeof options.verificationToken !== 'string' || !options.verificationToken.trim()) {
      throw new DomainError('feishu_verification_token_missing');
    }
    if (options.maxSkewSeconds !== undefined &&
        (!Number.isSafeInteger(options.maxSkewSeconds) || options.maxSkewSeconds < 1 || options.maxSkewSeconds > 3600)) {
      throw new DomainError('feishu_channel_config_invalid');
    }
    this.options = options;
  }

  async publish(card: FeishuCard): Promise<FeishuCardRecord> {
    if (!isObject(card) || typeof card.projectId !== 'string' || !card.projectId.trim() ||
        typeof card.decisionId !== 'string' || !card.decisionId.trim() ||
        !Number.isSafeInteger(card.targetRevision) || card.targetRevision < 1 ||
        !(card.decisionKind in BUTTONS_BY_KIND) ||
        typeof card.ownerOpenId !== 'string' || !OPEN_ID.test(card.ownerOpenId) ||
        typeof card.title !== 'string' || !card.title.trim() || card.title.length > 200 ||
        typeof card.body !== 'string' || card.body.length > 2000 ||
        !Array.isArray(card.buttons) || card.buttons.length < 1 || card.buttons.length > 4 ||
        !Number.isSafeInteger(card.expiresAtMs) || card.expiresAtMs <= this.options.now()) {
      throw new DomainError('feishu_card_invalid');
    }
    const allowed = BUTTONS_BY_KIND[card.decisionKind];
    const seenActions = new Set<string>();
    for (const button of card.buttons as readonly unknown[]) {
      if (!isObject(button) || typeof button.action !== 'string' ||
          !allowed.includes(button.action as FeishuActionKind) ||
          typeof button.label !== 'string' || !button.label.trim() ||
          seenActions.has(button.action)) {
        throw new DomainError('feishu_card_button_invalid');
      }
      seenActions.add(button.action);
    }
    const actions = Object.freeze(card.buttons.map(button => button.action));
    const sent = await this.options.transport(card);
    if (!isObject(sent) || typeof sent.messageId !== 'string' || !sent.messageId.trim() || sent.messageId.length > 200) {
      throw new DomainError('feishu_transport_result_invalid');
    }
    const record: FeishuCardRecord = {
      messageId: sent.messageId, projectId: card.projectId, decisionId: card.decisionId,
      targetRevision: card.targetRevision, decisionKind: card.decisionKind,
      ownerOpenId: card.ownerOpenId, expiresAtMs: card.expiresAtMs, actions, status: 'pending',
    };
    this.options.repository.save(record);
    return record;
  }

  private rememberNonce(nonce: string, atMs: number): void {
    const limit = this.options.maxNonces ?? 4096;
    for (const [key, stamp] of this.seen) {
      if (atMs - stamp > (this.options.maxSkewSeconds ?? 300) * 1000) this.seen.delete(key);
    }
    if (this.seen.has(nonce)) throw new ConflictError('feishu_replay_detected');
    if (this.seen.size >= limit) throw new DomainError('feishu_nonce_store_full');
    this.seen.set(nonce, atMs);
  }

  async handleAction(envelope: FeishuEnvelope): Promise<FeishuActionResult> {
    if (this.options.appId !== undefined) throw new ConflictError('feishu_webhook_disabled');
    const nowMs = this.options.now();
    const skew = (this.options.maxSkewSeconds ?? 300) * 1000;
    if (!isObject(envelope) || typeof envelope.timestamp !== 'string' || typeof envelope.nonce !== 'string' ||
        typeof envelope.signature !== 'string' || typeof envelope.rawBody !== 'string' ||
        !/^\d{1,12}$/.test(envelope.timestamp) || !/^[A-Za-z0-9_-]{1,128}$/.test(envelope.nonce)) {
      throw new DomainError('feishu_envelope_invalid');
    }
    const stampMs = Number(envelope.timestamp) * 1000;
    if (!Number.isSafeInteger(stampMs) || Math.abs(nowMs - stampMs) > skew) {
      throw new ConflictError('feishu_timestamp_stale');
    }
    const expected = computeFeishuSignature(envelope.timestamp, envelope.nonce, this.options.encryptKey, envelope.rawBody);
    if (!safeEqualHex(expected, envelope.signature)) throw new ConflictError('feishu_signature_invalid');

    const body = parseBody(envelope.rawBody);
    if (body.header.token !== this.options.verificationToken) throw new ConflictError('feishu_token_mismatch');
    const eventMs = Date.parse(body.header.create_time);
    if (!Number.isFinite(eventMs) || Math.abs(nowMs - eventMs) > skew) throw new ConflictError('feishu_timestamp_stale');

    this.rememberNonce(envelope.nonce, nowMs);

    let payload: unknown;
    try {
      payload = JSON.parse(body.event.action.value);
    } catch {
      throw new DomainError('feishu_action_value_invalid');
    }
    const value = parseActionValue(payload, isObject(payload) ? payload.messageId : undefined);
    return this.applyAction(value, body.event.operator.open_id, body.header.event_id, nowMs);
  }

  /** Only the host-owned SDK dispatcher calls this after WebSocket authentication. */
  async handleLongConnectionAction(event: unknown): Promise<FeishuActionResult> {
    if (this.options.appId === undefined) throw new ConflictError('feishu_long_connection_disabled');
    if (!isObject(event) || event.app_id !== this.options.appId || event.event_type !== 'card.action.trigger' ||
        typeof event.event_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(event.event_id) ||
        typeof event.create_time !== 'string' || !/^\d{13}(?:\d{3})?$/.test(event.create_time) ||
        !isObject(event.operator) || typeof event.operator.open_id !== 'string' ||
        !isObject(event.context) || !isObject(event.action) || event.action.tag !== 'button') {
      throw new DomainError('feishu_callback_invalid');
    }
    const nowMs = this.options.now();
    // Feishu's card callbacks can carry epoch microseconds, while other events use milliseconds.
    const eventMs = Number(event.create_time.slice(0, 13));
    if (Math.abs(nowMs - eventMs) > (this.options.maxSkewSeconds ?? 300) * 1000) {
      throw new ConflictError('feishu_timestamp_stale');
    }
    this.rememberNonce(event.event_id, nowMs);
    const value = parseActionValue(event.action.value, event.context.open_message_id);
    return this.applyAction(value, event.operator.open_id, event.event_id, nowMs);
  }

  private async applyAction(value: ReturnType<typeof parseActionValue>, actorOpenId: string,
    eventId: string, nowMs: number): Promise<FeishuActionResult> {
    if (!OPEN_ID.test(actorOpenId)) throw new DomainError('feishu_actor_invalid');

    const record = this.options.repository.get(value.messageId);
    if (!record) throw new ConflictError('feishu_card_unknown');
    if (record.decisionId !== value.decisionId) throw new ConflictError('feishu_card_binding_mismatch');
    // 本人校验：唯一允许的施动者是发布时由 Host 绑定的 owner open_id。
    if (actorOpenId !== record.ownerOpenId) throw new ConflictError('feishu_actor_not_owner');
    if (record.status === 'answered') throw new ConflictError('feishu_card_already_answered');
    if (this.pausing.has(record.messageId)) throw new ConflictError('feishu_card_action_in_progress');
    if (record.status === 'expired' || nowMs >= record.expiresAtMs) {
      this.options.repository.save({ ...record, status: 'expired' });
      throw new ConflictError('feishu_card_expired');
    }

    if (!record.actions.includes(value.action)) throw new ConflictError('feishu_action_mismatch');
    const project = this.options.engine.getProject(record.projectId);
    if (!project) throw new ConflictError('feishu_project_missing');
    const decision = project.decisions.find((item) => item.decisionId === record.decisionId);
    if (!decision || decision.status !== 'pending' || decision.targetRevision !== record.targetRevision) {
      throw new ConflictError('feishu_decision_stale');
    }
    if (value.action === 'pause') {
      if (!this.options.pause) throw new ConflictError('feishu_pause_unsupported');
      this.pausing.add(record.messageId);
      try {
        await this.options.pause(record.projectId);
        this.options.repository.save({
          ...record, status: 'answered', chosenAction: 'pause',
          answeredByOpenId: actorOpenId, answeredAt: new Date(nowMs).toISOString(),
        });
      } finally {
        this.pausing.delete(record.messageId);
      }
      return { status: 'paused', messageId: record.messageId, projectId: record.projectId,
        decisionId: record.decisionId, action: 'pause' };
    }

    const response = this.toResponse(record.decisionKind, value.action, value.text);
    const artifactRevision = decision.kind === 'acceptance' ? decision.evidence.artifactRevision : undefined;
    const result = this.options.engine.executeProject({
      type: 'answer_decision',
      projectId: record.projectId,
      eventId: 'feishu:' + eventId,
      at: new Date(nowMs).toISOString(),
      expectedRevision: project.revision,
      decisionId: record.decisionId,
      targetRevision: record.targetRevision,
      actorId: project.ownerId,
      ...(artifactRevision ? { artifactRevision } : {}),
      response,
    });
    if (result.duplicate) throw new ConflictError('feishu_card_already_answered');

    this.options.repository.save({
      ...record, status: 'answered', chosenAction: value.action,
      answeredByOpenId: actorOpenId, answeredAt: new Date(nowMs).toISOString(),
    });
    return { status: 'answered', messageId: record.messageId, projectId: record.projectId,
      decisionId: record.decisionId, action: value.action };
  }

  private toResponse(kind: FeishuDecisionKind, action: FeishuActionKind, text?: string) {
    // A button may carry no free text; fall back to a bounded, explicit note so
    // the Engine's non-empty response invariant always holds.
    const note = typeof text === 'string' && text.trim() ? text.trim() : 'Feishu action: ' + action;
    if (note.length > 2000) throw new DomainError('feishu_action_text_invalid');
    switch (kind) {
      case 'proposal':
        if (action !== 'approve' && action !== 'reject') throw new ConflictError('feishu_action_mismatch');
        return { action, text: note } as const;
      case 'acceptance':
        if (action !== 'accept' && action !== 'reject') throw new ConflictError('feishu_action_mismatch');
        return { action, text: note } as const;
      case 'clarification':
        if (action !== 'reply') throw new ConflictError('feishu_action_mismatch');
        return { action: 'reply', text: note } as const;
    }
  }
}
