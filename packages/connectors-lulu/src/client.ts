import {
  authorizeLuluSubmit, luluSubmitBody
} from './policy.ts';
import type { LuluApproval, LuluSubmitInput } from './policy.ts';
import { MemoryLuluRunStore } from './run-store.ts';
import type { LuluRunStore } from './run-store.ts';

export interface LuluConnectorOptions {
  readonly baseUrl: string;
  readonly sessionCookie?: string;
  readonly timeoutMs?: number;
  readonly approvalSecret?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly runStore?: LuluRunStore;
}

export interface LuluHealth {
  readonly status: 'online' | 'unavailable';
  readonly checkedAt: string;
  readonly reason?: string;
}

export interface LuluCapabilities {
  readonly status: 'available' | 'unauthorized' | 'unavailable';
  readonly checkedAt: string;
  readonly databaseHealthy?: boolean;
  readonly deepSeekAvailable?: boolean;
  readonly coachPrimary?: string;
  readonly agentPrimary?: string;
  readonly fastModel?: string;
  readonly memoryModel?: string;
  readonly pgvectorEnabled?: boolean;
  readonly bailianRagEnabled?: boolean;
  readonly baiduSearchEnabled?: boolean;
  readonly qqBotEnabled?: boolean;
  readonly qqBotReady?: boolean;
  readonly reason?: string;
}

export interface LuluSubmission {
  readonly status: 'completed' | 'unauthorized' | 'rejected' | 'unavailable' | 'duplicate';
  readonly runId?: string;
  readonly evidence?: unknown;
  readonly reason?: string;
}

