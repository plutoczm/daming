import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCodexModelConnection } from '../src/codex-model-connection.ts';

const body = JSON.stringify({ model: 'stage/sample', input: 'hello', stream: true });
test('one connection streams early bytes and rejects concurrent or later model requests', async t => {
  let sends = 0;
  let finish!: () => void;
  const finished = new Promise<void>(r => { finish = r; });
  const connection = await createCodexModelConnection('stage/sample', async () => {
    sends++;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: first\n\n'));
        void finished.then(() => { controller.enqueue(new TextEncoder().encode('data: last\n\n')); controller.close(); });
      }
    }), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  t.after(() => connection.close());
  const request = () => fetch(connection.baseUrl + '/responses', {
    method: 'POST', headers: { Authorization: 'Bearer ' + connection.token }, body
  });
  const [a, b] = await Promise.all([request(), request()]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const reader = (a.ok ? a : b).body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /first/);
  assert.equal(sends, 1);
  finish();
  assert.match(new TextDecoder().decode((await reader.read()).value), /last/);
  await reader.cancel();
  assert.equal((await request()).status, 409);
  assert.equal(sends, 1);
});

test('untrusted paths, models, origins and credentials never consume the model permit', async t => {
  let sends = 0;
  const connection = await createCodexModelConnection('stage/sample', async () => {
    sends++; return new Response('data: ok\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  });
  t.after(() => connection.close());
  const call = (path = '/responses', payload = body, extra: Record<string,string> = {}) =>
    fetch(connection.baseUrl + path, { method: 'POST',
      headers: { Authorization: 'Bearer ' + connection.token, ...extra }, body: payload });
  assert.equal((await call('/responses', body, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await call('/responses', body, { Origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await call('/chat/completions')).status, 404);
  assert.equal((await call('/responses', body.replace('stage/sample','other/model'))).status, 400);
  assert.equal((await call('/responses', '{')).status, 400);
  assert.equal((await call('/responses', JSON.stringify({ model: 'stage/sample', stream: false }))).status, 400);
  assert.equal((await call('/responses', ' '.repeat(256 * 1024 + 1))).status, 413);
  assert.equal(sends, 0);
  assert.equal((await call()).status, 200);
  assert.equal(sends, 1);
});

test('failed sends stay consumed and exceptions cannot leak credentials', async t => {
  let sends = 0;
  const connection = await createCodexModelConnection('stage/sample', async () => {
    sends++; throw new Error('secret-api-key-must-not-leak');
  });
  t.after(() => connection.close());
  const call = () => fetch(connection.baseUrl + '/responses', { method: 'POST',
    headers: { Authorization: 'Bearer ' + connection.token }, body });
  const first = await call();
  assert.equal(first.status, 502);
  assert.doesNotMatch(await first.text(), /secret-api-key/);
  assert.equal(connection.signal.aborted, true, 'caller can terminate Codex immediately after upstream failure');
  assert.equal((await call()).status, 409);
  assert.equal(sends, 1);
});

test('closing connection aborts its pending upstream and never leaves a listener', async () => {
  let sent!: () => void;
  const sending = new Promise<void>(r => { sent = r; });
  let aborted = false;
  const connection = await createCodexModelConnection('stage/sample', async (_body, signal) => {
    return await new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
      sent();
    });
  });
  const request = fetch(connection.baseUrl + '/responses', { method: 'POST',
    headers: { Authorization: 'Bearer ' + connection.token }, body }).catch(() => null);
  await sending;
  await connection.close();
  await request;
  assert.equal(aborted, true);
  await assert.rejects(fetch(connection.baseUrl + '/responses'));
});

test('client closing a completed Responses stream does not turn success into transport failure', async t => {
  const connection = await createCodexModelConnection('stage/sample', async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed"}\n\n')); }
  }), { headers: { 'Content-Type': 'text/event-stream' } }));
  t.after(() => connection.close());
  const response = await fetch(connection.baseUrl + '/responses', { method: 'POST',
    headers: { Authorization: 'Bearer ' + connection.token }, body });
  const reader = response.body!.getReader();
  await reader.read(); await reader.cancel();
  await new Promise(r => setTimeout(r,30));
  assert.equal(connection.signal.aborted, false);
});
