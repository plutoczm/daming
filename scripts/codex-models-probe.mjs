import { readFileSync } from 'node:fs';
import { request, Agent } from 'node:https';
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
function proxyAgent(host, port) {
  return new Agent({ createConnection(options, cb) {
    const s = netConnect(port, host);
    s.once('connect', () => { s.write(`CONNECT ${options.host}:${options.port} HTTP/1.1\r\nHost: ${options.host}:${options.port}\r\n\r\n`); const on = (d) => { const t = d.toString('latin1'); if (t.includes('\r\n\r\n')) { s.removeListener('data', on); if (/^HTTP\/1\.[01] 200/.test(t)) { const tl = tlsConnect({ socket: s, servername: options.host }); tl.once('secureConnect', () => cb(null, tl)); tl.once('error', cb); } else cb(new Error('proxy ' + t.slice(0, 40))); } }; s.on('data', on); });
    s.once('error', cb);
  } });
}
const j = JSON.parse(readFileSync(process.env.USERPROFILE + '/.config/magpie/logins.json', 'utf8'));
const cx = (j || []).find((r) => r.agent === 'codex');
const tok = cx?.auth?.tokens?.access_token; const acct = cx?.auth?.tokens?.account_id;
const h = { authorization: 'Bearer ' + tok, 'chatgpt-account-id': acct, originator: 'codex_cli_rs', version: '0.169.0', 'user-agent': 'codex_cli_rs/0.169.0 (Windows) WindowsTerminal', accept: 'application/json' };
const req = request({ hostname: 'chatgpt.com', port: 443, path: '/backend-api/codex/models?client_version=0.169.0', method: 'GET', headers: h, agent: proxyAgent('127.0.0.1', 7890), timeout: 30000 }, (r) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => { const b = Buffer.concat(c).toString('utf8'); console.log('STATUS', r.statusCode); try { const jj = JSON.parse(b); const ids = (jj.models || jj.data || []).map((m) => m.id || m.slug || m); console.log('MODELS', JSON.stringify(ids)); } catch { console.log('BODY', b.slice(0, 500)); } }); });
req.on('error', (e) => console.log('ERR', String(e).slice(0, 160))); req.on('timeout', () => { req.destroy(); console.log('TIMEOUT'); }); req.end();
