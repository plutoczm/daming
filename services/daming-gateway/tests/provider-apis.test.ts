import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { anthropicCompatiblePlugin, openAIResponsesPlugin, parseGatewayConfig, pluginsFromConfig } from '../src/index.ts';

async function fake(handler: (path: string, body: string, headers: Record<string, unknown>, res: import('node:http').ServerResponse) => void) {
  const srv = createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => handler(req.url || '', b, req.headers as Record<string, unknown>, res)); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + (srv.address() as { port: number }).port;
  return { url, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

test('anthropicCompatiblePlugin: OpenAI body → POST /v1/messages → OpenAI JSON', async () => {
  let path = '', body = '', auth = '';
  const s = await fake((p, b, h, res) => { path = p; body = b; auth = String(h['authorization'] ?? h['x-api-key'] ?? ''); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 3, output_tokens: 1 } })); });
  try {
    const p = anthropicCompatiblePlugin({ id: 'zc', baseUrl: s.url, models: ['glm-5.3'], headers: { authorization: 'Bearer k' } });
    const r = await p.complete(JSON.stringify({ model: 'glm-5.3', max_tokens: 16, messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }] }));
    assert.equal(r.status, 200);
    const j = JSON.parse(r.bodyText);
    assert.equal(j.choices[0].message.content, 'OK');
    assert.equal(path, '/v1/messages');
    assert.ok(body.includes('"system":"sys"'));
    assert.equal(auth, 'Bearer k');
  } finally { await s.close(); }
});

test('openAIResponsesPlugin: OpenAI body → POST /v1/responses → OpenAI JSON', async () => {
  let path = '';
  const s = await fake((p, b, h, res) => { path = p; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ output_text: 'OK', usage: { input_tokens: 2, output_tokens: 1 } })); });
  try {
    const p = openAIResponsesPlugin({ id: 'r', baseUrl: s.url, models: ['m'], headers: { authorization: 'Bearer k' } });
    const r = await p.complete(JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }));
    assert.equal(JSON.parse(r.bodyText).choices[0].message.content, 'OK');
    assert.equal(path, '/v1/responses');
  } finally { await s.close(); }
});

test('pluginsFromConfig builds anthropic provider (api:anthropic-messages) adding it by config alone', async () => {
  const s = await fake((p, b, h, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 1, output_tokens: 1 } })); });
  try {
    const cfg = parseGatewayConfig(JSON.stringify({ providers: [{ id: 'zcode', api: 'anthropic-messages', baseUrl: s.url, models: ['glm-5.3'], apiKeyEnv: 'ZCODE_KEY' }] }));
    const plugins = pluginsFromConfig(cfg, { ZCODE_KEY: 'z' });
    assert.equal(plugins[0].id, 'zcode');
    assert.deepEqual([...plugins[0].models], ['glm-5.3']);
    const r = await plugins[0].complete(JSON.stringify({ model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }] }));
    assert.equal(JSON.parse(r.bodyText).choices[0].message.content, 'OK');
  } finally { await s.close(); }
});

test('pluginsFromConfig rejects unsupported api; missing key fails closed', () => {
  assert.throws(() => pluginsFromConfig(parseGatewayConfig(JSON.stringify({ providers: [{ id: 'x', api: 'grpc', baseUrl: 'https://x', models: ['m'] }] }))), /gateway_provider_api_unsupported/);
  assert.throws(() => pluginsFromConfig(parseGatewayConfig(JSON.stringify({ providers: [{ id: 'x', api: 'anthropic-messages', baseUrl: 'https://x', models: ['m'], apiKeyEnv: 'NOPE' }] })), {}), /gateway_provider_key_missing:x/);
});
