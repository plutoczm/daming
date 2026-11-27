import { createHash } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import type { ProjectSendIntent, ProjectSendPermit, ProjectSpendLedger } from '@daming/governance';
import type { ProjectControl } from './project-control.ts';
import type { IdentityPrincipal, IdentityRegistry, ProviderKind } from './identity-registry.ts';
import type { BudgetCurrency, TrustedPaidAttemptView, TrustedPaidIntent } from './tenant-budget.ts';
import { TenantBudgetLedger } from './tenant-budget.ts';
import { runTrustedBrokerAgent } from './tenant-paid-agent-runner.ts';
import { GOVERNED_MODEL_TOOLS, parseGovernedChatTurn, runGovernedMemoryTool } from './governed-tool-turns.ts';
import type { SafeToolCall, SafeToolResult } from './governed-tool-turns.ts';

type SendReceipt<T> = { value: T; reference: string; estimatedCashMinor?: number };
type SendCompletion<T> = { ok: true; receipt: SendReceipt<T> } | { ok: false; error: unknown };

/** Host-only entry for a single actual upstream launch. Route adapters supply a single-shot transport. */
export class ProjectPaidEgress {
  private readonly control: ProjectControl;
  private readonly ledger: ProjectSpendLedger;

  constructor(control: ProjectControl, ledger: ProjectSpendLedger) {
    this.control = control;
    this.ledger = ledger;
  }

  async send<T>(intent: ProjectSendIntent, launch: () => Promise<SendReceipt<T>>): Promise<T> {
    const { projectId, attemptId, taskId, epoch, sendId } = intent;
    const lease = { projectId, attemptId, taskId, epoch, startId: sendId };
    const { completion } = await this.control.withProjectStart(lease, async () => {
      let completion: Promise<SendCompletion<T>>;
      try {
        completion = launch().then<SendCompletion<T>, SendCompletion<T>>(
          receipt => ({ ok: true, receipt }), error => ({ ok: false, error }),
        );
      } catch (error) {
        completion = Promise.resolve({ ok: false, error });
      }
      return { completion };
    }, { authorize: () => { this.ledger.beginProjectSend(intent); } });

    const result = await completion;
    if (!result.ok) {
      this.ledger.recordProjectSendOutcome(projectId, sendId, { kind: 'unknown', reference: 'upstream terminal receipt unavailable' });
      await this.control.closeProjectStarts(projectId, { kind: 'reconciliation', id: sendId });
      throw result.error;
    }
    const { value, reference, estimatedCashMinor } = result.receipt;
    let permit: ProjectSendPermit;
    try {
      permit = this.ledger.recordProjectSendOutcome(projectId, sendId, {
        kind: 'completed', reference, ...(estimatedCashMinor === undefined ? {} : { estimatedCashMinor }),
      });
    } catch (error) {
      await this.control.closeProjectStarts(projectId, { kind: 'reconciliation', id: sendId });
      throw error;
    }
    await this.control.settleStart(lease, permit.suspectUpperBound ? { kind: 'budget', id: sendId } : undefined);
    return value;
  }
}

export class TrustedEgressError extends Error {
  readonly status: number;
  constructor(status: number, reason: string) { super(reason); this.status = status; }
}
export type PaidModelRequest = {
  provider: ProviderKind; modelId: string; apiKey: string;
  prompt: string; maxOutputTokens: number; safeMemoryTools?: boolean;
};
export type PaidModelResult = {
  text: string; inputTokens: number | null; outputTokens: number | null;
  toolCalls?: readonly SafeToolCall[];
  toolResults?: readonly SafeToolResult[];
  awaitingPaidContinuation?: boolean;
};
export type PaidModelTransport = (request: PaidModelRequest) => Promise<PaidModelResult>;
export type TrustedAgentRunner = (intent: { requestId: string; prompt: string },
  invokeBroker: () => Promise<PaidModelResult>) => Promise<string>;
