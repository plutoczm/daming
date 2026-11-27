import { createServer } from 'node:http';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

export interface FakeLuluRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface FakeLulu {
  readonly url: string;
  readonly requests: FakeLuluRequest[];
  close(): Promise<void>;
}

export async function startFakeLulu(
  t: { after(fn: () => Promise<void>): void },
  handler: (request: FakeLuluRequest, response: ServerResponse) => void
): Promise<FakeLulu> {
  const requests: FakeLuluRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const captured: FakeLuluRequest = {
      method: request.method ?? 'GET',
      url: request.url ?? '/',
      headers: request.headers,
      body: Buffer.concat(chunks).toString('utf8')
    };
    requests.push(captured);
    handler(captured, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  t.after(close);
  return { url: `http://127.0.0.1:${address.port}/api`, requests, close };
}
