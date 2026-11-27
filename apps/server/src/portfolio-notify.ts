/**
 * 组合收件箱 → 推送计划器（P0.6）。
 *
 * 只做“要不要推、推什么文本、去重状态怎么变”的纯决策；真正的发送由注入的 send 完成
 * （Host 里接到 NotificationHub.notify，走用户「通知」页配置的飞书/企微/微信/QQ/webhook 通道）。
 *
 * 规则（对齐 REQ-014 / Autoloop push policy）：
 *  - 生命线（realtime）：新出现的待拍板项实时推；同一 itemId 不重复推。
 *  - 晨间 digest：当天首次出现、且有 digest 项时推一次；同一天不重复。
 *  - 决策/错误类（高严重度）永不静默（它们本就在 realtime 里）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EscalationItemView, PortfolioDigestView } from '@daming/contracts';
import type { NotificationEvent } from './notification-hub.ts';

export const PORTFOLIO_LIFELINE_EVENT: NotificationEvent = 'portfolio.lifeline';
export const PORTFOLIO_DIGEST_EVENT: NotificationEvent = 'portfolio.digest';

const MAX_PUSHED_IDS = 500;

export interface NotifyState {
  readonly pushedItemIds: readonly string[];
  readonly lastDigestDay: string;
}
export function emptyNotifyState(): NotifyState { return { pushedItemIds: [], lastDigestDay: '' }; }

const DEFAULT_LABEL: Record<EscalationItemView['defaultAction'], string> = {
  hold: '保持现状', pause: '暂停', advance: '推进', reject: '驳回',
};

function oneLine(item: EscalationItemView): string {
  return '· ' + item.projectName + '：' + item.summary + '\n  推荐：' + item.recommendation +
    '｜影响：' + item.impact + '｜超时默认：' + DEFAULT_LABEL[item.defaultAction];
}

/** 生命线实时文本（只列新增项）。 */
export function formatRealtimeMessage(items: readonly EscalationItemView[]): string {
  return '【大铭 · 组合生命线（需你拍板）】\n' + items.map(oneLine).join('\n');
}

/** 晨间 digest 文本（当日汇总）。 */
export function formatDigestMessage(digest: PortfolioDigestView, items: readonly EscalationItemView[]): string {
  const totals = digest.totals;
  return '【大铭 · 晨间组合 digest · ' + digest.dayKey + '】\n' +
    '项目 ' + totals.projects + '｜需拍板 ' + totals.needsYou + '｜风险 ' + totals.atRisk +
    '｜待验收 ' + totals.awaitingAcceptance + '｜健康 ' + totals.healthy + '\n' +
    items.map(oneLine).join('\n') +
    (digest.autoHandled.length ? '\n系统已代做 ' + digest.autoHandled.length + ' 项（详见组合页）' : '');
}

export interface NotificationPlan {
  readonly realtimeText: string | null;
  readonly digestText: string | null;
  readonly nextState: NotifyState;
}

/** 纯决策：给定 digest 与历史去重状态，算出本轮要推什么、以及新状态。 */
export function planPortfolioNotifications(input: {
  readonly digest: PortfolioDigestView;
  readonly state: NotifyState;
}): NotificationPlan {
  const { digest, state } = input;
  const seen = new Set(state.pushedItemIds);

  const freshRealtime = digest.realtime.filter((item) => !seen.has(item.itemId));
  const realtimeText = freshRealtime.length ? formatRealtimeMessage(freshRealtime) : null;

  let digestText: string | null = null;
  if (digest.digest.length > 0 && state.lastDigestDay !== digest.dayKey) {
    digestText = formatDigestMessage(digest, digest.digest);
  }

  const merged = [...state.pushedItemIds];
  for (const item of freshRealtime) merged.push(item.itemId);
  const pushedItemIds = merged.slice(-MAX_PUSHED_IDS);

  return {
    realtimeText, digestText,
    nextState: {
      pushedItemIds,
      lastDigestDay: digestText ? digest.dayKey : state.lastDigestDay,
    },
  };
}

/** JSON 持久化去重状态（只存 itemId 与日期，不含敏感数据）。 */
export class PortfolioNotifyStore {
  private readonly file: string;
  private state: NotifyState;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = join(dataDir, 'portfolio-notify.json');
    try {
      const parsed = (existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : null) as Partial<NotifyState> | null;
      this.state = parsed && Array.isArray(parsed.pushedItemIds) && typeof parsed.lastDigestDay === 'string'
        ? { pushedItemIds: parsed.pushedItemIds, lastDigestDay: parsed.lastDigestDay }
        : emptyNotifyState();
    } catch { this.state = emptyNotifyState(); }
  }
  get(): NotifyState { return this.state; }
  set(next: NotifyState): void {
    this.state = next;
    try { writeFileSync(this.file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 }); } catch { /* best effort */ }
  }
}

export interface PushResult { readonly realtime: boolean; readonly digest: boolean; }

/** 组合推送执行器：计划 → 通过注入的 send 发送 → 提交去重状态。 */
export class PortfolioNotifier {
  private readonly store: PortfolioNotifyStore;
  private readonly send: (event: NotificationEvent, text: string) => Promise<void>;
  constructor(store: PortfolioNotifyStore, send: (event: NotificationEvent, text: string) => Promise<void>) {
    this.store = store; this.send = send;
  }
  async run(digest: PortfolioDigestView): Promise<PushResult> {
    const plan = planPortfolioNotifications({ digest, state: this.store.get() });
    let realtime = false;
    let digested = false;
    if (plan.realtimeText) { await this.send(PORTFOLIO_LIFELINE_EVENT, plan.realtimeText); realtime = true; }
    if (plan.digestText) { await this.send(PORTFOLIO_DIGEST_EVENT, plan.digestText); digested = true; }
    this.store.set(plan.nextState);
    return { realtime, digest: digested };
  }
}