export type PaidAgentInput = {
  requestId: string; credentialId: string; currency: BudgetCurrency;
  reservedMinor: number; prompt: string; maxOutputTokens: number;
  safeMemoryTools?: boolean;
};
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const HOSTS = {
  deepseek: { hostname: 'api.deepseek.com', path: '/chat/completions' },
  openai: { hostname: 'api.openai.com', path: '/v1/chat/completions' }
} as const;
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function positiveTokens(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1000000
    ? Number(value) : null;
}
function validate(input: PaidAgentInput): void {
  if (!input || !UUID.test(input.requestId) || !UUID.test(input.credentialId) ||
      (input.currency !== 'CNY' && input.currency !== 'USD') ||
      !Number.isSafeInteger(input.reservedMinor) || input.reservedMinor < 1 ||
      input.reservedMinor > 100_000_000 ||
      !Number.isSafeInteger(input.maxOutputTokens) ||
      input.maxOutputTokens < 1 || input.maxOutputTokens > 128 ||
      (input.safeMemoryTools !== undefined && typeof input.safeMemoryTools !== 'boolean') ||
      typeof input.prompt !== 'string' || !input.prompt.trim() ||
      input.prompt.length > 2048 || Buffer.byteLength(input.prompt, 'utf8') > 8192) {
    throw new TrustedEgressError(400, 'trusted_egress_input_invalid');
  }
}
function intentFor(input: PaidAgentInput, account: { provider: ProviderKind; modelId: string }): TrustedPaidIntent {
  return {
    requestId: input.requestId, credentialId: input.credentialId,
    provider: account.provider, modelId: account.modelId,
    currency: input.currency, reservedMinor: input.reservedMinor,
    payloadDigest: createHash('sha512').update(JSON.stringify([
      input.requestId, input.credentialId, account.provider, account.modelId,
      input.currency, input.reservedMinor, input.maxOutputTokens, input.prompt,
      input.safeMemoryTools === true
    ]), 'utf8').digest('hex')
  };
}
/**
 * This is NOT a general CONNECT/HTTP proxy. Both vendor destinations and
 * paths are compiled into this Host-only adapter. The upstream key is never
 * supplied to a container, browser, client-specified URL, or log.
 *
 * One JSON Chat Completion, no tools, no stream, no redirects, no retry,
 * finite output and time. The response is untrusted until schema checked.
 */
