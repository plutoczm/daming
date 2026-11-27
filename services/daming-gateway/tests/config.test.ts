import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gatewayConfigModels, pluginsFromConfig, parseGatewayConfig } from '../src/index.ts';

test('pluginsFromConfig builds providers and resolves keys from env', () => {
  const cfg = parseGatewayConfig(JSON.stringify({ providers: [
    { id: 'ollama', baseUrl: 'http://localhost:11434', models: ['qwen3:8b'] },
    { id: 'deepseek', baseUrl: 'https://api.deepseek.com', models: ['deepseek-chat'], apiKeyEnv: 'DEEPSEEK_API_KEY' },
  ] }));
  const plugins = pluginsFromConfig(cfg, { DEEPSEEK_API_KEY: 'sk-test' });
  assert.deepEqual(plugins.map((p) => p.id), ['ollama', 'deepseek']);
  assert.deepEqual(gatewayConfigModels(cfg), ['qwen3:8b', 'deepseek-chat']);
});

test('pluginsFromConfig: missing key fails closed', () => {
  const cfg = parseGatewayConfig(JSON.stringify({ providers: [{ id: 'x', baseUrl: 'https://x', models: ['m'], apiKeyEnv: 'NOPE' }] }));
  assert.throws(() => pluginsFromConfig(cfg, {}), /gateway_provider_key_missing:x/);
});

test('pluginsFromConfig: bad config rejected', () => {
  assert.throws(() => parseGatewayConfig('{bad'), /gateway_config_json_invalid/);
  assert.throws(() => pluginsFromConfig({ providers: [{ id: 'a', baseUrl: 'not-a-url', models: ['m'] }] }), /gateway_provider_baseurl_invalid/);
});
