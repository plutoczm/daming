/** S13 突破验证: Daming 自持 WorkBuddy 订阅账号 —— 额度只读 + 聊天(经 Daming 网关插件)。 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createGatewayServer, listen } from '../services/daming-gateway/src/index.ts';
import { WorkBuddyPlatform, workBuddyChatPlugin } from '../services/checkin-agent/src/index.ts';

const j = JSON.parse(readFileSync(process.env.USERPROFILE + '\\.config\\magpie\\plugin-auth.json', 'utf8'));
const rec = j['workbuddy'];
const account = { access: rec.access, uid: rec.uid, domain: rec.domain };
const cred = { accountId: 'workbuddy', platform: 'workbuddy', owner: 'windows', secret: JSON.stringify(rec) };
const proof = { stage: 'S13', module: 'Daming self-own WorkBuddy subscription (quota + chat)', observedAt: new Date().toISOString(), ok: false };
const h = createGatewayServer({ models: ['deepseek-v4.1-flash'], defaultModel: 'deepseek-v4.1-flash', plugins: [workBuddyChatPlugin({ account, models: ['deepseek-v4.1-flash'] })] });
try {
  // 1) quota + status (read-only) via Daming platform
  const p = new WorkBuddyPlatform();
  proof.status = await p.status(cred);
  proof.quota = await p.readQuota(cred);
  proof.quotaOk = typeof proof.quota.remainingMinor === 'number' && proof.quota.remainingMinor >= 0;
  // 2) chat via Daming gateway + WorkBuddy plugin (real model turn)
  const base = await listen(h, 0);
  const chat = await (await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'Reply with exactly: OK. Do not explain.' }], max_tokens: 256 }) })).json();
  proof.chatContent = chat?.choices?.[0]?.message?.content;
  proof.chatUsage = chat?.usage;
  const okChat = String(proof.chatContent ?? '').trim().toUpperCase().includes('OK');
  proof.ok = proof.quotaOk && okChat;
  if (!proof.ok) process.exitCode = 1;
} catch (e) { proof.error = e instanceof Error ? e.message.slice(0, 240) : String(e); process.exitCode = 1; }
finally {
  try { await h.close(); } catch {}
  mkdirSync(resolve('docs/verification'), { recursive: true }); mkdirSync(resolve('.cache/verification'), { recursive: true });
  const out = JSON.stringify(proof, null, 2) + '\n';
  writeFileSync(resolve('docs/verification/s13-m2-wb-selfsupply-2026-11-20.json'), out);
  writeFileSync(resolve('.cache/verification/s13-m2-wb-selfsupply.json'), out);
  console.log(out);
}