export const officialPaidModelTransport: PaidModelTransport = async (input) => {
  const endpoint = HOSTS[input.provider];
  if (!endpoint || typeof input.apiKey !== 'string' ||
      input.apiKey.length < 12 || input.apiKey.length > 4096 ||
      /[\r\n\0]/.test(input.apiKey) ||
      typeof input.modelId !== 'string' ||
      !/^[a-z0-9][a-z0-9._:/-]{1,99}$/i.test(input.modelId) ||
      input.modelId.includes('://') || input.modelId.includes('..') ||
      typeof input.prompt !== 'string' || input.prompt.length > 2048 ||
      Buffer.byteLength(input.prompt, 'utf8') > 8192 ||
      !Number.isSafeInteger(input.maxOutputTokens) ||
      input.maxOutputTokens < 1 || input.maxOutputTokens > 128 ||
      (input.safeMemoryTools !== undefined && typeof input.safeMemoryTools !== 'boolean')) {
    throw new TrustedEgressError(400, 'trusted_vendor_input_invalid');
  }
  const body = JSON.stringify({
    model: input.modelId,
    messages: [{ role: 'user', content: input.prompt }],
    stream: false, n: 1,
    ...(input.safeMemoryTools === true
      ? { tools: GOVERNED_MODEL_TOOLS, tool_choice: 'auto', parallel_tool_calls: false }
      : { tool_choice: 'none' }),
    ...(input.provider === 'openai'
      ? { max_completion_tokens: input.maxOutputTokens }
      : { max_tokens: input.maxOutputTokens, thinking: { type: 'disabled' } })
  });
  if (Buffer.byteLength(body, 'utf8') > 10000) {
    throw new TrustedEgressError(400, 'trusted_vendor_request_too_large');
  }
  return await new Promise<PaidModelResult>((resolve, reject) => {
    let finished = false;
    let totalTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error, result?: PaidModelResult) => {
      if (finished) return;
      finished = true;
      if (totalTimer) clearTimeout(totalTimer);
      if (error) reject(error);
      else resolve(result!);
    };
    const req = httpsRequest({
      protocol: 'https:', hostname: endpoint.hostname, port: 443,
      servername: endpoint.hostname, path: endpoint.path, method: 'POST',
      agent: false, rejectUnauthorized: true, timeout: 25000,
      headers: {
        Authorization: 'Bearer ' + input.apiKey,
        'Content-Type': 'application/json', Accept: 'application/json',
        'Accept-Encoding': 'identity', 'Content-Length': Buffer.byteLength(body, 'utf8'),
        'User-Agent': 'Daming-Trusted-Paid-Egress/1'
      }
    }, (response) => {
      // Any non-200 (including redirect) is a potentially billed UNKNOWN,
      // not a reason to transparently replay.
      if (response.statusCode !== 200 ||
          !/^application\/json(?:\s*;|$)/i.test(String(response.headers['content-type'] ?? ''))) {
        response.resume();
        finish(new TrustedEgressError(502, 'trusted_vendor_response_unusable'));
        return;
      }
      let bytes = 0;
      const chunks: Buffer[] = [];
      response.on('data', (data: Buffer) => {
        bytes += data.length;
        if (bytes > 128 * 1024) {
          req.destroy();
          finish(new TrustedEgressError(502, 'trusted_vendor_response_oversized'));
        } else chunks.push(data);
      });
      response.on('end', () => {
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (input.safeMemoryTools === true) {
            const turn = parseGovernedChatTurn(parsed);
            const toolCalls = turn.toolCalls;
            finish(undefined, {
              text: turn.content,
              inputTokens: turn.usage.inputTokens,
              outputTokens: turn.usage.outputTokens,
              toolCalls, toolResults: toolCalls.map(runGovernedMemoryTool),
              awaitingPaidContinuation: turn.finishReason === 'tool_calls'
            });
          } else {
            if (!isObject(parsed) || parsed.object !== 'chat.completion' ||
                !Array.isArray(parsed.choices) || parsed.choices.length !== 1 ||
                !isObject(parsed.choices[0]) ||
                !['stop','length'].includes(String(parsed.choices[0].finish_reason)) ||
                !isObject(parsed.choices[0].message) ||
                parsed.choices[0].message.role !== 'assistant' ||
                typeof parsed.choices[0].message.content !== 'string' ||
                parsed.choices[0].message.content.length > 16000 ||
                parsed.choices[0].message.tool_calls !== undefined ||
                parsed.choices[0].message.function_call !== undefined) {
              throw new Error('schema');
            }
            const usage = isObject(parsed.usage) ? parsed.usage : {};
            const promptTokens = positiveTokens(usage.prompt_tokens);
            const completionTokens = positiveTokens(usage.completion_tokens);
            finish(undefined, {
              text: parsed.choices[0].message.content,
              inputTokens: promptTokens, outputTokens: completionTokens
            });
          }
        } catch { finish(new TrustedEgressError(502, 'trusted_vendor_response_invalid')); }
      });
      response.on('error', () => finish(new TrustedEgressError(502, 'trusted_vendor_stream_failed')));
    });
    req.on('timeout', () => {
      req.destroy();
      finish(new TrustedEgressError(504, 'trusted_vendor_timeout_cash_unknown'));
    });
    req.on('error', () => finish(new TrustedEgressError(502, 'trusted_vendor_transport_failed')));
    totalTimer = setTimeout(() => {
      req.destroy();
      finish(new TrustedEgressError(504, 'trusted_vendor_total_deadline_cash_unknown'));
    }, 30000);
    req.end(body);
  });
};

export type TrustedEgressResult = {
  requestId: string; provider: ProviderKind; modelId: string;
  text: string; inputTokens: number | null; outputTokens: number | null;
  attempt: TrustedPaidAttemptView;
  chargedMinor: null; vendorInvoiceVerified: false;
  vendorHardCapGuaranteed: false; autoRetryPermitted: false;
  actualAgentHadNetworkAccess: false; agentReceivedApiKey: false;
  toolCalls?: readonly SafeToolCall[]; toolResults?: readonly SafeToolResult[];
  awaitingPaidContinuation?: boolean;
};
export class TrustedPaidEgress {
  private readonly accounts: IdentityRegistry;
  private readonly ledger: TenantBudgetLedger;
  private readonly enabled: boolean;
  private readonly transport: PaidModelTransport;
  private readonly runAgent: TrustedAgentRunner;
  constructor(accounts: IdentityRegistry, ledger: TenantBudgetLedger,
    enabled: boolean, transport: PaidModelTransport = officialPaidModelTransport,
    runAgent: TrustedAgentRunner = runTrustedBrokerAgent) {
    this.accounts = accounts;
    this.ledger = ledger;
    this.enabled = enabled;
    this.transport = transport;
    this.runAgent = runAgent;
  }

