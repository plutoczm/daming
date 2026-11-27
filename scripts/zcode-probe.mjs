// Probe ZCode (GLM coding plan) Anthropic-compatible relay with the real account.
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
const pa = JSON.parse(readFileSync(process.env.USERPROFILE + '/.config/magpie/plugin-auth.json', 'utf8'));
const z = pa['zcode'] || {};
console.log('ZCODE_KEYS', Object.keys(z), 'type', z.type, 'tokenType', z.tokenType);
const keys = [z.access, z.token, z.key, z.jwt].filter((x) => typeof x === 'string' && x);
function post(base, path, headers, body) {
  const u = new URL(base + path); const p = Buffer.from(body, 'utf8');
  return new Promise((res) => {
    const r = request({ hostname: u.hostname, port: 443, path: u.pathname, method: 'POST', headers: { ...headers, 'content-length': String(p.length) }, timeout: 30000 }, (x) => { const c = []; x.on('data', (d) => c.push(d)); x.on('end', () => res({ status: x.statusCode, body: Buffer.concat(c).toString('utf8').slice(0, 300) })); });
    r.on('error', (e) => res({ status: -1, body: String(e) })); r.on('timeout', () => { r.destroy(); res({ status: -2, body: 'timeout' }); }); r.end(p);
  });
}
const bases = ['https://api.z.ai/api/anthropic', 'https://open.bigmodel.cn/api/anthropic'];
const models = ['glm-5.3', 'glm-4.6', 'glm-5'];
for (const base of bases) for (const key of keys) for (const model of models) {
  const h = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', authorization: 'Bearer ' + key };
  const body = JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: '请只回复 OK' }] });
  const r = await post(base, '/v1/messages', h, body);
  console.log(base, 'key=' + key.slice(0, 8) + '…', model, '->', r.status, r.status !== 200 ? r.body.replace(/\n/g, ' ').slice(0, 120) : 'OK(' + r.body.slice(0, 60) + ')');
  if (r.status === 200) { console.log('SUCCESS_BASE', base, 'KEY_LEN', key.length); process.exit(0); }
}
