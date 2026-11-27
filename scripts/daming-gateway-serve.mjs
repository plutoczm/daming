#!/usr/bin/env node
/**
 * Start the Daming gateway from config + PLUGINS.
 * Env:
 *   DAMING_GATEWAY_PROVIDERS  JSON providers (optional)
 *   DAMING_PLUGINS_DIR        directory of drop-in plugins (each plugin.json + index.mjs)
 *   DAMING_GATEWAY_PORT       default 3460
 *   DAMING_GATEWAY_KEY        optional bearer
 * Default (no config/plugins): Ollama(qwen3:8b) + DeepSeek(if DEEPSEEK_API_KEY).
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './load-env.mjs';
import { createGatewayServer, gatewayConfigModels, listen, loadPlugins, parseGatewayConfig, pluginsFromConfig, providerPluginsFromLoaded } from '../services/daming-gateway/src/index.ts';

loadEnv(resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env'));
let plugins;
let models;
const rawCfg = process.env.DAMING_GATEWAY_PROVIDERS_FILE ? readFileSync(process.env.DAMING_GATEWAY_PROVIDERS_FILE, 'utf8') : process.env.DAMING_GATEWAY_PROVIDERS;
if (rawCfg) {
  const cfg = parseGatewayConfig(rawCfg);
  plugins = pluginsFromConfig(cfg, process.env); models = gatewayConfigModels(cfg);
} else {
  plugins = [{ id: 'ollama', models: ['qwen3:8b'], streamBaseUrl: process.env.OLLAMA_BASE ?? 'http://localhost:11434',
    complete: (body) => Promise.resolve().then(async () => { const { openAICompatiblePlugin } = await import('../services/daming-gateway/src/index.ts'); return openAICompatiblePlugin({ id: 'ollama', baseUrl: process.env.OLLAMA_BASE ?? 'http://localhost:11434', models: ['qwen3:8b'] }).complete(body); }) }];
  models = ['qwen3:8b'];
  if (process.env.DEEPSEEK_API_KEY) { const { openAICompatiblePlugin } = await import('../services/daming-gateway/src/index.ts'); plugins.push(openAICompatiblePlugin({ id: 'deepseek', baseUrl: 'https://api.deepseek.com', models: ['deepseek-chat'], headers: { authorization: 'Bearer ' + process.env.DEEPSEEK_API_KEY } })); models.push('deepseek-chat'); }
}
const pdir = process.env.DAMING_PLUGINS_DIR;
if (pdir) {
  const report = await loadPlugins(resolve(pdir));
  for (const e of report.errors) console.error('plugin error:', e.dir, '→', e.error);
  const bridged = providerPluginsFromLoaded(report.loaded);
  plugins.push(...bridged);
  for (const p of bridged) for (const m of p.models) if (!models.includes(m)) models.push(m);
  console.log('plugins loaded:', report.loaded.map((p) => p.manifest.id).join(',') || '(none)');
}
const port = Number(process.env.DAMING_GATEWAY_PORT ?? 3460);
const handle = createGatewayServer({ plugins, models, ...(process.env.DAMING_GATEWAY_KEY ? { apiKey: process.env.DAMING_GATEWAY_KEY } : {}) });
const url = await listen(handle, port);
console.log('daming-gateway on', url, '· models:', models.join(','));
