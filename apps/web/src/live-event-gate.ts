/**
 * SSE invalidation gate (UI v4).
 *
 * One Host process numbers every invalidation frame (`seq`, monotonic) and each
 * business scope additionally carries a `revision`. The gate drops duplicates and
 * out-of-order frames (e.g. a replayed EventSource buffer), and re-anchors itself on
 * `ready` so a reconnecting tab does not re-apply history — it revalidates instead.
 *
 * Pure and React-free so the dedupe rules can be unit-tested.
 */
export interface InvalidationPayload {
  readonly scope: string;
  readonly seq: number;
  readonly revision?: number;
  readonly resource?: string;
  readonly at?: string;
}

export interface InvalidationGate {
  /** Anchor the cursor at a stream's current sequence (called on every `ready`). */
  reset(seq: number): void;
  /** True when this frame is newer than anything already applied. */
  accept(frame: InvalidationPayload): boolean;
  readonly cursor: number;
}

export function createInvalidationGate(): InvalidationGate {
  let cursor = 0;
  return {
    reset(seq: number) {
      // Never move the cursor backwards: a Host restart may reuse low numbers.
      if (!Number.isFinite(seq) || seq < 0) return;
      cursor = Math.max(cursor, Math.trunc(seq));
    },
    accept(frame: InvalidationPayload) {
      if (!Number.isFinite(frame.seq) || frame.seq <= 0) return false;
      if (frame.seq <= cursor) return false;
      cursor = Math.trunc(frame.seq);
      return true;
    },
    get cursor() { return cursor; }
  };
}

/** Parse a raw SSE `data:` payload without trusting any of its content. */
export function parseInvalidation(raw: string): InvalidationPayload | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    if (typeof record.scope !== 'string') return null;
    if (typeof record.seq !== 'number') return null;
    return {
      scope: record.scope,
      seq: record.seq,
      ...(typeof record.revision === 'number' ? { revision: record.revision } : {}),
      ...(typeof record.resource === 'string' ? { resource: record.resource } : {}),
      ...(typeof record.at === 'string' ? { at: record.at } : {})
    };
  } catch {
    return null;
  }
}