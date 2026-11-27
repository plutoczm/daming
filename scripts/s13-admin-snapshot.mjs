import { writeFileSync } from 'node:fs';
import { createGatewayServer, listen } from '../services/daming-gateway/src/index.ts';
const h = createGatewayServer({ models: ['qwen3:8b', 'deepseek-chat', 'gpt-6.2-sol'], pluginsDir: process.cwd() + '/examples/plugins' });
const base = await listen(h, 0);
const html = await (await fetch(base + '/admin')).text();
writeFileSync('docs/verification/admin-sample-2026-11-20.html', html);
console.log('wrote admin sample', html.length, 'bytes; accounts section:', /Accounts \(\d+\)/.exec(html)?.[0], '| plugins:', /Plugins \(\d+\)/.exec(html)?.[0]);
await h.close();
