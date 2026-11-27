/**
 * 组合卡交互验收（P0.7，真实飞书）。发一张组合卡给本人，等你点「批准/驳回/稍后」并记录。
 * 需要 .env: FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_OWNER_OPEN_ID。
 * 运行：node scripts/feishu-portfolio-acceptance.mjs
 * 影响：仅记录一次决策到隔离目录，不改任何项目/资金；无模型请求、无现金。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PortfolioDecisionStore } from '../apps/server/src/portfolio-decisions.ts';
import { createPortfolioFeishuClient } from '../apps/server/src/feishu-long-connection.ts';
import { loadEnv } from './load-env.mjs';

loadEnv();
const { FEISHU_APP_ID: appId, FEISHU_APP_SECRET: appSecret, FEISHU_OWNER_OPEN_ID: ownerOpenId } = process.env;
if (!appId || !appSecret || !ownerOpenId) {
  console.error('Configure FEISHU_APP_ID, FEISHU_APP_SECRET and FEISHU_OWNER_OPEN_ID locally.');
  process.exit(2);
}

const runId = randomUUID();
const out = resolve('.cache/verification/feishu-portfolio-' + runId);
mkdirSync(out, { recursive: true });
const store = new PortfolioDecisionStore(out);
const itemId = 'demo:' + runId + ':contract:demo';
const item = {
  itemId, projectId: 'demo-project', projectName: '组合卡验收', kind: 'contract', severity: 'high',
  bucket: 'needs_you', summary: '验收：请在飞书点「批准 / 驳回 / 稍后」',
  recommendation: '点任一按钮即记录你的决定', impact: '仅验收交互，不改任何项目或资金',
  evidence: [], defaultAction: 'hold', realtime: true,
  createdAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 180_000).toISOString(),
};

const client = createPortfolioFeishuClient({ appId, appSecret, ownerOpenId, store });
try {
  await client.start();
  const connectBy = Date.now() + 15_000;
  while (client.status() !== 'connected' && Date.now() < connectBy) await delay(250);
  if (client.status() !== 'connected') throw new Error('portfolio_feishu_unavailable');
  console.log('飞书长连接已建立。');
  const messageId = await client.sendItem(item);
  console.log('已发送组合卡 messageId=' + messageId + '，请在飞书点击任一按钮…');
  const expiry = Date.now() + 180_000;
  while (Date.now() < expiry && !store.isDecided(itemId)) await delay(300);
  if (!store.isDecided(itemId)) throw new Error('portfolio_card_timeout');
  console.log('已记录决定：' + JSON.stringify(store.get(itemId)));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'portfolio_feishu_failed');
  process.exitCode = 1;
} finally {
  client.close();
}
