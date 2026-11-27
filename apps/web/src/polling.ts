/**
 * One request at a time per resource, with visibility-aware scheduling and
 * invalidation generations. A stale result can never replace newer state.
 * No React or browser globals here so the state machine is unit-testable.
 */
export interface PollingHost {
  visible(): boolean;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
  onVisibilityChange(callback: () => void): () => void;
}

export interface PollingOptions<T> {
  readonly host: PollingHost;
  readonly fetcher: (signal: AbortSignal) => Promise<T>;
  readonly onData: (data: T) => void;
  readonly onError?: (reason: unknown) => void;
  readonly intervalMs: () => number;
}

export function createAdaptivePoller<T>(options: PollingOptions<T>): {
  start(): void;
  stop(): void;
  invalidate(): void;
} {
  let running = false;
  let generation = 0;
  let timer: unknown;
  let inFlight: AbortController | undefined;
  let queued = false;
  let unbind: (() => void) | undefined;

  const cancelTimer = () => {
    if (timer !== undefined) {
      options.host.cancel(timer);
      timer = undefined;
    }
  };
  const schedule = (delay: number) => {
    cancelTimer();
    if (!running || !options.host.visible()) return;
    timer = options.host.schedule(() => {
      timer = undefined;
      void refresh();
    }, Math.max(0, Math.min(300_000, Number.isFinite(delay) ? delay : 30_000)));
  };
  const refresh = async () => {
    if (!running || !options.host.visible()) return;
    if (inFlight) { queued = true; return; }
    const controller = new AbortController();
    inFlight = controller;
    const expectedGeneration = generation;
    try {
      const data = await options.fetcher(controller.signal);
      if (running && options.host.visible() && !controller.signal.aborted && generation === expectedGeneration) {
        options.onData(data);
      }
    } catch (reason) {
      if (running && options.host.visible() && !controller.signal.aborted && generation === expectedGeneration) {
        options.onError?.(reason);
      }
    } finally {
      if (inFlight !== controller) return;
      inFlight = undefined;
      if (!running || !options.host.visible()) return;
      if (queued || generation !== expectedGeneration) {
        queued = false;
        schedule(0);
      } else {
        schedule(options.intervalMs());
      }
    }
  };
  const invalidate = () => {
    if (!running) return;
    generation++;
    if (!options.host.visible()) return;
    if (inFlight) { queued = true; return; }
    schedule(0);
  };
  const visibilityChanged = () => {
    if (!running) return;
    if (!options.host.visible()) {
      generation++;
      cancelTimer();
      const pending = inFlight;
      inFlight = undefined;
      queued = false;
      pending?.abort();
    } else {
      invalidate();
    }
  };
  return {
    start() {
      if (running) return;
      running = true;
      unbind = options.host.onVisibilityChange(visibilityChanged);
      schedule(0);
    },
    stop() {
      if (!running) return;
      running = false;
      generation++;
      cancelTimer();
      inFlight?.abort();
      inFlight = undefined;
      queued = false;
      unbind?.();
      unbind = undefined;
    },
    invalidate
  };
}