  private owner(p: IdentityPrincipal): void {
    if (p.memberRole !== 'owner') throw new TrustedEgressError(403, 'tenant_owner_required');
  }
  private account(p: IdentityPrincipal, id: string) {
    return this.accounts.trustedEgressAccount(p, id);
  }
  private currencyBound(input: PaidAgentInput, provider: ProviderKind): void {
    if ((provider === 'openai' && input.currency !== 'USD') ||
        (provider === 'deepseek' && input.currency !== 'CNY')) {
      throw new TrustedEgressError(400, 'trusted_egress_provider_currency_mismatch');
    }
  }
  prepare(p: IdentityPrincipal, input: PaidAgentInput): TrustedPaidAttemptView {
    this.owner(p);
    validate(input);
    const account = this.account(p, input.credentialId);
    this.currencyBound(input, account.provider);
    return this.ledger.preparePaid(p, intentFor(input, account));
  }
  list(p: IdentityPrincipal): TrustedPaidAttemptView[] {
    this.owner(p);
    return this.ledger.listPaid(p);
  }
  cancel(p: IdentityPrincipal, requestId: string): TrustedPaidAttemptView {
    this.owner(p);
    return this.ledger.cancelPaidBeforeSend(p, requestId);
  }
  get availableForManualOneShot(): boolean { return this.enabled; }
  async execute(p: IdentityPrincipal, input: PaidAgentInput,
    confirmStillAuthorized?: () => void): Promise<TrustedEgressResult> {
    this.owner(p);
    validate(input);
    if (!this.enabled) throw new TrustedEgressError(503, 'trusted_paid_egress_disabled');
    // This is a Host-only account lookup, NOT a client-supplied key or URL.
    const account = this.account(p, input.credentialId);
    this.currencyBound(input, account.provider);
    const intent = intentFor(input, account);
    let invoked = false;
    let vendor: PaidModelResult | undefined;
    const finalText = await this.runAgent(
      { requestId: input.requestId, prompt: input.prompt },
      async () => {
        if (invoked) throw new TrustedEgressError(409, 'trusted_egress_second_intent_denied');
        invoked = true;
        confirmStillAuthorized?.();
        // A synchronous recheck closes the most important credential change
        // window; the DB claim is durable before even attempting HTTPS.
        const current = this.account(p, input.credentialId);
        if (current.provider !== account.provider || current.modelId !== account.modelId ||
            current.apiKey !== account.apiKey) {
          throw new TrustedEgressError(409, 'trusted_egress_account_changed');
        }
        this.ledger.beginPaidSend(p, intent);
        try {
          vendor = await this.transport({
            provider: current.provider, modelId: current.modelId,
            apiKey: current.apiKey, prompt: input.prompt,
            maxOutputTokens: input.maxOutputTokens,
            safeMemoryTools: input.safeMemoryTools === true
          });
          return vendor;
        } finally {
          // Even a successful model response does NOT prove the cash invoice.
          this.ledger.finishPaidUnknown(p, input.requestId);
        }
      }
    );
    if (!vendor || vendor.text !== finalText) {
      throw new TrustedEgressError(502, 'trusted_egress_agent_receipt_mismatch');
    }
    return {
      requestId: input.requestId, provider: account.provider, modelId: account.modelId,
      text: vendor.text, inputTokens: vendor.inputTokens, outputTokens: vendor.outputTokens,
      attempt: this.ledger.listPaid(p).find(row => row.requestId === input.requestId)!,
      chargedMinor: null, vendorInvoiceVerified: false,
      vendorHardCapGuaranteed: false, autoRetryPermitted: false,
      actualAgentHadNetworkAccess: false, agentReceivedApiKey: false,
      ...(vendor.toolCalls ? { toolCalls: vendor.toolCalls } : {}),
      ...(vendor.toolResults ? { toolResults: vendor.toolResults } : {}),
      ...(vendor.awaitingPaidContinuation !== undefined
        ? { awaitingPaidContinuation: vendor.awaitingPaidContinuation } : {})
    };
  }
}
