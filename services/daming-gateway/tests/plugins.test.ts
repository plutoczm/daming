import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createGatewayServer, listen, openAICompatiblePlugin, ProviderRegistry } from '../src/index.ts';
import type { ProviderPlugin } from '../src/index.ts';

const fixture = (id: string, content = 'OK'): ProviderPlugin => ({
  id, models: ['fx'], complete: async () => ({ status: 200, contentType: 'application/json', bodyText: JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }) }),
});

test('ProviderRegistry: models, candidates round-robin, duplicate rejected', () => {
  const r = new ProviderRegistry();
  r.register(fixture('a'));
  r.register({ ...fixture('b'), models: ['fx'] });
  assert.throws(() => r.register(fixture('a')), /provider_plugin_duplicate/);
  assert.deepEqual(r.models(), ['fx']);
  const c1 = r.candidates('fx').map((p) => p.id);
  const c2 = r.candidates('fx').map((p) => p.id);
  assert.notDeepEqual(c1, c2, 'candidate order rotates');
});

test('Gateway driven by a custom provider PLUGIN (no HTTP upstream) serves chat + messages', async () => {
  const h = createGatewayServer({ plugins: [fixture('local-fx')], models: ['fx'] });
  const base = await listen(h, 0);
  try {
    const models = await (await fetch(base + '/v1/models')).json() as { data: { id: string }[] };
    assert.equal(models.data[0].id, 'fx');
    const chat = await (await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fx', messages: [{ role: 'user', content: 'hi' }] }) })).json() as { choices: { message: { content: string } }[] };
    assert.equal(chat.choices[0].message.content, 'OK');
    const msg = await (await fetch(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fx', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }) })).json() as { type: string; content: { text: string }[] };
    assert.equal(msg.type, 'message');
    assert.equal(msg.content[0].text, 'OK');
  } finally { await h.close(); }
});

test('openAICompatiblePlugin posts to <base>/v1/chat/completions', async () => {
  const p = openAICompatiblePlugin({ id: 'x', baseUrl: 'http://127.0.0.1:1/', models: ['m'] });
  assert.equal(p.streamBaseUrl, 'http://127.0.0.1:1');
  assert.equal(p.models[0], 'm');
});

test('openAICompatiblePlugin sends configured headers (e.g. bearer key)', async () => {  const reqs: string[] = [];
  const srv = createServer((req, res) => { reqs.push(String(req.headers.authorization ?? '')); req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })); }); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const url = 'http://127.0.0.1:' + (srv.address() as { port: number }).port;
    const p = openAICompatiblePlugin({ id: 'k', baseUrl: url, models: ['m'], headers: { authorization: 'Bearer secret-key' } });
    const r = await p.complete(JSON.stringify({ model: 'm', messages: [] }));
    assert.equal(r.status, 200);
    assert.equal(reqs[0], 'Bearer secret-key');
  } finally { await new Promise<void>((r) => srv.close(() => r())); }
});

const mk = (id: string, weight?: number): ProviderPlugin => ({ id, models: ['m'], ...(weight ? { weight } : {}), complete: async () => ({ status: 200, contentType: 'application/json', bodyText: '{}' }) });

test('ProviderRegistry: weighted smooth round-robin (3:1 over 8 picks -> 6/2)', () => {
  const r = new ProviderRegistry();
  r.register(mk('a', 3)); r.register(mk('b', 1));
  const picks: string[] = [];
  for (let i = 0; i < 8; i++) picks.push(r.candidates('m')[0].id);
  assert.equal(picks.filter((x) => x === 'a').length, 6);
  assert.equal(picks.filter((x) => x === 'b').length, 2);
});

test('ProviderRegistry: health cooldown pushes failed plugin to the end', () => {
  const r = new ProviderRegistry({ cooldownMs: 20000 });
  r.register(mk('a')); r.register(mk('b'));
  r.markFailure('a', 1000); // cooling until 21000
  assert.equal(r.candidates('m', 2000)[0].id, 'b', 'failed provider is not picked while cooling');
  assert.ok(r.candidates('m', 30000).some((p) => p.id === 'a'), 'recovers after cooldown');
  r.markSuccess('a');
  assert.ok(r.candidates('m', 2000).some((p) => p.id === 'a'));
});
