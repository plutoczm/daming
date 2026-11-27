import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createGatewayServer, listen } from '../src/index.ts';

function fakeUpstream(content = 'OK'): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
        const body = JSON.parse(b || '{}') as { stream?: boolean };
        if (req.url === '/v1/chat/completions') {
          if (body.stream) {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write('data: {"choices":[{"delta":{"content":"' + content + '"}}]}\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
          } else {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 2 } } }));
          }
        } else { res.writeHead(404); res.end(); }
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ url: 'http://127.0.0.1:' + (srv.address() as { port: number }).port, close: () => new Promise<void>((r) => srv.close(() => r())) }));
  });
}

test('Daming gateway: models + OpenAI chat (non-stream) + Anthropic messages (non-stream)', async () => {
  const up = await fakeUpstream();
  const h = createGatewayServer({ upstreamBaseUrl: up.url, models: ['qwen3:8b'] });
  const base = await listen(h, 0);
  try {
    const models = await (await fetch(base + '/v1/models')).json() as { data: { id: string }[] };
    assert.equal(models.data[0].id, 'qwen3:8b');

    const chat = await (await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen3:8b', messages: [{ role: 'user', content: 'hi' }] }) })).json() as { choices: { message: { content: string } }[] };
    assert.equal(chat.choices[0].message.content, 'OK');

    const msg = await (await fetch(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen3:8b', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }) })).json() as { type: string; content: { text: string }[]; usage: { input_tokens: number; output_tokens: number } };
    assert.equal(msg.type, 'message');
    assert.equal(msg.content[0].text, 'OK');
    assert.equal(msg.usage.output_tokens, 1);
  } finally { await h.close(); await up.close(); }
});

test('Daming gateway: OpenAI chat stream passthrough + Anthropic messages stream', async () => {
  const up = await fakeUpstream();
  const h = createGatewayServer({ upstreamBaseUrl: up.url, models: ['qwen3:8b'] });
  const base = await listen(h, 0);
  try {
    const s = await (await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen3:8b', stream: true, messages: [{ role: 'user', content: 'hi' }] }) })).text();
    assert.ok(s.includes('OK') && s.includes('[DONE]'));

    const a = await (await fetch(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen3:8b', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hi' }] }) })).text();
    assert.ok(a.includes('message_start') && a.includes('content_block_delta') && a.includes('message_stop'));
  } finally { await h.close(); await up.close(); }
});

test('Daming gateway: OpenAI /v1/responses (non-stream) + usage summary', async () => {
  const up = await fakeUpstream('OK');
  const h = createGatewayServer({ upstreamBaseUrl: up.url, models: ['qwen3:8b'] });
  const base = await listen(h, 0);
  try {
    const r = await (await fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen3:8b', input: 'hi', max_output_tokens: 16 }) })).json() as { object: string; output_text: string; output: { content: { text: string }[] }[]; usage: { input_tokens: number; output_tokens: number } };
    assert.equal(r.object, 'response');
    assert.equal(r.output_text, 'OK');
    assert.equal(r.output[0].content[0].text, 'OK');
    assert.equal(r.usage.input_tokens, 5);
    const sum = await (await fetch(base + '/api/usage/summary')).json() as { requests: number; inputTokens: number; cachedTokens: number };
    assert.ok(sum.requests >= 1);
    assert.equal(sum.cachedTokens, 2);
  } finally { await h.close(); await up.close(); }
});

test('Daming gateway: bearer auth required when configured', async () => {
  const up = await fakeUpstream();
  const h = createGatewayServer({ upstreamBaseUrl: up.url, models: ['qwen3:8b'], apiKey: 'k-secret' });
  const base = await listen(h, 0);
  try {
    assert.equal((await fetch(base + '/v1/models')).status, 401);
    assert.equal((await fetch(base + '/v1/models', { headers: { authorization: 'Bearer k-secret' } })).status, 200);
  } finally { await h.close(); await up.close(); }
});

test('Daming gateway: usage dashboard + recent requests', async () => {
  const up = await fakeUpstream('OK');
  const h = createGatewayServer({ upstreamBaseUrl: up.url, models: ['qwen3:8b'] });
  const base = await listen(h, 0);
  try {
    await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen3:8b', messages: [{ role: 'system', content: 'You are helpful.' }, { role: 'user', content: 'hi there' }] }) });
    const recent = await (await fetch(base + '/api/usage/recent')).json() as { recent: unknown[] };
    assert.equal(recent.recent.length, 1);
    const sum = await (await fetch(base + '/api/usage/summary')).json() as { composition: { system: number; conversation: number } };
    assert.ok(sum.composition.system > 0 && sum.composition.conversation > 0, 'composition split recorded');
    const dash = await (await fetch(base + '/dashboard')).text();
    assert.ok(dash.includes('Daming Gateway') && dash.includes('qwen3:8b') && dash.includes('Cache hit') && dash.includes('Prompt composition'));
  } finally { await h.close(); await up.close(); }
});

test('Daming gateway: round-robin across providers serving same model', async () => {
  const a = await fakeUpstream('AAA');
  const b = await fakeUpstream('BBB');
  const h = createGatewayServer({ providers: [{ id: 'a', baseUrl: a.url, models: ['qwen3:8b'] }, { id: 'b', baseUrl: b.url, models: ['qwen3:8b'] }], models: ['qwen3:8b'] });
  const base = await listen(h, 0);
  try {
    const call = async () => (await (await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen3:8b', messages: [{ role: 'user', content: 'hi' }] }) })).json() as { choices: { message: { content: string } }[] }).choices[0].message.content;
    const first = await call();
    const second = await call();
    assert.notEqual(first, second, 'round-robin should hit different providers');
    assert.deepEqual(new Set([first, second]), new Set(['AAA', 'BBB']));
  } finally { await h.close(); await a.close(); await b.close(); }
});

test('Daming gateway: X-Daming-Task-Id attributes usage without guessing', async () => {
  const up = await fakeUpstream('OK');
  const h = createGatewayServer({ upstreamBaseUrl: up.url, models: ['qwen3:8b'] });
  const base = await listen(h, 0);
  try {
    await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-daming-task-id': 'task-abc-1234', 'x-daming-agent-id': 'dsh' },
      body: JSON.stringify({ model: 'qwen3:8b', messages: [{ role: 'user', content: 'hi' }] })
    });
    await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3:8b', messages: [{ role: 'user', content: 'hi' }] })
    });
    const recent = await (await fetch(base + '/api/usage/recent')).json() as { recent: { taskId?: string; agentId?: string }[] };
    assert.equal(recent.recent.length, 2);
    const attributed = recent.recent.filter((row) => row.taskId === 'task-abc-1234');
    assert.equal(attributed.length, 1);
    assert.equal(attributed[0].agentId, 'dsh');
    assert.equal(recent.recent.filter((row) => row.taskId === undefined).length, 1, 'a header-less request stays unattributed');
    const dash = await (await fetch(base + '/dashboard')).text();
    assert.ok(dash.includes('task-abc-1234'), 'dashboard shows the attributed task');
  } finally { await h.close(); await up.close(); }
});
