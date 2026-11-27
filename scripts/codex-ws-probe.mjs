// Manual WebSocket client over an HTTP CONNECT proxy → chatgpt codex responses.
// Proves the codexrelay protocol can be ported to Daming with zero deps.
import { readFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { randomBytes } from 'node:crypto';

const PROXY = { host: '127.0.0.1', port: 7890 };
const HOST = 'chatgpt.com';
const PATH = '/backend-api/codex/responses';
const j = JSON.parse(readFileSync(process.env.USERPROFILE + '/.config/magpie/logins.json', 'utf8'));
const cx = (j || []).find((r) => r.agent === 'codex');
const TOKEN = cx?.auth?.tokens?.access_token; const ACCT = cx?.auth?.tokens?.account_id;

function wsFrame(text) {
  const payload = Buffer.from(text, 'utf8'); const len = payload.length; let header;
  if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
  const mask = randomBytes(4); const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}
function pongFrame(payload) {
  const mask = randomBytes(4); const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([Buffer.from([0x8a, 0x80 | payload.length]), mask, masked]);
}

const model = process.argv[2] || 'gpt-6.2-sol';
const prompt = process.argv[3] || '请只回复 OK';
const key = randomBytes(16).toString('base64');

const raw = netConnect(PROXY.port, PROXY.host);
raw.once('connect', () => {
  raw.write(`CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\n\r\n`);
  raw.once('data', (d) => {
    if (!/^HTTP\/1\.[01] 200/.test(d.toString('latin1'))) { console.log('CONNECT_FAIL', d.toString('latin1').slice(0, 80)); process.exit(1); }
    const tls = tlsConnect({ socket: raw, servername: HOST });
    tls.once('secureConnect', () => {
      const req = `GET ${PATH} HTTP/1.1\r\nHost: ${HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer ${TOKEN}\r\nchatgpt-account-id: ${ACCT}\r\noriginator: codex_cli_rs\r\nversion: 0.169.0\r\nuser-agent: codex_cli_rs/0.169.0 (Windows) WindowsTerminal\r\nopenai-beta: responses_websockets=2026-02-06\r\n\r\n`;
      tls.write(req);
      let buf = Buffer.alloc(0); let upgraded = false; const t0 = Date.now();
      tls.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (!upgraded) {
          const i = buf.indexOf('\r\n\r\n');
          if (i < 0) return;
          const head = buf.slice(0, i).toString('latin1');
          console.log('HANDSHAKE', head.split('\r\n')[0]);
          buf = buf.slice(i + 4); upgraded = true;
          const body = { type: 'response.create', model, instructions: '', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }], stream: true, store: false, tool_choice: 'none', parallel_tool_calls: false, text: { verbosity: 'medium' } };
          tls.write(wsFrame(JSON.stringify(body)));
        }
        // parse frames
        for (;;) {
          if (buf.length < 2) break;
          const b0 = buf[0], b1 = buf[1]; const opcode = b0 & 0x0f; let len = b1 & 0x7f; let off = 2; const masked = (b1 & 0x80) !== 0;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          let mask = null; if (masked) { if (buf.length < off + 4) return; mask = buf.slice(off, off + 4); off += 4; }
          if (buf.length < off + len) return;
          let payload = buf.slice(off, off + len); buf = buf.slice(off + len);
          if (masked) { const u = Buffer.alloc(len); for (let i = 0; i < len; i++) u[i] = payload[i] ^ mask[i & 3]; payload = u; }
          if (opcode === 0x9) { tls.write(pongFrame(payload)); continue; }
          if (opcode === 0x8) { console.log('CLOSE'); try { tls.end(); } catch {} return; }
          if (opcode !== 0x1) continue;
          const s = payload.toString('utf8').trim();
          try {
            const jj = JSON.parse(s); const t = jj.type;
            if (t === 'response.output_text.delta' && typeof jj.delta === 'string') process.stdout.write(jj.delta);
            console.log(`[${t}] ${t === 'response.completed' || t === 'response.failed' || t === 'error' ? s.slice(0, 300) : ''}`);
            if (t === 'response.completed' || t === 'response.failed' || t === 'response.incomplete' || t === 'error') { console.log('\nDONE in ' + (Date.now() - t0) + 'ms'); try { tls.end(); } catch {} return; }
          } catch { console.log('FRAME', s.slice(0, 160)); }
        }
      });
      tls.on('error', (e) => console.log('TLS_ERR', String(e).slice(0, 120)));
    });
    tls.once('error', (e) => console.log('TLSERR', String(e)));
  });
});
raw.on('error', (e) => console.log('PROXY_ERR', String(e).slice(0, 120)));
setTimeout(() => { console.log('\nTIMEOUT'); process.exit(2); }, 60000);
