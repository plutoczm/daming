import type { ServerResponse } from 'node:http';

/**
 * Only emits invalidation hints; never task details, account data or tokens.
 * Each subscription is bound to the authenticated session and periodically rechecked.
 *
 * Publishers MUST call `publish(scope)` only after the related state was committed to
 * its store: a hint that arrives before the write is committed makes the browser refetch
 * older data and then stay stale until the fallback interval.
 */
export const BOARD_INVALIDATION_SCOPES = [
  'tasks',
  'autoloop',
  'magpie',
  'lulu',
  'codex',
  'missions',
  'crew',
  'providers',
  'agents',
  'routing',
  'gateway',
  'platform',
  'notifications',
  'portfolio'
] as const;

export type BoardInvalidation = (typeof BOARD_INVALIDATION_SCOPES)[number];

/** Wire payload. `seq` is monotonic per Host process, `revision` per scope. */
export interface InvalidationFrame {
  readonly scope: BoardInvalidation;
  readonly seq: number;
  readonly revision: number;
  readonly at: string;
  readonly resource?: string;
}

interface Subscriber {
  readonly response: ServerResponse;
  readonly isAuthorized: () => boolean;
  readonly dispose: () => void;
}

export class BoardLiveEvents {
  private readonly subscribers = new Set<Subscriber>();
  private readonly maximumClients: number;
  private sequence = 0;
  private readonly revisions = new Map<BoardInvalidation, number>();

  constructor(maximumClients = 16) {
    this.maximumClients = maximumClients;
  }

  /** Last revision published for a scope; used by tests and diagnostics only. */
  revisionOf(scope: BoardInvalidation): number {
    return this.revisions.get(scope) ?? 0;
  }

  subscribe(response: ServerResponse, isAuthorized: () => boolean): boolean {
    if (this.subscribers.size >= this.maximumClients) return false;
    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store, no-transform');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Accel-Buffering', 'no');
    response.setHeader('Connection', 'keep-alive');
    response.flushHeaders();
    let stopped = false;
    let timer: ReturnType<typeof setInterval>;
    const dispose = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      response.off('close', dispose);
      this.subscribers.delete(client);
    };
    const client: Subscriber = { response, isAuthorized, dispose };
    this.subscribers.add(client);
    response.on('close', dispose);
    // `seq` lets a reconnecting client discard frames it already applied.
    response.write(`retry: 3000\nevent: ready\ndata: ${JSON.stringify({ ok: true, seq: this.sequence })}\n\n`);
    timer = setInterval(() => {
      if (!isAuthorized() || response.writableEnded || response.destroyed) {
        dispose();
        response.end();
        return;
      }
      try {
        if (!response.write(': heartbeat\n\n')) {
          dispose();
          response.end();
        }
      } catch {
        dispose();
        response.end();
      }
    }, 15_000);
    timer.unref?.();
    return true;
  }

  /** Publish after the underlying state is persisted. Optional `resource` narrows the hint. */
  publish(scope: BoardInvalidation, resource?: string): InvalidationFrame {
    const revision = (this.revisions.get(scope) ?? 0) + 1;
    this.revisions.set(scope, revision);
    const frame: InvalidationFrame = {
      scope,
      seq: ++this.sequence,
      revision,
      at: new Date().toISOString(),
      ...(resource ? { resource } : {})
    };
    const payload = `id: ${frame.seq}\nevent: invalidate\ndata: ${JSON.stringify(frame)}\n\n`;
    for (const client of [...this.subscribers]) {
      const response = client.response;
      if (!client.isAuthorized() || response.writableEnded || response.destroyed) {
        client.dispose();
        response.end();
        continue;
      }
      try {
        if (!response.write(payload)) {
          client.dispose();
          response.end();
        }
      } catch {
        client.dispose();
        response.end();
      }
    }
    return frame;
  }

  close(): void {
    for (const client of [...this.subscribers]) {
      client.dispose();
      client.response.end();
    }
  }
}