#!/usr/bin/env node
/** Daming provider manager — add/list any compatible provider by config (no core change).
 *  usage:
 *    daming-provider list [file]
 *    daming-provider add <id> --api openai-completions|openai-responses|anthropic-messages \
 *        --base <url> --models a,b[,c] [--key-env ENV] [--key-header authorization|x-api-key] [--file FILE]
 *  File default: config/providers.json (created on first add).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
const cmd = args[0];
function opt(name, def) { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; }
const file = resolve(opt('--file', (cmd === 'list' && args[1] && !args[1].startsWith('--')) ? args[1] : 'config/providers.json'));
function load() { if (existsSync(file)) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { /* ignore */ } } return { providers: [] }; }
function save(cfg) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n'); }

if (cmd === 'list') {
  const cfg = load();
  console.log(`providers in ${file}: (${cfg.providers?.length || 0})`);
  for (const p of cfg.providers || []) console.log('  ' + String(p.id).padEnd(12), String(p.api || 'openai-completions').padEnd(20), p.baseUrl, 'models=' + (p.models || []).join(','), p.apiKeyEnv ? 'keyEnv=' + p.apiKeyEnv : '');
} else if (cmd === 'add') {
  const id = args[1];
  if (!id) { console.error('missing id'); process.exit(1); }
  const api = opt('--api', 'openai-completions');
  if (!['openai-completions', 'openai-responses', 'anthropic-messages'].includes(api)) { console.error('bad --api'); process.exit(1); }
  const baseUrl = opt('--base'); const models = (opt('--models', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!baseUrl || !models.length) { console.error('need --base and --models'); process.exit(1); }
  const cfg = load(); cfg.providers = cfg.providers || [];
  const entry = { id, api, baseUrl, models, ...(opt('--key-env') ? { apiKeyEnv: opt('--key-env') } : {}), ...(opt('--key-header') ? { apiKeyHeader: opt('--key-header') } : {}) };
  const idx = cfg.providers.findIndex((p) => p.id === id);
  if (idx >= 0) cfg.providers[idx] = entry; else cfg.providers.push(entry);
  save(cfg);
  console.log((idx >= 0 ? 'updated' : 'added') + ' provider', id, '→', file);
} else {
  console.log('usage: daming-provider list [file] | add <id> --api <api> --base <url> --models a,b [--key-env ENV] [--key-header authorization|x-api-key] [--file FILE]');
}
