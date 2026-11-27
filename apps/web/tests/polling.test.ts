import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAdaptivePoller, type PollingHost } from '../src/polling.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

class FakeHost implements PollingHost {
  private now = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; callback: () => void }>();
  private listeners = new Set<() => void>();
  visibleNow = true;

  visible(): boolean { return this.visibleNow; }
  schedule(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + delayMs, callback });
    return id;
  }
  cancel(handle: unknown): void { this.timers.delete(handle as number); }
  onVisibilityChange(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => { this.listeners.delete(callback); };
  }
  setVisible(value: boolean): void {
    this.visibleNow = value;
    for (const callback of this.listeners) callback();
  }
  advance(milliseconds: number): void {
    this.now += milliseconds;
    for (let i = 0; i < 100; i++) {
      const due = [...this.timers].filter(([, value]) => value.at <= this.now).sort((a, b) => a[1].at - b[1].at);
      if (!due.length) break;
      for (const [id, entry] of due) {
        if (!this.timers.delete(id)) continue;
        entry.callback();
      }
    }
  }
  get scheduled(): number { return this.timers.size; }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

test('invalidation coalesces an in-flight GET and discards stale responses', async () => {
  const host = new FakeHost();
  const pending: ReturnType<typeof deferred<string>>[] = [];
  const shown: string[] = [];
  const poll = createAdaptivePoller({
    host, intervalMs: () => 10000,
    fetcher: async () => {
      const result = deferred<string>();
      pending.push(result);
      return await result.promise;
    },
    onData: (value) => shown.push(value)
  });
  poll.start();
  host.advance(0);
  assert.equal(pending.length, 1);
  poll.invalidate();
  poll.invalidate();
  assert.equal(pending.length, 1);
  pending[0].resolve('stale-before-change');
  await flush();
  assert.deepEqual(shown, []);
  host.advance(0);
  assert.equal(pending.length, 2);
  pending[1].resolve('latest');
  await flush();
  assert.deepEqual(shown, ['latest']);
  host.advance(9999);
  assert.equal(pending.length, 2);
  host.advance(1);
  assert.equal(pending.length, 3);
  pending[2].resolve('interval-refresh');
  await flush();
  assert.deepEqual(shown, ['latest', 'interval-refresh']);
  poll.stop();
  assert.equal(host.scheduled, 0);
});

test('background tab aborts active requests, pauses network and refreshes on visibility', async () => {
  const host = new FakeHost();
  const pending: { signal: AbortSignal; result: ReturnType<typeof deferred<number>> }[] = [];
  const shown: number[] = [];
  const poll = createAdaptivePoller({
    host, intervalMs: () => 1000,
    fetcher: async (signal) => {
      const result = deferred<number>();
      pending.push({ signal, result });
      return await result.promise;
    },
    onData: (value) => shown.push(value)
  });
  poll.start();
  host.advance(0);
  host.setVisible(false);
  assert.equal(pending[0].signal.aborted, true);
  host.advance(100_000);
  poll.invalidate();
  assert.equal(pending.length, 1);
  pending[0].result.resolve(1);
  await flush();
  assert.deepEqual(shown, []);
  host.setVisible(true);
  host.advance(0);
  assert.equal(pending.length, 2);
  pending[1].result.resolve(2);
  await flush();
  assert.deepEqual(shown, [2]);
  poll.stop();
});

test('failed GET waits for fallback interval rather than retrying continuously', async () => {
  const host = new FakeHost();
  const values: string[] = [];
  const errors: string[] = [];
  let attempts = 0;
  const poll = createAdaptivePoller({
    host, intervalMs: () => 3000,
    fetcher: async () => {
      attempts++;
      if (attempts === 1) throw new Error('offline');
      return 'recovered';
    },
    onData: (value) => values.push(value),
    onError: (reason) => errors.push((reason as Error).message)
  });
  poll.start();
  host.advance(0);
  await flush();
  assert.deepEqual(errors, ['offline']);
  host.advance(2999);
  assert.equal(attempts, 1);
  host.advance(1);
  await flush();
  assert.deepEqual(values, ['recovered']);
  poll.stop();
  assert.equal(host.scheduled, 0);
});
