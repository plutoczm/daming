import { createHash } from 'node:crypto';
import { AppType, Client, Domain, EventDispatcher, LoggerLevel, WSClient } from '@larksuiteoapi/node-sdk';
import type { Engine } from '@daming/core';
import type { EscalationItemView } from '@daming/contracts';
import { FeishuChannel } from './feishu-channel.ts';
import type { FeishuActionResult, FeishuCard, FeishuCardRepository } from './feishu-channel.ts';
import type { PortfolioDecisionStore } from './portfolio-decisions.ts';
import { handlePortfolioCardAction, renderPortfolioDecisionCard } from './portfolio-feishu.ts';

interface FeishuLongConnectionOptions {
  readonly appId: string;
  readonly appSecret: string;
  readonly ownerOpenId: string;
  readonly projectOwnerId: string;
  readonly engine: Engine;
  readonly repository: FeishuCardRepository;
  readonly pause: (projectId: string) => Promise<void>;
  readonly now?: () => number;
}

export function renderFeishuDecisionCard(card: FeishuCard) {
  return {
    schema: '2.0',
    header: { title: { tag: 'plain_text', content: card.title } },
    body: { elements: [
      { tag: 'div', text: { tag: 'plain_text', content: card.body } },
      ...card.buttons.map(button => ({
        tag: 'button', text: { tag: 'plain_text', content: button.label }, type: 'default',
        behaviors: [{ type: 'callback', value: { decisionId: card.decisionId, action: button.action } }],
      })),
    ] },
  };
}

// The SDK flattens the v2 header and event before calling the registered handler.
export function createFeishuDecisionDispatcher(channel: FeishuChannel) {
  return new EventDispatcher({ loggerLevel: LoggerLevel.fatal }).register({
    'card.action.trigger': async (event: unknown) => {
      let result: FeishuActionResult;
      try {
        result = await channel.handleLongConnectionAction(event);
      } catch {
        return { toast: { type: 'error', content: '操作未受理。请检查卡片状态。' } };
      }
      return { toast: { type: 'success', content: result.status === 'paused' ? '已暂停' : '决定已记录' } };
    },
  });
}

/** Feishu network I/O is owned by the trusted Host and bound to one project owner. */
export function createFeishuLongConnection(options: FeishuLongConnectionOptions) {
  const { appId, appSecret, engine, ownerOpenId, projectOwnerId } = options;
  if (!/^cli_[A-Za-z0-9]{1,64}$/.test(appId) || !appSecret.trim() ||
      !/^ou_[A-Za-z0-9_-]{1,64}$/.test(ownerOpenId) || !projectOwnerId.trim()) {
    throw new Error('feishu_long_connection_config_invalid');
  }
  const sdkOptions = { appId, appSecret, domain: Domain.Feishu, loggerLevel: LoggerLevel.fatal };
  const client = new Client({ ...sdkOptions, appType: AppType.SelfBuild });
  const socket = new WSClient({ ...sdkOptions, handshakeTimeoutMs: 10_000 });
  const channel = new FeishuChannel({
    appId, repository: options.repository, engine, now: options.now ?? Date.now, pause: options.pause,
    transport: async card => {
      if (socket.getConnectionStatus().state !== 'connected') throw new Error('feishu_long_connection_unavailable');
      const project = engine.getProject(card.projectId);
      const decision = project?.decisions.find(item => item.decisionId === card.decisionId);
      if (card.ownerOpenId !== ownerOpenId || project?.ownerId !== projectOwnerId || decision?.status !== 'pending' ||
          decision.kind !== card.decisionKind || decision.targetRevision !== card.targetRevision) {
        throw new Error('feishu_card_owner_or_decision_mismatch');
      }
      const uuid = createHash('sha256').update(JSON.stringify([
        appId, ownerOpenId, card.projectId, card.decisionId, card.targetRevision,
      ])).digest('hex').slice(0, 50);
      const response = await client.im.v1.message.create({
        params: { receive_id_type: 'open_id' },
        data: { receive_id: ownerOpenId, msg_type: 'interactive', content: JSON.stringify(renderFeishuDecisionCard(card)), uuid },
      });
      if (response.code !== 0 || !response.data?.message_id) throw new Error('feishu_card_send_failed');
      return { messageId: response.data.message_id };
    },
  });
  const eventDispatcher = createFeishuDecisionDispatcher(channel);
  return {
    start: () => socket.start({ eventDispatcher }),
    status: () => socket.getConnectionStatus().state,
    close: () => socket.close({ force: true }),
    publish: (card: FeishuCard) => channel.publish(card),
  };
}

/**
 * 组合项交互卡片的官方长连接客户端（P0.7）。
 * 只允许本人操作；点击把决策写入 PortfolioDecisionStore。与 S10 决策卡客户端彼此独立，
 * 由独立脚本/进程按需启动（不常驻、不抢事件）。
 */
export function createPortfolioFeishuClient(options: {
  readonly appId: string;
  readonly appSecret: string;
  readonly ownerOpenId: string;
  readonly store: PortfolioDecisionStore;
  readonly now?: () => number;
}) {
  const { appId, appSecret, ownerOpenId, store } = options;
  if (!/^cli_[A-Za-z0-9]{1,64}$/.test(appId) || !appSecret.trim() || !/^ou_[A-Za-z0-9_-]{1,64}$/.test(ownerOpenId)) {
    throw new Error('portfolio_feishu_config_invalid');
  }
  const sdkOptions = { appId, appSecret, domain: Domain.Feishu, loggerLevel: LoggerLevel.fatal };
  const client = new Client({ ...sdkOptions, appType: AppType.SelfBuild });
  const socket = new WSClient({ ...sdkOptions, handshakeTimeoutMs: 10_000 });
  const eventDispatcher = new EventDispatcher({ loggerLevel: LoggerLevel.fatal }).register({
    'card.action.trigger': async (event: unknown) => handlePortfolioCardAction(store, event, { ownerOpenId, now: options.now?.() }),
  });
  const connected = () => socket.getConnectionStatus().state === 'connected';
  return {
    start: () => socket.start({ eventDispatcher }),
    status: () => socket.getConnectionStatus().state,
    close: () => socket.close({ force: true }),
    async sendItem(item: EscalationItemView): Promise<string> {
      if (!connected()) throw new Error('portfolio_feishu_unavailable');
      const nonce = store.cardNonce(item.itemId);
      const uuid = createHash('sha256').update(JSON.stringify([appId, ownerOpenId, item.itemId])).digest('hex').slice(0, 50);
      const response = await client.im.v1.message.create({
        params: { receive_id_type: 'open_id' },
        data: { receive_id: ownerOpenId, msg_type: 'interactive', content: JSON.stringify(renderPortfolioDecisionCard(item, nonce)), uuid },
      });
      if (response.code !== 0 || !response.data?.message_id) throw new Error('portfolio_feishu_send_failed');
      return response.data.message_id;
    },
  };
}