function normalizeBaseUrl(value: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Lulu base URL is required');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid Lulu base URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Lulu base URL must use http or https');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Lulu base URL must be loopback');
  if (url.username || url.password || url.search || url.hash) throw new Error('Lulu base URL must not contain credentials, query or fragment');
  const pathname = url.pathname.replace(/\/+$/, '');
  if (pathname !== '/api') throw new Error('Lulu base URL must include the /api context path');
  return url.toString().replace(/\/+$/, '');
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export class LuluConnector {
  readonly baseUrl: string;
  private readonly sessionCookie: string;
  private readonly timeoutMs: number;
  private readonly approvalSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly runStore: LuluRunStore;

  constructor(options: LuluConnectorOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    const cookieValue = typeof options.sessionCookie === 'string' ? options.sessionCookie.trim() : '';
    this.sessionCookie = cookieValue.startsWith('LULU_SESSION=') ? cookieValue.slice('LULU_SESSION='.length) : cookieValue;
    this.timeoutMs = options.timeoutMs ?? 1500;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60000) throw new Error('Invalid Lulu timeout');
    this.approvalSecret = options.approvalSecret ?? '';
    if (this.approvalSecret && this.approvalSecret.length < 16) throw new Error('Lulu approval secret must be at least 16 characters');
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.runStore = options.runStore ?? new MemoryLuluRunStore();
  }

  private endpoint(path: string): string {
    return `${this.baseUrl}/${path.replace(/^\/+/, '')}`;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(this.endpoint(path), { ...init, signal: controller.signal, redirect: 'error' });
    } finally {
      clearTimeout(timer);
    }
  }

  private async readText(response: Response): Promise<string | null> {
    const text = await response.text();
    return text.length > 65536 ? null : text;
  }

  private async readObject(response: Response): Promise<Record<string, unknown> | null> {
    const text = await this.readText(response);
    if (text === null) return null;
    try {
      const value = JSON.parse(text) as unknown;
      return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }

  async health(): Promise<LuluHealth> {
    const checkedAt = new Date(this.now()).toISOString();
    try {
      const response = await this.request('health', { method: 'GET', headers: { Accept: 'text/plain, application/json' } });
      if (!response.ok) return { status: 'unavailable', checkedAt, reason: `http_${response.status}` };
      const body = await this.readText(response);
      if (body === null) return { status: 'unavailable', checkedAt, reason: 'response_too_large' };
      let online = body.trim() === 'ok';
      if (!online) {
        try {
          const parsed = JSON.parse(body) as unknown;
          online = !!parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>).status === 'ok';
        } catch {
          online = false;
        }
      }
      return online ? { status: 'online', checkedAt } : { status: 'unavailable', checkedAt, reason: 'unexpected_health_body' };
    } catch (error) {
      return { status: 'unavailable', checkedAt, reason: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'unreachable' };
    }
  }

  async capabilities(): Promise<LuluCapabilities> {
    const checkedAt = new Date(this.now()).toISOString();
    if (!this.sessionCookie) return { status: 'unauthorized', checkedAt, reason: 'session_cookie_missing' };
    try {
      const response = await this.request('ai/system/status', {
        method: 'GET',
        headers: { Accept: 'application/json', Cookie: `LULU_SESSION=${this.sessionCookie}` }
      });
      if (response.status === 401 || response.status === 403) return { status: 'unauthorized', checkedAt, reason: 'lulu_auth_rejected' };
      if (!response.ok) return { status: 'unavailable', checkedAt, reason: `http_${response.status}` };
      const data = await this.readObject(response);
      if (!data) return { status: 'unavailable', checkedAt, reason: 'invalid_response' };
      return {
        status: 'available', checkedAt,
        databaseHealthy: asBoolean(data.databaseHealthy),
        deepSeekAvailable: asBoolean(data.deepSeekAvailable),
        coachPrimary: asString(data.coachPrimary),
        agentPrimary: asString(data.agentPrimary),
        fastModel: asString(data.fastModel),
        memoryModel: asString(data.memoryModel),
        pgvectorEnabled: asBoolean(data.pgvectorEnabled),
        bailianRagEnabled: asBoolean(data.bailianRagEnabled),
        baiduSearchEnabled: asBoolean(data.baiduSearchEnabled),
        qqBotEnabled: asBoolean(data.qqBotEnabled),
        qqBotReady: asBoolean(data.qqBotReady)
      };
    } catch (error) {
      return { status: 'unavailable', checkedAt, reason: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'unreachable' };
    }
  }

  async submit(input: LuluSubmitInput, approval: LuluApproval | undefined): Promise<LuluSubmission> {
    if (!this.approvalSecret) return { status: 'rejected', reason: 'approval_not_configured' };
    const decision = authorizeLuluSubmit(input, approval, { target: this.baseUrl, secret: this.approvalSecret, now: this.now() });
    if (!decision.allowed) return { status: 'rejected', reason: decision.reason };
    if (this.runStore.get(approval!.nonce)) return { status: 'duplicate', reason: 'nonce_reused' };
    if (!this.sessionCookie) return { status: 'unauthorized', reason: 'session_cookie_missing' };
    const body = luluSubmitBody(input);
    try {
      const response = await this.request('ai/coach/suggest/quick', {
        method: 'POST',
        headers: {
          Accept: 'application/json', 'Content-Type': 'application/json',
          Cookie: `LULU_SESSION=${this.sessionCookie}`,
          'X-Lulu-Request-Id': approval!.nonce
        },
        body: JSON.stringify(body)
      });
      if (response.status === 401 || response.status === 403) return { status: 'unauthorized', reason: 'lulu_auth_rejected' };
      if (response.status === 409) return { status: 'duplicate', reason: 'lulu_duplicate' };
      if (!response.ok) return { status: 'unavailable', reason: `http_${response.status}` };
      const evidence = await this.readObject(response);
      if (!evidence) return { status: 'unavailable', reason: 'invalid_response' };
      const runId = approval!.nonce;
      this.runStore.save({ runId, status: 'completed', evidence, completedAt: new Date(this.now()).toISOString() });
      return { status: 'completed', runId, evidence };
    } catch (error) {
      return { status: 'unavailable', reason: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'unreachable' };
    }
  }

  status(runId: string): { readonly status: 'completed' | 'unknown'; readonly evidence?: unknown } {
    const record = this.runStore.get(runId);
    return record ? { status: record.status, evidence: record.evidence } : { status: 'unknown' };
  }

  evidence(runId: string): unknown | undefined {
    return this.runStore.get(runId)?.evidence;
  }
}
