import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { randomBytes } from 'node:crypto';

/** Daming-owned Codex WebSocket relay (ported from Magpie codexrelay/codex_socket). */
export interface CodexUsage { prompt_tokens: number; completion_tokens: number }
export interface CodexTurnResult { text: string; usage: CodexUsage; error?: string }
export interface CodexWsOptions {
  model: string; prompt: string; token: string; accountId?: string;
  proxyHost?: string; proxyPort?: number; host?: string; path?: string;
  beta?: string; version?: string; timeoutMs?: number;
}

/** One client text frame (FIN + text opcode + mask, per RFC 6455). */
export function encodeTextFrame(text: string): Buffer {
  const p = Buffer.from(text, 'utf8'); const len = p.length; let h: Buffer;
  if (len < 126) h = Buffer.from([0x81, 0x80 | len]);
  else if (len < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(len, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 0x80 | 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(len, 6); }
  const m = randomBytes(4); const x = Buffer.alloc(len);
  for (let i = 0; i < len; i++) x[i] = p[i] ^ m[i & 3];
  return Buffer.concat([h, m, x]);
}
export interface WsFrame { opcode: number; payload: Buffer }
/** Parse as many complete frames as possible; leftovers returned as `rest`. Handles masked + 126/127 lengths + ping/pong/close/text/binary. */
export function parseFrames(buf: Buffer): { frames: WsFrame[]; rest: Buffer } {
  const frames: WsFrame[] = [];
  for (;;) {
    if (buf.length < 2) break;
    const b1 = buf[1]; const opcode = buf[0] & 0x0f; let len = b1 & 0x7f; let off = 2; const masked = (b1 & 0x80) !== 0;
    if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    let mask: Buffer | null = null;
    if (masked) { if (buf.length < off + 4) break; mask = Buffer.from(buf.subarray(off, off + 4)); off += 4; }
    if (buf.length < off + len) break;
    let payload = Buffer.from(buf.subarray(off, off + len)); buf = buf.subarray(off + len);
    if (mask) { const u = Buffer.alloc(len); for (let i = 0; i < len; i++) u[i] = payload[i] ^ mask[i & 3]; payload = u; }
    frames.push({ opcode, payload });
  }
  return { frames, rest: buf };
}

export function codexWsTurn(o: CodexWsOptions): Promise<CodexTurnResult> {
  const proxyHost = o.proxyHost ?? '127.0.0.1'; const proxyPort = o.proxyPort ?? 7890;
  const host = o.host ?? 'chatgpt.com'; const path = o.path ?? '/backend-api/codex/responses';
  const beta = o.beta ?? 'responses_websockets=2026-02-06'; const version = o.version ?? '0.169.0';
  const timeoutMs = o.timeoutMs ?? 90000;
  return new Promise((resolve) => {
    let text = ''; let usage: CodexUsage = { prompt_tokens: 0, completion_tokens: 0 }; let done = false;
    let tls: ReturnType<typeof tlsConnect> | undefined;
    const finish = (error?: string) => { if (done) return; done = true; clearTimeout(to); try { tls?.destroy(); } catch { /* ignore */ } resolve({ text, usage, ...(error ? { error } : {}) }); };
    const raw = netConnect(proxyPort, proxyHost);
    const to = setTimeout(() => finish('timeout'), timeoutMs);
    raw.once('error', (e) => finish('proxy:' + String(e).slice(0, 80)));
    raw.once('connect', () => {
      raw.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
      raw.once('data', (d) => {
        if (!/^HTTP\/1\.[01] 200/.test(d.toString('latin1'))) return finish('connect_refused');
        tls = tlsConnect({ socket: raw, servername: host });
        tls.once('error', (e) => finish('tls:' + String(e).slice(0, 80)));
        tls.once('secureConnect', () => {
          const key = randomBytes(16).toString('base64');
          tls!.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer ${o.token}\r\n${o.accountId ? 'chatgpt-account-id: ' + o.accountId + '\r\n' : ''}originator: codex_cli_rs\r\nversion: ${version}\r\nuser-agent: codex_cli_rs/${version} (Windows) WindowsTerminal\r\nopenai-beta: ${beta}\r\n\r\n`);
          let buf: Buffer = Buffer.alloc(0); let up = false;
          tls!.on('data', (chunk) => {
            buf = Buffer.concat([buf, chunk]);
            if (!up) {
              const i = buf.indexOf('\r\n\r\n'); if (i < 0) return;
              const head = buf.subarray(0, i).toString('latin1'); if (!/ 101 /.test(head)) return finish('handshake:' + head.split('\r\n')[0]);
              buf = buf.subarray(i + 4); up = true;
              const body = { type: 'response.create', model: o.model, instructions: '', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: o.prompt }] }], stream: true, store: false, tool_choice: 'none', parallel_tool_calls: false, text: { verbosity: 'medium' } };
              tls!.write(encodeTextFrame(JSON.stringify(body)));
            }
            const { frames, rest } = parseFrames(buf); buf = rest;
            for (const f of frames) {
              if (f.opcode === 0x9) { tls!.write(encodeTextFrame('')); continue; } // pong (client frames are masked; empty pong acceptable fallback)
              if (f.opcode === 0x8) return finish(text ? undefined : 'closed');
              if (f.opcode !== 0x1) continue;
              try {
                const jj = JSON.parse(f.payload.toString('utf8').trim()); const t = jj.type;
                if (t === 'response.output_text.delta' && typeof jj.delta === 'string') text += jj.delta;
                if (t === 'response.completed' && jj.response?.usage) usage = { prompt_tokens: jj.response.usage.input_tokens || 0, completion_tokens: jj.response.usage.output_tokens || 0 };
                if (t === 'response.completed' || t === 'response.incomplete') return finish();
                if (t === 'response.failed' || t === 'error') return finish(t + ':' + JSON.stringify(jj).slice(0, 160));
              } catch { /* ignore non-JSON */ }
            }
          });
        });
      });
    });
  });
}
