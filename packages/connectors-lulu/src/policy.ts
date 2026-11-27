import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface LuluSubmitMessage {
  readonly sender: string;
  readonly text: string;
  readonly time?: string;
}

export interface LuluSubmitInput {
  readonly platform: string;
  readonly conversationId: string;
  readonly personId?: string;
  readonly accountId?: string;
  readonly userAlias?: string;
  readonly otherAlias?: string;
  readonly relationshipStage?: string;
  readonly goal?: string;
  readonly userStyle?: string;
  readonly messages: readonly LuluSubmitMessage[];
}

export interface LuluSubmitBody {
  readonly platform: string;
  readonly conversationId: string;
  readonly personId: string;
  readonly accountId: string;
  readonly userAlias: string;
  readonly otherAlias: string;
  readonly relationshipStage: string;
  readonly goal: string;
  readonly userStyle: string;
  readonly messages: readonly LuluSubmitMessage[];
}

export interface LuluApproval {
  readonly operation: 'lulu.chat.submit';
  readonly taskId: string;
  readonly target: string;
  readonly requestHash: string;
  readonly expiresAtMs: number;
  readonly nonce: string;
  readonly signature: string;
}

export interface LuluApprovalDecision {
  readonly allowed: boolean;
  readonly reason?: string;
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be nonempty text`);
  return value;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`;
}

function secretOf(value: string): string {
  if (typeof value !== 'string' || value.length < 16) throw new Error('Approval secret must be at least 16 characters');
  return value;
}

function targetOf(value: string): string {
  return text(value, 'target').replace(/\/+$/, '');
}

function signatureFor(unsigned: Omit<LuluApproval, 'signature'>, secret: string): string {
  return createHmac('sha256', secretOf(secret)).update(canonical(unsigned)).digest('hex');
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function luluSubmitBody(input: LuluSubmitInput): LuluSubmitBody {
  if (!input || typeof input !== 'object') throw new Error('Lulu submit input must be an object');
  if (!Array.isArray(input.messages) || !input.messages.length || input.messages.length > 100) throw new Error('Lulu messages must contain 1-100 items');
  const messages = input.messages.map((message) => ({
    sender: text(message.sender, 'message.sender'),
    text: text(message.text, 'message.text'),
    ...(message.time === undefined ? {} : { time: text(message.time, 'message.time') })
  }));
  return {
    platform: text(input.platform, 'platform'),
    conversationId: text(input.conversationId, 'conversationId'),
    personId: input.personId ?? input.conversationId,
    accountId: input.accountId ?? input.conversationId,
    userAlias: input.userAlias ?? '',
    otherAlias: input.otherAlias ?? '',
    relationshipStage: input.relationshipStage ?? '',
    goal: input.goal ?? '',
    userStyle: input.userStyle ?? '',
    messages
  };
}

export function luluRequestHash(input: LuluSubmitInput): string {
  return createHash('sha256').update(canonical(luluSubmitBody(input))).digest('hex');
}

export function createLuluApproval(
  input: LuluSubmitInput,
  options: { readonly taskId: string; readonly target: string; readonly expiresAtMs: number; readonly nonce: string; readonly secret: string }
): LuluApproval {
  if (!Number.isSafeInteger(options.expiresAtMs) || options.expiresAtMs <= 0) throw new Error('Invalid approval expiry');
  const unsigned: Omit<LuluApproval, 'signature'> = {
    operation: 'lulu.chat.submit',
    taskId: text(options.taskId, 'taskId'),
    target: targetOf(options.target),
    requestHash: luluRequestHash(input),
    expiresAtMs: options.expiresAtMs,
    nonce: text(options.nonce, 'nonce')
  };
  return { ...unsigned, signature: signatureFor(unsigned, options.secret) };
}

export function authorizeLuluSubmit(
  input: LuluSubmitInput,
  approval: LuluApproval | undefined,
  options: { readonly target: string; readonly secret: string; readonly now?: number }
): LuluApprovalDecision {
  if (!approval || approval.operation !== 'lulu.chat.submit') return { allowed: false, reason: 'approval_required' };
  const now = options.now ?? Date.now();
  if (approval.target !== targetOf(options.target)) return { allowed: false, reason: 'target_mismatch' };
  if (!Number.isSafeInteger(approval.expiresAtMs) || approval.expiresAtMs <= now) return { allowed: false, reason: 'approval_expired' };
  let requestHash: string;
  try { requestHash = luluRequestHash(input); } catch { return { allowed: false, reason: 'invalid_request' }; }
  if (approval.requestHash !== requestHash) return { allowed: false, reason: 'request_changed' };
  const unsigned: Omit<LuluApproval, 'signature'> = {
    operation: approval.operation, taskId: approval.taskId, target: approval.target,
    requestHash: approval.requestHash, expiresAtMs: approval.expiresAtMs, nonce: approval.nonce
  };
  if (!safeEqual(approval.signature, signatureFor(unsigned, options.secret))) return { allowed: false, reason: 'signature_invalid' };
  return { allowed: true };
}
