import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IdentityPrincipal } from './identity-registry.ts';

export type SessionRole = 'readwrite' | 'readonly';

export interface Session {
  readonly id: string;
  readonly csrfToken: string;
  readonly role: SessionRole;
  readonly expiresAt: number;
  /** Present only after persistent user authentication, never a bootstrap token. */
  readonly identity?: IdentityPrincipal;
}

export interface BootstrapToken {
  readonly value: string;
  readonly role: SessionRole;
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const value = part.slice(index + 1).trim();
    return value || undefined;
  }
  return undefined;
}

export function sessionCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly tokens: readonly BootstrapToken[];
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(options: { tokens: readonly BootstrapToken[]; now?: () => number; ttlMs?: number }) {
    const now = options.now ?? Date.now;
    const ttlMs = options.ttlMs ?? 12 * 60 * 60 * 1000;
    if (!Array.isArray(options.tokens) || !options.tokens.length) throw new Error('At least one bootstrap token is required');
    for (const token of options.tokens) {
      if (typeof token.value !== 'string' || token.value.length < 16 || token.value.length > 256) throw new Error('Bootstrap token length invalid');
      if (token.role !== 'readwrite' && token.role !== 'readonly') throw new Error('Bootstrap token role invalid');
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error('Session TTL invalid');
    this.tokens = options.tokens.map((token) => ({ ...token }));
    this.now = now;
    this.ttlMs = ttlMs;
  }

  open(token: string): Session | undefined {
    const match = this.tokens.find((candidate) => secureEqual(candidate.value, token));
    if (!match) return undefined;
    const session: Session = Object.freeze({
      id: randomBytes(32).toString('hex'),
      csrfToken: randomBytes(32).toString('hex'),
      role: match.role,
      expiresAt: this.now() + this.ttlMs
    });
    this.sessions.set(session.id, session);
    return session;
  }

  get(cookieHeader: string | undefined, name = 'daming_session'): Session | undefined {
    const id = parseCookie(cookieHeader, name);
    if (!id) return undefined;
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(id);
      return undefined;
    }
    return session;
  }

  revokeByCookie(cookieHeader: string | undefined, name = 'daming_session'): void {
    const id = parseCookie(cookieHeader, name);
    if (id) this.sessions.delete(id);
  }
}
