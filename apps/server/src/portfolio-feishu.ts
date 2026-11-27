/**
 * 组合项交互卡片（P0.7，纯逻辑，不依赖飞书 SDK）。
 *  - renderPortfolioDecisionCard：生成 schema 2.0 交互卡（批准 / 驳回 / 稍后），按钮 value 带一次性 nonce。
 *  - handlePortfolioCardAction：解析 card.action.trigger 事件 → 写入决策账本 → 返回 toast。
 * SDK 连接/发送在 feishu-long-connection.ts（唯一允许 import 官方 SDK 的文件）。
 */
import type { EscalationItemView } from '@daming/contracts';
import type { PortfolioDecisionAction, PortfolioDecisionStore } from './portfolio-decisions.ts';

const KIND_LABEL: Record<EscalationItemView['kind'], string> = {
  contract: '契约待确认', acceptance: '待验收', budget: '预算/账单', irreversible: '不可逆授权', anomaly: '异常',
};

export interface PortfolioCardButton { readonly action: PortfolioDecisionAction; readonly label: string; readonly type: 'default' | 'primary' | 'danger'; }
const BUTTONS: readonly PortfolioCardButton[] = [
  { action: 'approve', label: '批准/结案', type: 'primary' },
  { action: 'reject', label: '驳回', type: 'danger' },
  { action: 'defer', label: '稍后', type: 'default' },
];

export function renderPortfolioDecisionCard(item: EscalationItemView, nonce: string) {
  return {
    schema: '2.0',
    header: { title: { tag: 'plain_text', content: '大铭 · 组合 · ' + KIND_LABEL[item.kind] } },
    body: { elements: [
      { tag: 'div', text: { tag: 'plain_text', content: item.projectName + '：' + item.summary } },
      { tag: 'div', text: { tag: 'plain_text', content: '推荐：' + item.recommendation } },
      { tag: 'div', text: { tag: 'plain_text', content: '影响：' + item.impact + '｜超时默认：' + item.defaultAction } },
      {
        tag: 'action',
        actions: BUTTONS.map((button) => ({
          tag: 'button', text: { tag: 'plain_text', content: button.label }, type: button.type,
          behaviors: [{ type: 'callback', value: {
            module: 'portfolio', itemId: item.itemId, projectId: item.projectId, kind: item.kind,
            action: button.action, nonce,
          } }],
        })),
      },
    ] },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export interface PortfolioCardToast { readonly toast: { readonly type: 'success' | 'error'; readonly content: string } }

/**
 * 处理卡片回调。event 为 SDK 展平后的 card.action.trigger 事件。
 * ownerOpenId 绑定后仅本人可操作（由 Host 从配置注入）。
 */
export function handlePortfolioCardAction(
  store: PortfolioDecisionStore,
  event: unknown,
  options: { readonly ownerOpenId?: string; readonly now?: number } = {},
): PortfolioCardToast {
  const fail = (content: string): PortfolioCardToast => ({ toast: { type: 'error', content } });
  if (!isObject(event) || event.event_type !== 'card.action.trigger' || !isObject(event.action) ||
      event.action.tag !== 'button' || !isObject(event.operator) || typeof event.operator.open_id !== 'string') {
    return fail('卡片事件无效');
  }
  const value = event.action.value;
  if (!isObject(value) || value.module !== 'portfolio' || typeof value.itemId !== 'string' ||
      typeof value.projectId !== 'string' || typeof value.kind !== 'string') {
    return fail('卡片内容无效');
  }
  const action = value.action;
  if (action !== 'approve' && action !== 'reject' && action !== 'defer') return fail('操作无效');
  const actorId = event.operator.open_id;
  if (options.ownerOpenId && actorId !== options.ownerOpenId) return fail('仅本人可操作');
  try {
    const result = store.decide({
      itemId: value.itemId, projectId: value.projectId, kind: value.kind, action,
      actorId, decidedAt: new Date(options.now ?? Date.now()).toISOString(),
      nonce: typeof value.nonce === 'string' ? value.nonce : undefined, requireNonce: true,
    });
    const label = result.duplicate ? '此前已处理'
      : result.record.action === 'approve' ? '已批准并结案'
      : result.record.action === 'reject' ? '已驳回' : '已稍后';
    return { toast: { type: 'success', content: label } };
  } catch (error) {
    return fail(error instanceof Error ? error.message : '操作未受理');
  }
}
