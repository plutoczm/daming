import { useEffect, useRef, useState } from 'react';
import { createAdaptivePoller } from './polling.ts';
import { createInvalidationGate, parseInvalidation } from './live-event-gate.ts';

/**
 * Business resources that can be invalidated by the Host. Each scope is published
 * by the Host only after the underlying state was persisted, so a refetch triggered
 * by these hints always reads the committed value.
 */
export type RefreshScope =
  | 'tasks' | 'autoloop' | 'magpie' | 'lulu' | 'codex' | 'missions'
  | 'crew' | 'providers' | 'agents' | 'routing' | 'gateway' | 'platform'
  | 'notifications' | 'portfolio';

export type LiveConnection = 'connecting' | 'live' | 'fallback' | 'paused';

export const REFRESH_SCOPES: readonly RefreshScope[] = [
  'tasks', 'autoloop', 'magpie', 'lulu', 'codex', 'missions',
  'crew', 'providers', 'agents', 'routing', 'gateway', 'platform',
  'notifications', 'portfolio'
];

const subscribers = new Map<RefreshScope, Set<() => void>>();

export function notifyRefresh(scope: RefreshScope): void {
  for (const callback of subscribers.get(scope) ?? []) callback();
}

function subscribe(scope: RefreshScope, callback: () => void): () => void {
  let callbacks = subscribers.get(scope);
  if (!callbacks) {
    callbacks = new Set();
    subscribers.set(scope, callbacks);
  }
  callbacks.add(callback);
  return () => {
    callbacks!.delete(callback);
    if (!callbacks!.size) subscribers.delete(scope);
  };
}

const scopes = new Set<RefreshScope>(REFRESH_SCOPES);
const browserHost = {
  visible: () => document.visibilityState !== 'hidden',
  schedule: (callback: () => void, delayMs: number): unknown => window.setTimeout(callback, delayMs),
  cancel: (timer: unknown) => window.clearTimeout(timer as number),
  onVisibilityChange: (callback: () => void) => {
    document.addEventListener('visibilitychange', callback);
    window.addEventListener('focus', callback);
    return () => {
      document.removeEventListener('visibilitychange', callback);
      window.removeEventListener('focus', callback);
    };
  }
};

interface Resource<T> {
  readonly enabled: boolean;
  readonly identity: string;
  readonly scope: RefreshScope;
  /** Extra scopes that should also revalidate this resource (e.g. portfolio + tasks). */
  readonly scopes?: readonly RefreshScope[];
  readonly intervalMs: number | (() => number);
  readonly fetcher: (signal: AbortSignal) => Promise<T>;
  readonly onData: (value: T) => void;
  readonly onError?: (reason: unknown) => void;
}

/** Resources have one in-flight GET each, never overlapping interval requests. */
export function useAdaptiveResource<T>(resource: Resource<T>): void {
  const latest = useRef(resource);
  latest.current = resource;
  const extraScopes = resource.scopes?.join(',') ?? '';
  useEffect(() => {
    if (!resource.enabled) return;
    const poller = createAdaptivePoller<T>({
      host: browserHost,
      fetcher: (signal) => latest.current.fetcher(signal),
      onData: (data) => latest.current.onData(data),
      onError: (reason) => latest.current.onError?.(reason),
      intervalMs: () => {
        const value = latest.current.intervalMs;
        return typeof value === 'function' ? value() : value;
      }
    });
    const listened = new Set<RefreshScope>([resource.scope, ...(resource.scopes ?? [])]);
    const unsubscribes = [...listened].map((scope) => subscribe(scope, poller.invalidate));
    poller.start();
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
      poller.stop();
    };
  }, [resource.enabled, resource.identity, resource.scope, extraScopes]);
}

/**
 * A single authenticated EventSource per visible tab; bounded polling remains fallback.
 * Frames are deduplicated by the Host sequence number, so a reconnecting stream never
 * re-applies history; after a reconnect every visible resource re-validates once.
 */
export function useLiveConnection(enabled: boolean): LiveConnection {
  const [status, setStatus] = useState<LiveConnection>('connecting');
  useEffect(() => {
    if (!enabled) return;
    let stream: EventSource | undefined;
    let disposed = false;
    let connectedBefore = false;
    const gate = createInvalidationGate();
    const close = () => {
      stream?.close();
      stream = undefined;
    };
    const open = () => {
      close();
      if (disposed) return;
      if (document.visibilityState === 'hidden') {
        setStatus('paused');
        return;
      }
      if (typeof EventSource === 'undefined') {
        setStatus('fallback');
        return;
      }
      setStatus('connecting');
      const next = new EventSource('/api/events');
      stream = next;
      next.addEventListener('ready', (event) => {
        if (disposed || stream !== next) return;
        try {
          const payload = JSON.parse((event as MessageEvent).data) as { seq?: unknown };
          if (typeof payload.seq === 'number') gate.reset(payload.seq);
        } catch {
          // A malformed ready frame only leaves the cursor where it was.
        }
        setStatus('live');
        // Re-validate after a lost stream, without multiplying initial GETs.
        if (connectedBefore) for (const scope of scopes) notifyRefresh(scope);
        connectedBefore = true;
      });
      next.addEventListener('invalidate', (event) => {
        if (disposed || stream !== next) return;
        const frame = parseInvalidation((event as MessageEvent).data);
        if (!frame || !scopes.has(frame.scope as RefreshScope)) return;
        if (!gate.accept(frame)) return;
        notifyRefresh(frame.scope as RefreshScope);
      });
      next.onerror = () => {
        // EventSource retries on its own; polling covers the gap until `ready` returns.
        if (!disposed && stream === next) setStatus('fallback');
      };
    };
    const visibility = () => {
      if (document.visibilityState === 'hidden') {
        close();
        setStatus('paused');
      } else {
        open();
      }
    };
    document.addEventListener('visibilitychange', visibility);
    open();
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', visibility);
      close();
    };
  }, [enabled]);
  return status;
}