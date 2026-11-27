#!/usr/bin/env node
/**
 * Daming check-in daemon — runs ON the school Linux host, detached from any
 * controller session (survives 主控 shutdown; stops only on explicit stop).
 * Plain Node ESM (builtins only), runs on the Linux host's node 20.
 *
 * platform.kind:
 *   "simulated" (default) — benign heartbeat
 *   "http"       — POST {baseUrl}/checkin  (generic fixture/gateway)
 *   "workbuddy"  — real WorkBuddy: POST /v2/billing/meter/checkin-activity-status
 *                  -> /v2/billing/meter/daily-checkin  (Bearer account.token);
 *                  1001 already / 1002 ineligible / 1003 ended / 401 own-app -> needs_human (never bypass)
 */
import { readFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const DIR = dirname(fileURLToPath(import.meta.url));
const once = process.argv.includes('--once');
let cfg;
try { cfg = JSON.parse(readFileSync(join(DIR, 'config.json'), 'utf8')); }
catch (e) { console.error('config.json unreadable:', String(e).slice(0, 120)); process.exit(2); }
const intervalMs = Number.isFinite(cfg.intervalMs) && cfg.intervalMs >= 60000 ? cfg.intervalMs : 3600000;
const reportPath = join(DIR, 'report.jsonl');
const log = (r) => { try { appendFileSync(reportPath, JSON.stringify(r) + '\n'); } catch { /* ignore */ } };

async function httpJson(url, method, headers, body) {
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? httpsRequest : httpRequest;
  const payload = body === undefined ? undefined : Buffer.from(body, 'utf8');
  return await new Promise((resolve, reject) => {
    const req = lib({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method,
      headers: { 'content-type': 'application/json', ...(headers || {}), ...(payload ? { 'content-length': String(payload.length) } : {}) }, timeout: 15000 }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => { let json = {}; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ } resolve({ status: res.statusCode || 0, json }); });
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
function wbHeaders(account) {
  return {
    'content-type': 'application/json', accept: 'application/json',
    authorization: 'Bearer ' + (account.token || account.secret),
    'user-agent': 'WorkBuddy/5.9.3', 'x-user-id': account.uid || '', 'x-domain': account.domain || 'www.workbuddy.cn',
    'x-product': 'SaaS', 'x-ide-type': 'WorkBuddy', 'x-ide-name': 'WorkBuddy', 'x-ide-version': '5.9.3',
    'x-requested-with': 'XMLHttpRequest', 'x-agent-intent': 'craft', 'x-agent-purpose': 'conversation',
  };
}
async function workbuddyQuota(base, account) {
  try {
    const b = String(base || 'https://copilot.tencent.com').replace(/\/+$/, '');
    const r = await httpJson(b + '/billing/meter/get-user-resource-summary', 'POST', wbHeaders(account), '{}');
    const s = (r.json && r.json.data) ? r.json.data : (r.json || {});
    const pk = Array.isArray(s.Packages) ? s.Packages : [];
    let rem = 0; for (const p of pk) { const v = Number(p.CycleRemainCapacity); if (Number.isFinite(v)) rem += v; }
    return pk.length ? Math.round(rem) : undefined;
  } catch { return undefined; }
}
async function workbuddyCheckin(base, account) {
  const b = String(base || 'https://copilot.tencent.com').replace(/\/+$/, '');
  const h = wbHeaders(account);
  const st = await httpJson(b + '/v2/billing/meter/checkin-activity-status', 'POST', h, '{}');
  if (st.status === 401) return { accountId: account.accountId, platform: account.platform, kind: 'needs_human', detail: 'workbuddy_401' };
  if (st.status !== 200) return { accountId: account.accountId, platform: account.platform, kind: 'failed', detail: 'status_' + st.status };
  const s = (st.json && st.json.data && typeof st.json.data === 'object') ? st.json.data : (st.json || {});
  if (s.active === false) return { accountId: account.accountId, platform: account.platform, kind: 'no_event' };
  if (s.today_checked_in === true) return { accountId: account.accountId, platform: account.platform, kind: 'already', credits: s.today_credit };
  const cl = await httpJson(b + '/v2/billing/meter/daily-checkin', 'POST', h, '{}');
  if (cl.status === 401) return { accountId: account.accountId, platform: account.platform, kind: 'needs_human', detail: 'workbuddy_401' };
  const j = cl.json || {};
  const code = j.code ?? (j.data && j.data.code);
  if (cl.status !== 200) {
    if (code === 1001 || code === 10001) return { accountId: account.accountId, platform: account.platform, kind: 'already' };
    if (code === 1002) return { accountId: account.accountId, platform: account.platform, kind: 'failed', detail: 'ineligible' };
    if (code === 1003) return { accountId: account.accountId, platform: account.platform, kind: 'no_event' };
    return { accountId: account.accountId, platform: account.platform, kind: 'failed', detail: String(j.msg || ('claim_' + cl.status)) };
  }
  const d = (j.data && typeof j.data === 'object') ? j.data : j;
  return { accountId: account.accountId, platform: account.platform, kind: 'claimed', credits: d.credit };
}
async function checkinOne(account) {
  if (account.owner && cfg.owner && account.owner !== cfg.owner) return { accountId: account.accountId, platform: account.platform, kind: 'skipped_owner' };
  const kind = (cfg.platform && cfg.platform.kind) || 'simulated';
  if (kind === 'workbuddy') {
    if (!(account.token || account.secret)) return { accountId: account.accountId, platform: account.platform, kind: 'failed', detail: 'no_token' };
    try {
      const base = cfg.platform.baseUrl || 'https://copilot.tencent.com';
      const out = await workbuddyCheckin(base, account);
      const q = await workbuddyQuota(base, account);
      if (q !== undefined) out.quotaRemaining = q;
      return out;
    }
    catch (e) { return { accountId: account.accountId, platform: account.platform, kind: 'failed', error: String(e).slice(0, 100) }; }
  }
  if (kind === 'http' && typeof cfg.platform.baseUrl === 'string') {
    try { const r = await httpJson(String(cfg.platform.baseUrl).replace(/\/+$/, '') + '/checkin', 'POST', {}, JSON.stringify({ accountId: account.accountId, platform: account.platform })); return { accountId: account.accountId, platform: account.platform, kind: String((r.json || {}).kind || 'failed'), credits: (r.json || {}).credits }; }
    catch (e) { return { accountId: account.accountId, platform: account.platform, kind: 'failed', error: String(e).slice(0, 100) }; }
  }
  return { accountId: account.accountId, platform: account.platform, kind: 'claimed', credits: 10, simulated: true };
}

async function tick() {
  const at = new Date().toISOString();
  const results = [];
  for (const account of cfg.accounts || []) results.push(await checkinOne(account));
  log({ at, owner: cfg.owner || null, results });
  console.log('tick', at, 'accounts=' + results.length);
}
if (once) { await tick(); process.exit(0); }
console.log('daming-checkin daemon start pid=' + process.pid + ' intervalMs=' + intervalMs);
await tick();
const timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
const stop = (sig) => { clearInterval(timer); log({ at: new Date().toISOString(), event: 'stop', signal: sig }); console.log('daming-checkin daemon stop', sig); process.exit(0); };
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
