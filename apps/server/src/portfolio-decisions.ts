/**
 * 组合项决策账本（P0.7）—— 一键审批的唯一写者。
 *
 * 每条待拍板项（稳定 itemId）只允许被决策一次（approve / reject / defer），
 * 记录 actor、时间与卡片 nonce（防伪造/跨项重放）。已结案的 itemId 会从组合收件箱隐藏（suppressed）。
 *
 * 这是“治理决策日志”，不是任务事实，也不是第二套任务调度：任务/项目状态仍由各自唯一来源负责。
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type PortfolioDecisionAction = 'approve' | 'reject' | 'defer';
const ACTIONS: readonly PortfolioDecisionAction[] = ['approve', 'reject', 'defer'];

export interface PortfolioDecisionRecord {
  readonly itemId: string;
  readonly projectId: string;
  readonly kind: string;
  readonly action: PortfolioDecisionAction;
  readonly actorId: string;
  readonly decidedAt: string;
  readonly note?: string;
}

export class PortfolioDecisionError extends Error {
  readonly status: number;
  constructor(status: number, reason: string) { super(reason); this.status = status; }
}

interface DecisionFile {
  salt: string;
  decisions: Record<string, PortfolioDecisionRecord>;
}

export class PortfolioDecisionStore {
  private readonly file: string;
  private data: DecisionFile;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = join(dataDir, 'portfolio-decisions.json');
    try {
      const parsed = (existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : null) as Partial<DecisionFile> | null;
      this.data = parsed && typeof parsed.salt === 'string' && parsed.decisions && typeof parsed.decisions === 'object'
        ? { salt: parsed.salt, decisions: parsed.decisions }
        : { salt: '', decisions: {} };
    } catch { this.data = { salt: '', decisions: {} }; }
    if (!this.data.salt) { this.data.salt = randomBytes(16).toString('hex'); this.persist(); }
  }
  private persist(): void {
    try { writeFileSync(this.file, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 }); } catch { /* best effort */ }
  }
  /** 卡片按钮携带的一次性 nonce（对 itemId 绑定；跨项不可用）。 */
  cardNonce(itemId: string): string {
    return createHash('sha256').update('portfolio|' + this.data.salt + '|' + itemId).digest('hex').slice(0, 24);
  }
  get(itemId: string): PortfolioDecisionRecord | undefined { return this.data.decisions[itemId]; }
  list(): PortfolioDecisionRecord[] { return Object.values(this.data.decisions); }
  resolvedItemIds(): string[] { return Object.keys(this.data.decisions); }
  isDecided(itemId: string): boolean { return !!this.data.decisions[itemId]; }

  /**
   * 记录一次决策。同 item 重复：相同 action 视为幂等 duplicate；不同 action 拒绝（单次不可变）。
   * requireNonce=true 时（飞书卡片路径）必须携带正确 nonce。
   */
  decide(input: {
    readonly itemId: string;
    readonly projectId: string;
    readonly kind: string;
    readonly action: PortfolioDecisionAction;
    readonly actorId: string;
    readonly decidedAt: string;
    readonly note?: string;
    readonly nonce?: string;
    readonly requireNonce?: boolean;
  }): { record: PortfolioDecisionRecord; duplicate: boolean } {
    if (typeof input.itemId !== 'string' || !input.itemId.trim()) throw new PortfolioDecisionError(400, 'portfolio_item_id_required');
    if (!ACTIONS.includes(input.action)) throw new PortfolioDecisionError(400, 'portfolio_action_invalid');
    if (typeof input.actorId !== 'string' || !input.actorId.trim()) throw new PortfolioDecisionError(400, 'portfolio_actor_required');
    if (input.requireNonce) {
      if (typeof input.nonce !== 'string' || input.nonce !== this.cardNonce(input.itemId)) {
        throw new PortfolioDecisionError(403, 'portfolio_card_nonce_invalid');
      }
    }
    const existing = this.data.decisions[input.itemId];
    if (existing) {
      if (existing.action === input.action) return { record: existing, duplicate: true };
      throw new PortfolioDecisionError(409, 'portfolio_item_already_decided');
    }
    const record: PortfolioDecisionRecord = {
      itemId: input.itemId, projectId: input.projectId, kind: input.kind, action: input.action,
      actorId: input.actorId, decidedAt: input.decidedAt,
      ...(typeof input.note === 'string' && input.note.trim() ? { note: input.note.trim().slice(0, 500) } : {}),
    };
    this.data.decisions[input.itemId] = record;
    this.persist();
    return { record, duplicate: false };
  }
}
