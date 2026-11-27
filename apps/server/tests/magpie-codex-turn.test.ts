import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withPinnedMagpieTurn } from '../src/magpie-codex-turn.ts';

const binding = { instanceId: 'a'.repeat(32), providerId: 'stage', modelId: 'sample', accountRef: '0123456789' };
function setup() {
  let issued = 0, revoked = 0, sends = 0;
  let available = true;
  const options = {
    binding,
    async checkCurrent() { if (!available) throw new Error('route changed'); },
    async request(method: string, path: string, body?: object): Promise<unknown> {
      if (method === 'POST') {
        issued++;
        assert.deepEqual(body, { name: 'daming-codex-one-turn', ttl: '1m', models: ['stage/sample'],
          accounts: ['stage/0123456789'], tokens: 32768, cost: 0, singleUpstream: true });
        return { id: 'synthetic-key-1234', key: 'sk-magpie-key-synthetic', models: ['stage/sample'],
          accounts: ['stage/0123456789'], singleUpstream: true, expires: new Date(Date.now()+60000).toISOString() };
      }
      assert.equal(method, 'DELETE'); assert.equal(path, '/v1/magpie/keys/synthetic-key-1234');
      revoked++; return {};
    },
    async forward(key: string, body: string, _signal: AbortSignal) {
      assert.equal(key, 'sk-magpie-key-synthetic');
      assert.equal(JSON.parse(body).model, 'stage/sample');
      sends++;
      return new Response('data: ok\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    }
  };
  return { options, stats: () => ({ issued, revoked, sends }), changeRoute: () => { available = false; } };
}
test('pinned Magpie turn issues exact scope, prevents repeated sends and revokes on exit', async () => {
  const { options, stats } = setup();
  let retained: ((body: string, signal: AbortSignal) => Promise<Response>) | undefined;
  await withPinnedMagpieTurn(options, async send => {
    retained = send;
    const body = JSON.stringify({ model: 'stage/sample', stream: true });
    const response = await send(body, new AbortController().signal);
    assert.match(await response.text(), /ok/);
    await assert.rejects(send(body, new AbortController().signal), /consumed/);
  });
  assert.deepEqual(stats(), { issued: 1, revoked: 1, sends: 1 });
  await assert.rejects(retained!('{}', new AbortController().signal), /closed/);
});
test('pinned Magpie turn never issues a key for stale capability/account and revokes on callback failure', async () => {
  const fixture = setup();
  fixture.changeRoute();
  await assert.rejects(withPinnedMagpieTurn(fixture.options, async () => {}));
  assert.deepEqual(fixture.stats(), { issued: 0, revoked: 0, sends: 0 });
  const second = setup();
  await assert.rejects(withPinnedMagpieTurn(second.options, async () => { throw new Error('consumer failed'); }), /consumer failed/);
  assert.deepEqual(second.stats(), { issued: 1, revoked: 1, sends: 0 });
});
test('wrong model or aborted request is rejected before send and failed send cannot be replayed', async () => {
  const { options, stats } = setup();
  await withPinnedMagpieTurn(options, async send => {
    await assert.rejects(send('{"model":"other/sample","stream":true}', new AbortController().signal), /request_invalid/);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(send('{"model":"stage/sample","stream":true}', abort.signal), /aborted/);
  });
  assert.deepEqual(stats(), { issued: 1, revoked: 1, sends: 0 });
  const second = setup();
  second.options.forward = async () => { throw new Error('upstream disconnected'); };
  await withPinnedMagpieTurn(second.options, async send => {
    const body = '{"model":"stage/sample","stream":true}';
    await assert.rejects(send(body, new AbortController().signal), /transport_failed/);
    await assert.rejects(send(body, new AbortController().signal), /consumed/);
  });
  assert.equal(second.stats().revoked, 1);
});

test('subscription scope keeps its stable id separate from API fingerprints', async () => {
  const fixture = setup();
  const subscription = { ...binding, providerId: 'codex', modelId: 'gpt-6.1-sol',
    accountRef: '0123456789abcdef', accountKind: 'codex-subscription' as const };
  const options = { ...fixture.options, binding: subscription,
    async request(method: string, _path: string, body?: object): Promise<unknown> {
      if (method === 'DELETE') return {};
      assert.deepEqual((body as { accounts: string[] }).accounts, ['codex/0123456789abcdef']);
      return { id:'synthetic-subscription-1234', key:'sk-magpie-key-synthetic', models:['codex/gpt-6.1-sol'],
        accounts:['codex/0123456789abcdef'], singleUpstream:true, expires:new Date(Date.now()+60000).toISOString() };
    },
    async forward(_key: string, _body: string, _signal: AbortSignal) { return new Response('ok'); }
  };
  await withPinnedMagpieTurn(options, async send => {
    assert.equal(await (await send('{"model":"codex/gpt-6.1-sol","stream":true}', new AbortController().signal)).text(), 'ok');
  });
  await assert.rejects(withPinnedMagpieTurn({ ...options, binding:{ ...subscription, accountKind:'api-key' } }, async () => {}), /binding_invalid/);
  await assert.rejects(withPinnedMagpieTurn({ ...options, binding:{ ...subscription, providerId:'other' } }, async () => {}), /binding_invalid/);
});
