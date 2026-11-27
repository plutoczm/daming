import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createAttachedMagpieHost } from '../src/magpie-attached-host.ts';
import { projectMagpieGatewayTargets } from '../src/magpie-unified-targets.ts';

test('existing Magpie gateway attachment imports models, Agent subscriptions and route groups only', async () => {
  const key = 'fixture-GATEWAY-KEY-no-real-spending';
  const seen: string[] = [];
  const fake = createServer((req, res) => {
    seen.push((req.method ?? '') + ' ' + (req.url ?? ''));
    if (req.method === 'GET' && req.url === '/api/hello') {
      assert.equal(req.headers.authorization, undefined);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ name: 'magpie' }));
      return;
    }
    assert.equal(req.headers.authorization, 'Bearer ' + key);
    if (req.method !== 'GET' || req.url !== '/v1/models') {
      res.writeHead(403).end(); return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ object: 'list', data: [
      { id: 'codex/gpt-6', sub: true, accountId: 'secret-login@example.com' },
      { id: 'deepseek/deepseek-chat', sub: false, apiKey: 'sk-never-leak' },
      { id: 'group/coding-team', name: 'Coding Team' },
      { id: 'auto/gpt-6', name: 'Auto route' },
      { id: 'https://unsafe.local/request' }
    ] }));
  });
  fake.listen(0, '127.0.0.1');
  await once(fake, 'listening');
  const address = fake.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const attached = createAttachedMagpieHost({ port: address.port, key });
    const status = await attached.ensure();
    assert.equal(status.running, true);
    assert.equal(status.configured, true);
    const catalog = await attached.unifiedTargets!();
    assert.deepEqual(catalog.targets.map(x => [x.targetId,x.kind]), [
      ['codex/gpt-6', 'agent-backed'],
      ['deepseek/deepseek-chat', 'llm'],
      ['group/coding-team', 'route-group'],
      ['auto/gpt-6', 'route-group']
    ]);
    assert.doesNotMatch(JSON.stringify(catalog),
      /sk-never-leak|secret-login@example.com|GATEWAY-KEY/);
    assert.equal(catalog.managesCredentialsInMagpie, true);
    assert.equal(catalog.dispatchEnabled, false);
    assert.equal((await attached.routingCatalog!()).candidates.length, 0);
    await assert.rejects(attached.post('plugin-add', { spec: 'x' }),
      /existing_magpie_mutations_not_allowed/);
    attached.stop();
    const refreshed = await attached.unifiedTargets!();
    assert.equal(refreshed.targets.length, 4, 'stop() must not stop user Magpie');
    assert.deepEqual(seen, [
      'GET /api/hello', 'GET /v1/models',
      'GET /api/hello', 'GET /v1/models',
      'GET /api/hello', 'GET /v1/models'
    ], 'gateway attachment must not issue any write or arbitrary HTTP route');
  } finally {
    fake.closeAllConnections();
    await new Promise<void>(resolve => fake.close(() => resolve()));
  }
  assert.throws(() => createAttachedMagpieHost({
    port: 65536, key
  }), /existing_magpie_configuration_invalid/);
  assert.throws(() => createAttachedMagpieHost({
    port: 3457, key: 'invalid\nkey-value-with-newline'
  }), /existing_magpie_configuration_invalid/);
});

test('untrusted gateway catalog requires a valid models array', () => {
  assert.throws(() => projectMagpieGatewayTargets({ data: 'secret' }),
    /magpie_gateway_models_schema_invalid/);
  assert.equal(projectMagpieGatewayTargets({
    data: [{ id: 'group/allowed' }, { id: 'token/stolen' },
      { id: 'openai/gpt-6' }]
  }).targets.map(t => t.targetId).join(','), 'group/allowed,openai/gpt-6');
});
