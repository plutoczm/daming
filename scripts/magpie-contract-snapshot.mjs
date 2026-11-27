#!/usr/bin/env node
// Magpie 契约快照 / 一致性基线工具（Route B 专属精简 fork 用）
// 起一个受控临时实例（已知 MAGPIE_WEB_KEY / 端口），抓取 Daming 实际依赖的只读端点，
// 保存 JSON+sha256 作为 golden。后续裁剪重编的 exe 用同一脚本抓快照，再由 parity 脚本对拍。
//
// 用法:
//   node scripts/magpie-contract-snapshot.mjs --exe <path-to-exe> --out <dir> [--label old|new]
// 产出:
//   <out>/golden.json          契约快照
//   <out>/raw/<alias>.json     每个端点原始响应体（便于人工比对）
//
// 只抓 GET 只读端点 + 2 个无副作用 POST（plugin-check / 空参）。不碰线上实例、不改数据。

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return def;
}
const EXE = resolve(arg('exe', 'runtime/magpie/windows-x64/daming-magpie-codex-subscription-v2.exe'));
const OUT = resolve(arg('out', '.tmp/magpie-golden'));
const LABEL = arg('label', 'old');
const GATEWAY_PORT = Number(arg('port', '3557'));
const ADMIN_PORT = Number(arg('admin', '3558'));

// Daming 实际依赖的只读 GET 端点（见 apps/server/src/magpie-host.ts READ_ALIASES）
const GET_ENDPOINTS = [
  { alias: 'hello', plane: 'gateway', path: '/api/hello' },
  { alias: 'models', plane: 'gateway', path: '/v1/models' },
  { alias: 'usage', plane: 'gateway', path: '/v1/magpie/usage' },
  { alias: 'quota-cards', plane: 'gateway', path: '/v1/magpie/quotas/cards' },
  { alias: 'task-scope', plane: 'gateway', path: '/v1/magpie/daming-task-scope' },
  { alias: 'providers', plane: 'admin', path: '/api/providers' },
  { alias: 'groups', plane: 'admin', path: '/api/groups' },
  { alias: 'agents', plane: 'admin', path: '/api/agents/cli' },
  { alias: 'quotas', plane: 'admin', path: '/api/usage/quotas' },
  { alias: 'caller-keys-models', plane: 'admin', path: '/api/caller-keys/models' },
  { alias: 'plugins', plane: 'admin', path: '/api/plugins' },
  { alias: 'plugin-updates', plane: 'admin', path: '/api/plugins/updates' }
];
// 无副作用 POST（空参）
const POST_ENDPOINTS = [
  { alias: 'plugin-check', plane: 'admin', path: '/api/plugins/check' }
];

const KEY = randomBytes(24).toString('base64url');
const INSTANCE = randomBytes(16).toString('hex');
const COOKIE = 'magpie_web_' + ADMIN_PORT + '=' + KEY;

const dirs = {
  base: join(OUT, 'scratch-' + LABEL),
  config: join(OUT, 'scratch-' + LABEL, 'config'),
  cache: join(OUT, 'scratch-' + LABEL, 'cache'),
  state: join(OUT, 'scratch-' + LABEL, 'state'),
  local: join(OUT, 'scratch-' + LABEL, 'local'),
  appdata: join(OUT, 'scratch-' + LABEL, 'appdata')
};

function envFor() {
  const env = {};
  for (const n of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'PATH', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']) {
    if (process.env[n] !== undefined) env[n] = process.env[n];
  }
  return {
    ...env,
    MAGPIE_ADDR: '127.0.0.1:' + GATEWAY_PORT,
    MAGPIE_WEB_KEY: KEY,
    DAMING_MAGPIE_INSTANCE: INSTANCE,
    DAMING_CODEX_READONLY_AUTH: '1',
    XDG_CONFIG_HOME: dirs.config,
    XDG_CACHE_HOME: dirs.cache,
    XDG_STATE_HOME: dirs.state,
    XDG_DATA_HOME: join(dirs.state, 'data'),
    XDG_RUNTIME_DIR: join(dirs.state, 'runtime'),
    LOCALAPPDATA: dirs.local,
    APPDATA: dirs.appdata
  };
}

