import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export type CodexModelForward = (body: string, signal: AbortSignal) => Promise<Response>;
export interface CodexModelConnection {
  readonly model: string;
  readonly baseUrl: string;
  /** Per-run relay credential, never a provider or Magpie admin key. */
  readonly token: string;
  /** Aborted only on upstream failure, so the owner can stop a waiting CLI. */
  readonly signal: AbortSignal;
  close(): Promise<void>;
}
const issued = new WeakSet<object>();
export function isCodexModelConnection(value: unknown): value is CodexModelConnection {
  return typeof value === 'object' && value !== null && issued.has(value);
}

/** Host supplies the only upstream capability. No arbitrary proxy URL is accepted. */
export async function createCodexModelConnection(model: string, forward: CodexModelForward): Promise<CodexModelConnection> {
  if (typeof model !== 'string' || !/^[a-z0-9][a-z0-9._:/-]{0,159}$/i.test(model) ||
      model.includes('..') || model.includes('://') || typeof forward !== 'function') {
    throw new Error('codex_model_connection_invalid');
  }
  const token = randomBytes(32).toString('base64url');
  const expected = Buffer.from('Bearer ' + token);
  const abort = new AbortController();
  const failure = new AbortController();
  let consumed = false;
  let closed = false;
  let port = 0;
  const server = createServer(async (req, res) => {
    const fail = (code: number, message: string) => {
      if (!res.headersSent) { res.writeHead(code, { 'Content-Type': 'application/json', Connection: 'close' }); res.end(JSON.stringify({ error: { message } })); }
      else res.destroy();
    };
    const auth = Buffer.from(String(req.headers.authorization ?? ''));
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return fail(401, 'relay_unauthorized');
    if (req.headers.origin || req.headers.host !== '127.0.0.1:' + port) return fail(403, 'relay_origin_or_host_denied');
    if (req.method !== 'POST' || req.url !== '/v1/responses') return fail(404, 'relay_endpoint_denied');
    if (closed || consumed) return fail(409, 'relay_request_already_consumed');
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') return fail(400, 'relay_encoding_denied');
    let bytes = 0;
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 256 * 1024) return fail(413, 'relay_request_too_large');
        chunks.push(chunk);
      }
      const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) return fail(400, 'relay_request_invalid');
      const body = data as Record<string, unknown>;
      if (body.model !== model || body.stream !== true) return fail(400, 'relay_fixed_model_required');
      // Set only after validation, synchronously before awaiting the first send.
      // Never reset, including failures, disconnects and retries by the client.
      if (closed || consumed) return fail(409, 'relay_request_already_consumed');
      consumed = true;
      const disconnected = () => { if (!res.writableFinished) abort.abort(); };
      res.once('close', disconnected);
      try {
        // First integration is one text turn. Provider output cannot authorize a
        // second model request, even when it asks Codex for a tool round.
        const response = await forward(JSON.stringify({ ...body, tools: [], tool_choice: 'none', parallel_tool_calls: false }), abort.signal);
        if (abort.signal.aborted) return fail(502, 'relay_upstream_cancelled');
        if (response.status !== 200 || !/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) {
          await response.body?.cancel();
          failure.abort();
          return fail(502, 'relay_upstream_unusable');
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
        const source = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
        source.once('error', () => { if (!abort.signal.aborted) failure.abort(); });
        await pipeline(source, res);
      } catch {
        // Codex disconnects as soon as it reads response.completed, sometimes
        // before the HTTP stream closes. That is not an upstream failure.
        if (!abort.signal.aborted) failure.abort();
        fail(502, 'relay_upstream_failed');
      }
      finally { res.removeListener('close', disconnected); }
    } catch { fail(400, 'relay_request_invalid'); }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('codex_relay_listener_missing');
  port = address.port;
  const connection: CodexModelConnection = Object.freeze({
    model, baseUrl: 'http://127.0.0.1:' + port + '/v1', token, signal: failure.signal,
    async close() {
      if (closed) return;
      closed = true;
      abort.abort();
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    }
  });
  issued.add(connection);
  return connection;
}
