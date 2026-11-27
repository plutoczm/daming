/**
 * 数据面冒烟（真实本地、确定性）：假上游 + 真实 daming-gateway-serve + 我们的 providers.json。
 * 验证：providers.json 里配置的供应商，经网关 `/<base>/v1/chat/completions` 真正转发到上游并返回内容。
 * 运行：node scripts/gateway-dataplane-smoke.mjs
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const dir = mkdtempSync(join(tmpdir(), 'daming-dataplane-'));
const upstreamPort = 3491;
const gatewayPort = 3492;

// 1) 假上游（OpenAI 兼容）
const upstream = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.url && req.url.includes('/v1/chat/completions')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'PONG' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 } }));
    } else { res.statusCode = 404; res.end('no'); }
  });
});
await new Promise((r) => upstream.listen(upstreamPort, '127.0.0.1', r));

// 2) providers.json（我们平台写的格式）
const providersFile = join(dir, 'providers.json');
writeFileSync(providersFile, JSON.stringify({ defaultModel: 'fake-1', providers: [{ id: 'fake', api: 'openai-completions', baseUrl: 'http://127.0.0.1:' + upstreamPort, models: ['fake-1'] }] }, null, 2));

// 3) 起真实网关（DAMING_GATEWAY_PROVIDERS_FILE 指向 providers.json）
const child = spawn(process.execPath, [resolve('scripts/daming-gateway-serve.mjs')], {
  env: { ...process.env, DAMING_GATEWAY_PROVIDERS_FILE: providersFile, DAMING_GATEWAY_PORT: String(gatewayPort) },
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
});
let ready = false;
child.stdout.on('data', (b) => { const s = b.toString(); if (s.includes('daming-gateway on')) { ready = true; process.stdout.write('[gateway] ' + s); } });
child.stderr.on('data', (b) => process.stderr.write('[gw-err] ' + b.toString()));
for (let i = 0; i < 60 && !ready; i += 1) await delay(250);

try {
  if (!ready) throw new Error('gateway_not_ready');
  const models = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`).then((r) => r.json());
  console.log('models:', JSON.stringify(models));
  const chat = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fake-1', messages: [{ role: 'user', content: 'ping' }] })
  }).then((r) => r.json());
  const content = chat?.choices?.[0]?.message?.content;
  console.log('chat content:', content);
  if (content !== 'PONG') throw new Error('dataplane_failed:' + JSON.stringify(chat));
  console.log('DATAPLANE_OK providers.json → gateway → upstream → ' + content);
} finally {
  try { child.kill(); } catch { /* ignore */ }
  await new Promise((r) => upstream.close(r));
}