function req(method, plane, path) {
  const port = plane === 'gateway' ? GATEWAY_PORT : ADMIN_PORT;
  const headers = { Accept: 'application/json', Cookie: COOKIE };
  let payload = undefined;
  if (method === 'POST') { payload = '{}'; headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
  return new Promise((resolveResult) => {
    const r = httpRequest({ hostname: '127.0.0.1', port, path, method, headers }, res => {
      const chunks = []; let bytes = 0; let tooBig = false;
      res.on('data', c => { bytes += c.length; if (bytes > 2 * 1024 * 1024) { tooBig = true; r.destroy(); } else chunks.push(c); });
      res.on('end', () => resolveResult({ status: res.statusCode ?? 0, tooBig, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => resolveResult({ status: res.statusCode ?? 0, text: '', error: 'stream_error' }));
    });
    r.on('error', e => resolveResult({ status: 0, text: '', error: e.code || 'req_error' }));
    r.setTimeout(15000, () => { r.destroy(); resolveResult({ status: 0, text: '', error: 'timeout' }); });
    if (payload) r.write(payload);
    r.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function ready() {
  for (let i = 0; i < 60; i++) {
    const h = await req('GET', 'gateway', '/api/hello');
    let name = null;
    try { name = JSON.parse(h.text)?.name; } catch {}
    if (h.status === 200 && name === 'magpie') {
      const g = await req('GET', 'admin', '/api/groups');
      if (g.status === 200) return true;
    }
    await sleep(300);
  }
  return false;
}

function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}
// 结构骨架（深度受限）：depth 2 = 顶层键 + 一层子类型；数组元素折叠为粗类型，
// 避开供应商目录/账号派生字段的乱序与时序抖动，只判"契约表面"是否兼容。
function typeToken(v) {
  if (v === null) return 'n';
  if (Array.isArray(v)) return 'array';
  switch (typeof v) { case 'boolean': return 'b'; case 'number': return 'num'; case 'string': return 's'; case 'object': return 'object'; default: return '?'; }
}
function shape(v, depth) {
  if (depth <= 0) return typeToken(v);
  if (v === null) return 'n';
  if (Array.isArray(v)) {
    if (depth <= 1) return '[' + new Set(v.map(typeToken)).size + ']';
    const s = new Set(v.map(e => shape(e, depth - 1)));
    return '[' + [...s].sort().join('|') + ']';
  }
  switch (typeof v) {
    case 'boolean': return 'b';
    case 'number': return 'num';
    case 'string': return 's';
    case 'object': return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + shape(v[k], depth - 1)).join(',') + '}';
    default: return '?';
  }
}

async function main() {
  for (const d of [dirs.base, dirs.config, dirs.cache, dirs.state, dirs.local, dirs.appdata]) mkdirSync(d, { recursive: true });
  mkdirSync(join(OUT, 'raw'), { recursive: true });
  const logPath = join(OUT, 'magpie-' + LABEL + '.log');
  const out = openSync(logPath, 'a');
  const startedAt = Date.now();
  const child = spawn(EXE, ['serve', '--web=127.0.0.1:' + ADMIN_PORT], {
    cwd: dirs.base, env: envFor(), shell: false, windowsHide: true, stdio: ['ignore', out, out]
  });
  let childErr = null;
  child.once('error', e => { childErr = e; });
  const ok = await ready();
  const snapshot = {
    label: LABEL, exe: EXE, gatewayPort: GATEWAY_PORT, adminPort: ADMIN_PORT,
    capturedAt: new Date().toISOString(), bootMs: Date.now() - startedAt, ready: ok,
    childError: childErr ? String(childErr) : null, endpoints: {}
  };
  if (ok) {
    for (const ep of GET_ENDPOINTS) {
      const r = await req('GET', ep.plane, ep.path);
      const body = r.text;
      let json = null; try { json = JSON.parse(body); } catch {}
      snapshot.endpoints[ep.alias] = {
        plane: ep.plane, path: ep.path, method: 'GET', status: r.status,
        bytes: Buffer.byteLength(body), sha256: sha256(Buffer.from(body)),
        stableSha256: json !== null ? sha256(Buffer.from(stable(json))) : null,
        shapeSha256: json !== null ? sha256(Buffer.from(shape(json, 2))) : null,
        error: r.error ?? null
      };
      writeFileSync(join(OUT, 'raw', ep.alias + '.json'), body + '\n');
    }
    for (const ep of POST_ENDPOINTS) {
      const r = await req('POST', ep.plane, ep.path);
      const body = r.text;
      let json = null; try { json = JSON.parse(body); } catch {}
      snapshot.endpoints[ep.alias] = {
        plane: ep.plane, path: ep.path, method: 'POST', status: r.status,
        bytes: Buffer.byteLength(body), sha256: sha256(Buffer.from(body)),
        stableSha256: json !== null ? sha256(Buffer.from(stable(json))) : null,
        shapeSha256: json !== null ? sha256(Buffer.from(shape(json, 2))) : null,
        error: r.error ?? null
      };
      writeFileSync(join(OUT, 'raw', ep.alias + '.json'), body + '\n');
    }
  }
  try { child.kill(); } catch {}
  closeSync(out);
  writeFileSync(join(OUT, 'golden.json'), JSON.stringify(snapshot, null, 2) + '\n');
  console.log(JSON.stringify({ ok, label: LABEL, bootMs: snapshot.bootMs, endpoints: Object.fromEntries(Object.entries(snapshot.endpoints).map(([k, v]) => [k, v.status + '/' + v.bytes + 'b'])) }, null, 2));
  process.exit(ok ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(2); });
