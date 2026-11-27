/**
 * 出站自动脱敏冒烟（真实网关 + 假上游回显，确定性）：
 *  - 客户端消息里带明文密钥；
 *  - 网关（DAMING_GATEWAY_MASK=1）转发前脱敏 → 上游只能看到 {{SECRET_xxx}} 占位符；
 *  - 上游把收到的内容原样回显，网关再还原 → 客户端拿到明文原文。
 * 运行：node scripts/gateway-mask-smoke.mjs
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const dir = mkdtempSync(join(tmpdir(), 'daming-mask-'));
const upstreamPort = 3494; const gatewayPort = 3495;
const secret = 'sk-ant-' + 'abcdefghijklmnopqrstuvwxyz1234';
let lastReceived = '';

const upstream = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.url && req.url.includes('/v1/chat/completions')) {
      try { const parsed = JSON.parse(body); const msgs = parsed.messages ?? []; lastReceived = String(msgs[msgs.length - 1]?.content ?? ''); }
      catch { lastReceived = ''; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: lastReceived }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    } else if (req.url === '/last') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ received: lastReceived })); }
    else { res.statusCode = 404; res.end('no'); }
  });
});
await new Promise((r) => upstream.listen(upstreamPort, '127.0.0.1', r));

const providersFile = join(dir, 'providers.json');
writeFileSync(providersFile, JSON.stringify({ providers: [{ id: 'echo', api: 'openai-completions', baseUrl: 'http://127.0.0.1:' + upstreamPort, models: ['echo-1'] }] }, null, 2));

const child = spawn(process.execPath, [resolve('scripts/daming-gateway-serve.mjs')], {
  env: { ...process.env, DAMING_GATEWAY_PROVIDERS_FILE: providersFile, DAMING_GATEWAY_PORT: String(gatewayPort), DAMING_GATEWAY_MASK: '1' },
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
});
let ready = false;
child.stdout.on('data', (b) => { if (b.toString().includes('daming-gateway on')) ready = true; });
child.stderr.on('data', (b) => process.stderr.write('[gw-err] ' + b.toString()));
for (let i = 0; i < 60 && !ready; i += 1) await delay(250);

try {
  if (!ready) throw new Error('gateway_not_ready');
  const resp = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'echo-1', messages: [{ role: 'user', content: 'please use key ' + secret + ' now' }] })
  }).then((r) => r.json());
  const clientContent = String(resp?.choices?.[0]?.message?.content ?? '');
  const last = await fetch(`http://127.0.0.1:${upstreamPort}/last`).then((r) => r.json());
  const vendorSaw = String(last.received ?? '');
  console.log('client sees   :', clientContent);
  console.log('vendor saw    :', vendorSaw);
  const clientGotSecret = clientContent.includes(secret);
  const vendorSawPlaceholder = vendorSaw.includes('{{SECRET_') && !vendorSaw.includes(secret);
  if (!clientGotSecret) throw new Error('client_missing_original_secret');
  if (!vendorSawPlaceholder) throw new Error('vendor_not_masked');
  console.log('MASK_OK 厂商看到占位符、客户端收到还原原文');
} finally {
  try { child.kill(); } catch { /* ignore */ }
  await new Promise((r) => upstream.close(r));
}
