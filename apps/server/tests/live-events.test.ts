import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import { test } from 'node:test';
import { BOARD_INVALIDATION_SCOPES, BoardLiveEvents } from '../src/live-events.ts';

/** Minimal SSE response double: records frames and lets the test drop the socket. */
class FakeResponse {
  readonly chunks: string[] = [];
  readonly headers: Record<string, string> = {};
  statusCode = 0;
  writableEnded = false;
  destroyed = false;
  private readonly listeners = new Map<string, Set<() => void>>();
  setHeader(name: string, value: string): this { this.headers[name] = value; return this; }
  flushHeaders(): void { /* headers are asserted directly */ }
  write(chunk: string): boolean {
    if (this.destroyed || this.writableEnded) return false;
    this.chunks.push(String(chunk));
    return true;
  }
  on(event: string, callback: () => void): this {
    const set = this.listeners.get(event) ?? new Set();
    set.add(callback);
    this.listeners.set(event, set);
    return this;
  }
  off(event: string, callback: () => void): this {
    this.listeners.get(event)?.delete(callback);
    return this;
  }
  end(): void { this.writableEnded = true; }
  emit(event: string): void { for (const callback of [...this.listeners.get(event) ?? []]) callback(); }
  get text(): string { return this.chunks.join(''); }
  get asResponse(): ServerResponse { return this as unknown as ServerResponse; }
}

function frames(text: string): { id?: string; event?: string; data?: Record<string, unknown> }[] {
  return text.split('\n\n').filter(Boolean).map((block) => {
    const entry: { id?: string; event?: string; data?: Record<string, unknown> } = {};
    for (const line of block.split('\n')) {
      if (line.startsWith('id: ')) entry.id = line.slice(4);
      else if (line.startsWith('event: ')) entry.event = line.slice(7);
      else if (line.startsWith('data: ')) entry.data = JSON.parse(line.slice(6)) as Record<string, unknown>;
    }
    return entry;
  });
}

test('every business scope is publishable and each frame carries a monotonic seq + scope revision', () => {
  const events = new BoardLiveEvents();
  const response = new FakeResponse();
  assert.equal(events.subscribe(response.asResponse, () => true), true);
  const ready = frames(response.text);
  assert.equal(ready[0]?.event, 'ready');
  assert.equal(ready[0]?.data?.seq, 0);

  assert.ok(BOARD_INVALIDATION_SCOPES.includes('providers'));
  assert.ok(BOARD_INVALIDATION_SCOPES.includes('gateway'));
  assert.ok(BOARD_INVALIDATION_SCOPES.includes('crew'));
  assert.ok(BOARD_INVALIDATION_SCOPES.includes('notifications'));
  assert.ok(BOARD_INVALIDATION_SCOPES.includes('portfolio'));

  const first = events.publish('providers', 'provider');
  const second = events.publish('providers');
  const third = events.publish('gateway', 'usage');
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 2);
  assert.equal(third.revision, 1);
  assert.deepEqual([first.seq, second.seq, third.seq], [1, 2, 3]);
  assert.equal(events.revisionOf('providers'), 2);
  assert.equal(events.revisionOf('gateway'), 1);
  assert.equal(events.revisionOf('agents'), 0);

  const published = frames(response.text).filter((frame) => frame.event === 'invalidate');
  assert.deepEqual(published.map((frame) => frame.id), ['1', '2', '3']);
  assert.deepEqual(published.map((frame) => frame.data?.scope), ['providers', 'providers', 'gateway']);
  assert.deepEqual(published.map((frame) => frame.data?.revision), [1, 2, 1]);
  assert.equal(published[0]?.data?.resource, 'provider');
  assert.equal(typeof published[0]?.data?.at, 'string');
  events.close();
});

test('a subscriber whose session was revoked stops receiving hints', () => {
  const events = new BoardLiveEvents();
  const response = new FakeResponse();
  let authorized = true;
  events.subscribe(response.asResponse, () => authorized);
  events.publish('tasks');
  const before = response.text;
  authorized = false;
  events.publish('tasks');
  assert.equal(response.text, before, 'a revoked session must not receive more frames');
  assert.equal(response.writableEnded, true);
  events.close();
});

test('a dropped socket is removed so later publishes do not touch it', () => {
  const events = new BoardLiveEvents();
  const response = new FakeResponse();
  events.subscribe(response.asResponse, () => true);
  response.destroyed = true;
  events.publish('agents');
  const afterDrop = response.chunks.length;
  events.publish('agents');
  assert.equal(response.chunks.length, afterDrop);
  assert.equal(response.writableEnded, true);
  events.close();
});

test('live connections stay bounded', () => {
  const events = new BoardLiveEvents(2);
  const one = new FakeResponse();
  const two = new FakeResponse();
  const three = new FakeResponse();
  assert.equal(events.subscribe(one.asResponse, () => true), true);
  assert.equal(events.subscribe(two.asResponse, () => true), true);
  assert.equal(events.subscribe(three.asResponse, () => true), false);
  events.close();
  assert.equal(one.writableEnded, true);
  assert.equal(two.writableEnded, true);
});