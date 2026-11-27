import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Job, Result } from '@daming/autoloop';
import type { MagpieRoutingCatalog } from './magpie-routing.ts';
import type { MagpiePinnedBinding } from './magpie-host.ts';
import { quoteSyntheticRouteCeiling } from './mission-route-price.ts';
import type { SyntheticRoutePriceBasis } from './mission-route-price.ts';
import type {
  CreateMissionInput, CreateMissionRouteAuthorizationInput, PrepareMissionRouteAttemptInput,
  MissionRouteAttemptView, MissionRouteAuthorizationView, MissionRouteReceiptView,
  MissionEventView, MissionNodeState, MissionNodeView, MissionState, MissionView
} from '@daming/contracts';

/**
 * Daming is the only writer of mission facts. Autoloop supplies human decision
 * cards; the Super-Agent-like plan is a deterministic OFFLINE demo, not an LLM.
 * Lancer-style displays consume these versioned facts, never synthesize actions.
 */
export class MissionError extends Error {
  readonly status: number;
  constructor(status: number, reason: string) { super(reason); this.status = status; }
}

interface MissionRow {
  id: string; request_key: string; title: string; goal: string;
  status: MissionState; created_at: string; updated_at: string;
  card_id: number | null; nodes: string; delivery: string | null;
  blocked_reason: string | null;
}
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const PLAN: readonly MissionNodeView[] = Object.freeze([
  { id: 'router', name: '任务拆解', owner: 'superagent', role: '确定性 Router（演示）', status: 'pending', dependsOn: [], modelRoute: 'unbound' },
  { id: 'research', name: '资料梳理', owner: 'worker', role: '离线规则 Worker A', status: 'pending', dependsOn: ['router'], modelRoute: 'unbound' },
  { id: 'analysis', name: '方案对比', owner: 'worker', role: '离线规则 Worker B', status: 'pending', dependsOn: ['router'], modelRoute: 'unbound' },
  { id: 'decision', name: '人工决策', owner: 'autoloop', role: 'Auto-Loop 审批卡', status: 'pending', dependsOn: ['research', 'analysis'], modelRoute: 'unbound' },
  { id: 'delivery', name: '成果整理', owner: 'daming', role: '离线模板整合', status: 'pending', dependsOn: ['decision'], modelRoute: 'unbound' }
]);
const CARD_OPTIONS = ['批准继续离线演示', '拒绝并结束'];
function cardTitle(id: string): string { return '大铭任务审批 ' + id; }
function iso(): string { return new Date().toISOString(); }
function assertId(id: string): void {
  if (!UUID.test(id)) throw new MissionError(400, 'invalid_mission_id');
}
function assertRoutePrincipal(owner: { tenantId: string; principalId: string }): void {
  const id = /^[a-z0-9][a-z0-9._:-]{0,79}$/i;
  if (!owner || typeof owner.tenantId !== 'string' || !id.test(owner.tenantId) ||
      typeof owner.principalId !== 'string' || !id.test(owner.principalId)) {
    throw new MissionError(400, 'invalid_route_principal');
  }
}
function normalize(input: CreateMissionInput): CreateMissionInput {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => !['title', 'goal', 'requestId', 'mode'].includes(key)) ||
      input.mode !== 'offline-demo' || !UUID.test(input.requestId) ||
      typeof input.title !== 'string' || !input.title.trim() || input.title.length > 120 ||
      typeof input.goal !== 'string' || !input.goal.trim() || input.goal.length > 1500 ||
      input.title.includes('\0') || input.goal.includes('\0')) {
    throw new MissionError(400, 'invalid_mission_input');
  }
  return { requestId: input.requestId.toLowerCase(), title: input.title.trim(), goal: input.goal.trim(), mode: 'offline-demo' };
}
function cloneNodes(): MissionNodeView[] {
  return PLAN.map((node) => ({ ...node, dependsOn: [...node.dependsOn] }));
}
function parseNodes(text: string): MissionNodeView[] {
  return JSON.parse(text) as MissionNodeView[];
}

export class MissionControl {
  private readonly db: DatabaseSync;
  private readonly onChanged: () => void;

  constructor(dataDir: string, onChanged: () => void = () => undefined) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dataDir, 'missions.db'));
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS missions (' +
      'id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, title TEXT NOT NULL, goal TEXT NOT NULL,' +
      'status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, card_id INTEGER,' +
      'nodes TEXT NOT NULL CHECK(json_valid(nodes)), delivery TEXT, blocked_reason TEXT);' +
      'CREATE TABLE IF NOT EXISTS mission_events (' +
      'sequence INTEGER PRIMARY KEY AUTOINCREMENT, mission_id TEXT NOT NULL REFERENCES missions(id),' +
      'schema_version INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL, type TEXT NOT NULL,' +
      'node_id TEXT, summary TEXT NOT NULL, occurred_at TEXT NOT NULL);' +
      'CREATE INDEX IF NOT EXISTS mission_events_task ON mission_events(mission_id,sequence);' +
      'CREATE TABLE IF NOT EXISTS mission_route_authorizations (' +
      'id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id),' +
      'request_key TEXT NOT NULL UNIQUE, candidate_id TEXT NOT NULL, provider_id TEXT NOT NULL,' +
      'model_id TEXT NOT NULL, account_ref TEXT NOT NULL, instance_id TEXT NOT NULL,' +
      'created_at TEXT NOT NULL, expires_at TEXT NOT NULL, max_requests INTEGER NOT NULL,' +
      'max_output_tokens INTEGER NOT NULL, max_cash_minor INTEGER NOT NULL, revoked_at TEXT);' +
      'CREATE UNIQUE INDEX IF NOT EXISTS mission_active_auth ON mission_route_authorizations(mission_id) WHERE revoked_at IS NULL;' +
      'CREATE TABLE IF NOT EXISTS mission_route_attempts (' +
      'id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id),' +
      'authorization_id TEXT NOT NULL REFERENCES mission_route_authorizations(id),' +
      'request_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN (\'prepared\',\'cancelled\')),' +
      'output_token_ceiling INTEGER NOT NULL CHECK(output_token_ceiling > 0),' +
      'budget_envelope_minor INTEGER NOT NULL CHECK(budget_envelope_minor >= 0),' +
      'created_at TEXT NOT NULL);' +
      'CREATE INDEX IF NOT EXISTS mission_route_attempts_task ON mission_route_attempts(mission_id,created_at);' +
      // Separate tables avoid modifying legacy mission_route_attempts CHECK constraints.
      // No externally reachable write path exists for either ownership proof or sending.
      'CREATE TABLE IF NOT EXISTS mission_route_principals (' +
      'mission_id TEXT PRIMARY KEY REFERENCES missions(id), tenant_id TEXT NOT NULL, principal_id TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS mission_route_account_claims (' +
      'instance_id TEXT NOT NULL, provider_id TEXT NOT NULL, account_ref TEXT NOT NULL,' +
      'tenant_id TEXT NOT NULL, principal_id TEXT NOT NULL, proof TEXT NOT NULL CHECK(proof=\'synthetic_fixture\'),' +
      'revoked_at TEXT, PRIMARY KEY(instance_id,provider_id,account_ref));' +
      'CREATE TABLE IF NOT EXISTS mission_route_receipts (' +
      'attempt_id TEXT PRIMARY KEY REFERENCES mission_route_attempts(id),' +
      'mission_id TEXT NOT NULL REFERENCES missions(id),' +
      'state TEXT NOT NULL CHECK(state IN (\'unknown_after_send\',\'settled_synthetic\',\'breached_synthetic\')),' +
      'price_basis_id TEXT NOT NULL, price_ceiling_minor INTEGER NOT NULL,' +
      'maximum_input_tokens INTEGER NOT NULL, started_at TEXT NOT NULL, completed_at TEXT,' +
      'actual_cash_minor INTEGER, input_tokens INTEGER, output_tokens INTEGER,' +
      'evidence_ref TEXT UNIQUE);' +
      'CREATE INDEX IF NOT EXISTS mission_route_receipts_mission ON mission_route_receipts(mission_id,started_at);' +
      'CREATE TABLE IF NOT EXISTS mission_magpie_role_plans(' +
      'mission_id TEXT PRIMARY KEY REFERENCES missions(id),' +
      'request_key TEXT NOT NULL UNIQUE,assignments_json TEXT NOT NULL CHECK(json_valid(assignments_json)),' +
      'updated_at TEXT NOT NULL);'
    );
    this.onChanged = onChanged;
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      this.db.exec('COMMIT');
      this.onChanged();
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private row(id: string): MissionRow {
    assertId(id);
    const row = this.db.prepare('SELECT * FROM missions WHERE id=?').get(id) as unknown as MissionRow | undefined;
    if (!row) throw new MissionError(404, 'mission_not_found');
    return row;
  }

  private save(row: MissionRow): void {
    const updatedAt = iso();
    this.db.prepare('UPDATE missions SET status=?,updated_at=?,card_id=?,nodes=?,delivery=?,blocked_reason=? WHERE id=?')
      .run(row.status, updatedAt, row.card_id, row.nodes, row.delivery, row.blocked_reason, row.id);
  }

  private event(id: string, source: MissionEventView['source'], type: string, summary: string, nodeId?: string): void {
    // Never put the user's complete prompt, credentials or worker raw output in the event stream.
    this.db.prepare('INSERT INTO mission_events(mission_id,schema_version,source,type,node_id,summary,occurred_at) VALUES(?,1,?,?,?,?,?)')
      .run(id, source, type, nodeId ?? null, summary.slice(0, 160), iso());
  }

  /** A planning-only binding. Magpie stays authoritative for accounts and
   * routing groups; Daming does not execute a paid request from this plan. */
  assignMagpieRoles(id: string, requestId: string,
    assignments: readonly { role: 'router' | 'research' | 'analysis' | 'delivery'; targetId: string }[]): MissionView {
    assertId(id); assertId(requestId);
    if (!Array.isArray(assignments) || assignments.length < 1 || assignments.length > 4 ||
        new Set(assignments.map(a => a.role)).size !== assignments.length ||
        assignments.some(a => !a || !['router','research','analysis','delivery'].includes(a.role) ||
          typeof a.targetId !== 'string' || !/^[a-z0-9][a-z0-9._:\/+\-]{0,159}$/i.test(a.targetId))) {
      throw new MissionError(400, 'magpie_target_role_plan_invalid');
    }
    return this.transaction(() => {
      const row = this.row(id);
      if (row.status === 'cancelled' || row.status === 'completed' || row.status === 'blocked') {
        throw new MissionError(409, 'mission_not_plannable');
      }
      const previous = this.db.prepare(
        'SELECT request_key,assignments_json FROM mission_magpie_role_plans WHERE mission_id=?'
      ).get(id) as { request_key: string; assignments_json: string } | undefined;
      if (previous?.request_key === requestId) {
        if (previous.assignments_json !== JSON.stringify(assignments)) {
          throw new MissionError(409, 'magpie_plan_request_conflict');
        }
        return this.detail(id);
      }
      const existing = this.db.prepare('SELECT mission_id FROM mission_magpie_role_plans WHERE request_key=?')
        .get(requestId) as { mission_id: string } | undefined;
      if (existing) throw new MissionError(409, 'magpie_plan_request_reused');
      const bindings = new Map(assignments.map(a => [a.role, a.targetId]));
      row.nodes = JSON.stringify(parseNodes(row.nodes).map(node => ({
        ...node, modelRoute: bindings.get(node.id as 'router' | 'research' | 'analysis' | 'delivery') ?? node.modelRoute
      })));
      this.save(row);
      this.db.prepare('INSERT INTO mission_magpie_role_plans(' +
        'mission_id,request_key,assignments_json,updated_at) VALUES(?,?,?,?) ' +
        'ON CONFLICT(mission_id) DO UPDATE SET request_key=excluded.request_key,' +
        'assignments_json=excluded.assignments_json,updated_at=excluded.updated_at')
        .run(id,requestId,JSON.stringify(assignments),iso());
      this.event(id,'daming','magpie.targets.planned',
        '已绑定 Magpie 模型 / Agent / 路由组（仅任务计划，不发送推理）');
      return this.detail(id);
    });
  }

  list(): MissionView[] {
    const ids = this.db.prepare('SELECT id FROM missions ORDER BY created_at DESC LIMIT 30').all();
    return ids.map((row) => this.detail(String(row.id)));
  }

  detail(id: string): MissionView {
    const row = this.row(id);
    const entries = this.db.prepare('SELECT * FROM mission_events WHERE mission_id=? ORDER BY sequence LIMIT 120').all(id);
    return {
      missionId: row.id, title: row.title, goal: row.goal, status: row.status, mode: 'offline-demo',
      createdAt: row.created_at, updatedAt: row.updated_at, cardId: row.card_id,
      nodes: parseNodes(row.nodes),
      events: entries.map((entry) => ({
        sequence: Number(entry.sequence), missionId: id, schemaVersion: 1, source: String(entry.source) as MissionEventView['source'],
        type: String(entry.type), ...(entry.node_id ? { nodeId: String(entry.node_id) } : {}),
        summary: String(entry.summary), occurredAt: String(entry.occurred_at), execution: 'offline-demo' as const
      })),
      delivery: row.delivery, blockedReason: row.blocked_reason,
      notification: { channel: 'feishu', state: 'preview_only', sent: false },
      routeAuthorization: this.authorization(id), routeAttempts: this.routeAttempts(id),
      routeReceipts: this.routeReceipts(id)
    };
  }

  create(input: CreateMissionInput): MissionView {
    const data = normalize(input);
    const prior = this.db.prepare('SELECT * FROM missions WHERE request_key=?').get(data.requestId) as unknown as MissionRow | undefined;
    if (prior) {
      if (prior.title !== data.title || prior.goal !== data.goal) throw new MissionError(409, 'mission_request_conflict');
      return this.detail(prior.id);
    }
    const id = randomUUID();
    return this.transaction(() => {
      const now = iso();
      this.db.prepare('INSERT INTO missions(id,request_key,title,goal,status,created_at,updated_at,card_id,nodes,delivery,blocked_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, data.requestId, data.title, data.goal, 'pending_event', now, now, null, JSON.stringify(cloneNodes()), null, null);
      this.event(id, 'daming', 'mission.created', '收到任务，等待 Auto-Loop 事件派发');
      return this.detail(id);
    });
  }

  /** Called only from a trusted Autoloop worker callback, never from an HTTP body. */
  async autoloopJob(job: Job): Promise<Result> {
    const sourceEvent = job.context.events.find((event) =>
      (event.type === 'mission.requested' || event.type === 'card.answered') && UUID.test(event.subject)
    );
    const candidate = job.context.answers.filter((entry) => entry.title.startsWith('大铭任务审批 '));
    if (candidate.length > 1) return { outcome: 'failed', error: 'ambiguous_mission_answer' };
    const answeredId = candidate[0]?.title.slice('大铭任务审批 '.length);
    const id = answeredId ?? sourceEvent?.subject;
    if (!id || !UUID.test(id)) return { outcome: 'failed', error: 'unbound_mission_event' };
    const row = this.row(id);
    if (row.status === 'completed' || row.status === 'cancelled') {
      return { outcome: 'done', summary: '任务已经处理，禁止重复执行' };
    }
    if (row.status === 'blocked') return { outcome: 'failed', error: 'mission_blocked' };
    const answer = job.context.answers.find((entry) => entry.title === cardTitle(id));
    if (answer) {
      if (row.status !== 'awaiting_decision' || row.card_id !== answer.card) {
        return { outcome: 'failed', error: 'mission_decision_binding_mismatch' };
      }
      if (answer.choice !== 0 && answer.choice !== 1) return { outcome: 'failed', error: 'invalid_mission_choice' };
      this.finish(id, answer.choice);
      return { outcome: 'done', summary: answer.choice === 0 ? '离线协作演示结束' : '用户拒绝了此次任务' };
    }
    // The first Autoloop round freezes the deterministic DAG and issues an actual kernel ask card.
    if (row.status === 'pending_event') {
      this.transaction(() => {
        const nodes = parseNodes(row.nodes).map((node) => ({
          ...node, status: node.id === 'router' || node.id === 'research' || node.id === 'analysis'
            ? 'completed' as MissionNodeState
            : node.id === 'decision' ? 'waiting' as MissionNodeState : 'pending' as MissionNodeState
        }));
        row.nodes = JSON.stringify(nodes);
        row.status = 'awaiting_decision';
        this.save(row);
        this.event(id, 'superagent', 'plan.frozen', '已冻结演示 DAG：两个角色分工，待人工确认', 'router');
        this.event(id, 'worker', 'research.fixture.completed', '规则型 Worker A 已生成演示摘要（非模型结果）', 'research');
        this.event(id, 'worker', 'analysis.fixture.completed', '规则型 Worker B 已生成演示比较（非模型结果）', 'analysis');
        this.event(id, 'autoloop', 'decision.requested', 'Auto-Loop 已请求用户批准继续', 'decision');
      });
    }
    return {
      outcome: 'done', summary: '离线计划已形成，等待人工决策',
      ask: [{
        title: cardTitle(id),
        text: '离线模拟任务需要用户决策。不会调用模型、不花费 API 额度、不发送飞书消息。审批后只生成演示交付内容。',
        options: [...CARD_OPTIONS], key: id
      }]
    };
  }

  attachCard(id: string, cardId: number): void {
    if (!Number.isSafeInteger(cardId) || cardId <= 0) throw new MissionError(400, 'invalid_mission_card');
    this.transaction(() => {
      const row = this.row(id);
      if (row.card_id === cardId) return;
      if (row.status !== 'awaiting_decision' || row.card_id !== null) throw new MissionError(409, 'mission_not_waiting');
      row.card_id = cardId;
      this.save(row);
      this.event(id, 'autoloop', 'decision.card.bound', '已关联 Auto-Loop 决策卡', 'decision');
    });
  }

  failDispatch(id: string): void {
    this.transaction(() => {
      const row = this.row(id);
      if (row.status === 'completed' || row.status === 'cancelled') return;
      row.status = 'blocked';
      row.blocked_reason = 'autoloop_mission_rule_not_available';
      this.save(row);
      this.event(id, 'daming', 'dispatch.blocked', 'Auto-Loop 未确认派工，禁止自动补发');
    });
  }

  private finish(id: string, choice: 0 | 1): void {
    this.transaction(() => {
      const row = this.row(id);
      if (row.status !== 'awaiting_decision') throw new MissionError(409, 'mission_not_waiting');
      const nodes = parseNodes(row.nodes).map((node) => ({
        ...node, status: node.id === 'delivery' ? (choice === 0 ? 'completed' : 'skipped')
          : node.id === 'decision' ? 'completed' : node.status
      }));
      row.nodes = JSON.stringify(nodes);
      this.event(id, 'autoloop', choice === 0 ? 'decision.approved' : 'decision.rejected', '用户已通过 Auto-Loop 卡片作出一次性决策', 'decision');
      if (choice === 0) {
        row.delivery = [
          '# 大铭任务演示交付', '',
          '任务：' + row.title, '',
          '原始目标：' + row.goal, '',
          '这是离线规则型多角色协作的演示报告。', '',
          '- Auto-Loop 决策卡已收到人工批准。',
          '- Super-Agent 式确定性 DAG 已记录两个分支及交付节点。',
          '- Magpie 只提供资源发现；没有使用任何真实供应商账号、API 或模型。',
          '- Feishu 仅生成本地通知预览，没有发送消息。',
          '- Lancer 风格事件图来自持久化事件，而非编造模型运行输出。'
        ].join('\n');
        row.status = 'completed';
        this.event(id, 'daming', 'delivery.fixture.completed', '离线规则交付已归档，外部模型调用 0 次', 'delivery');
      } else {
        row.status = 'cancelled';
        row.delivery = null;
        this.event(id, 'daming', 'mission.cancelled', '未调用任何外部模型或消息通道');
      }
      this.save(row);
    });
  }

  routeAttempts(id: string): MissionRouteAttemptView[] {
    assertId(id);
    const rows = this.db.prepare(
      'SELECT a.*,r.state AS receipt_state FROM mission_route_attempts a ' +
      'LEFT JOIN mission_route_receipts r ON r.attempt_id=a.id ' +
      'WHERE a.mission_id=? ORDER BY a.created_at,a.id LIMIT 50'
    ).all(id) as Record<string, unknown>[];
    return rows.map((r) => ({
      attemptId: String(r.id),
      authorizationId: String(r.authorization_id),
      state: String(r.receipt_state ?? r.state) as MissionRouteAttemptView['state'],
      outputTokenCeiling: Number(r.output_token_ceiling),
      budgetEnvelopeMinor: Number(r.budget_envelope_minor),
      createdAt: String(r.created_at),
      modelRequestSent: r.receipt_state ? 'possible' as const : false as const
    }));
  }

  /**
   * Host-only, offline resource-envelope allocation, not an executor permit.
   * Every reservation and the hard per-mission sums live inside one SQLite
   * BEGIN IMMEDIATE transaction, so concurrent HTTP requests cannot overbook.
   */
  prepareRouteAttempt(
    id: string,
    input: PrepareMissionRouteAttemptInput,
    catalog: MagpieRoutingCatalog
  ): MissionRouteAttemptView {
    this.row(id);
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some((k) => !['requestId', 'outputTokenCeiling', 'budgetEnvelopeMinor'].includes(k)) ||
        typeof input.requestId !== 'string' || !UUID.test(input.requestId) ||
        !Number.isSafeInteger(input.outputTokenCeiling) || input.outputTokenCeiling < 1 ||
        !Number.isSafeInteger(input.budgetEnvelopeMinor) || input.budgetEnvelopeMinor < 0) {
      throw new MissionError(400, 'invalid_route_attempt');
    }
    return this.transaction(() => {
      const key = input.requestId.toLowerCase();
      const earlier = this.db.prepare('SELECT * FROM mission_route_attempts WHERE request_key=?')
        .get(key) as Record<string, unknown> | undefined;
      if (earlier) {
        if (earlier.mission_id !== id ||
            earlier.output_token_ceiling !== input.outputTokenCeiling ||
            earlier.budget_envelope_minor !== input.budgetEnvelopeMinor) {
          throw new MissionError(409, 'route_attempt_request_conflict');
        }
        const prior = this.routeAttempts(id).find((a) => a.attemptId === earlier.id);
        if (!prior) throw new MissionError(409, 'route_attempt_unavailable');
        return prior;
      }
      const mission = this.row(id);
      if (mission.status !== 'awaiting_decision') throw new MissionError(409, 'mission_not_authorizable');
      if (!this.preflightRoute(id, catalog).accountBindingValid) {
        throw new MissionError(409, 'route_account_changed_or_expired');
      }
      const authorization = this.authorization(id);
      if (!authorization || authorization.state !== 'authorized') {
        throw new MissionError(409, 'route_not_authorized');
      }
      if (input.outputTokenCeiling > authorization.maxOutputTokens ||
          input.budgetEnvelopeMinor > authorization.maxCashMinor) {
        throw new MissionError(409, 'route_attempt_exceeds_authorization');
      }
      const lifetime = this.db.prepare('SELECT count(*) AS n FROM mission_route_attempts WHERE authorization_id=?')
        .get(authorization.authorizationId) as { n: number };
      if (lifetime.n >= 50) throw new MissionError(409, 'route_attempt_lifetime_limit');
      if (this.db.prepare(
        "SELECT 1 FROM mission_route_receipts WHERE mission_id=? AND state='breached_synthetic' LIMIT 1"
      ).get(id)) throw new MissionError(409, 'route_cash_dispute_blocks_new_attempts');
      const totals = this.db.prepare(
        "SELECT count(*) AS uses, COALESCE(sum(budget_envelope_minor),0) AS envelopes " +
        "FROM mission_route_attempts WHERE authorization_id=? AND state='prepared'"
      ).get(authorization.authorizationId) as { uses: number; envelopes: number };
      if (totals.uses >= authorization.maxRequests ||
          totals.envelopes + input.budgetEnvelopeMinor > authorization.maxCashMinor) {
        throw new MissionError(409, 'route_attempt_budget_exhausted');
      }
      const attemptId = randomUUID();
      this.db.prepare(
        'INSERT INTO mission_route_attempts(' +
        'id,mission_id,authorization_id,request_key,state,output_token_ceiling,budget_envelope_minor,created_at)' +
        ' VALUES(?,?,?,?,?,?,?,?)'
      ).run(attemptId, id, authorization.authorizationId, key, 'prepared',
        input.outputTokenCeiling, input.budgetEnvelopeMinor, iso());
      this.event(id, 'magpie', 'route.attempt.prepared',
        '已在本机原子预留请求名额与费用信封；模型请求尚未发送', 'router');
      return this.routeAttempts(id).find((a) => a.attemptId === attemptId)!;
    });
  }

  cancelRouteAttempt(id: string, attemptId: string): MissionRouteAttemptView {
    this.row(id);
    assertId(attemptId);
    return this.transaction(() => {
      const existing = this.routeAttempts(id).find((a) => a.attemptId === attemptId);
      if (!existing) throw new MissionError(404, 'route_attempt_not_found');
      if (existing.state !== 'prepared') throw new MissionError(409, 'route_attempt_not_prepared');
      // Once a send might have happened its envelope can NEVER be released by
      // the ordinary cancel endpoint, including after a synthetic receipt.
      if (this.db.prepare('SELECT 1 FROM mission_route_receipts WHERE attempt_id=?').get(attemptId)) {
        throw new MissionError(409, 'route_attempt_may_have_been_sent');
      }
      this.db.prepare("UPDATE mission_route_attempts SET state='cancelled' WHERE id=? AND mission_id=? AND state='prepared'")
        .run(attemptId, id);
      this.event(id, 'magpie', 'route.attempt.cancelled',
        '尚未发送的本机请求预留已取消，费用信封释放', 'router');
      return this.routeAttempts(id).find((a) => a.attemptId === attemptId)!;
    });
  }

  private authorizationRow(id: string): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM mission_route_authorizations WHERE mission_id=? ORDER BY created_at DESC LIMIT 1')
      .get(id) as Record<string, unknown> | undefined;
  }

  authorization(id: string): MissionRouteAuthorizationView | null {
    const r = this.authorizationRow(id);
    if (!r) return null;
    return {
      authorizationId: String(r.id), providerId: String(r.provider_id), modelId: String(r.model_id),
      state: r.revoked_at ? 'revoked' : Date.parse(String(r.expires_at)) <= Date.now() ? 'expired' : 'authorized',
      createdAt: String(r.created_at), expiresAt: String(r.expires_at),
      maxRequests: Number(r.max_requests), maxOutputTokens: Number(r.max_output_tokens),
      maxCashMinor: Number(r.max_cash_minor), dispatchEnabled: false
    };
  }

  authorizeRoute(id: string, input: CreateMissionRouteAuthorizationInput, catalog: MagpieRoutingCatalog): MissionRouteAuthorizationView {
    const mission = this.row(id);
    if (mission.status !== 'awaiting_decision' || mission.card_id === null) throw new MissionError(409, 'mission_not_authorizable');
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some((k) => !['requestId','candidateId','ttlMinutes','maxRequests','maxOutputTokens','maxCashMinor'].includes(k)) ||
        typeof input.requestId !== 'string' || !UUID.test(input.requestId) ||
        typeof input.candidateId !== 'string' ||
        !Number.isSafeInteger(input.ttlMinutes) || input.ttlMinutes < 1 || input.ttlMinutes > 60 ||
        !Number.isSafeInteger(input.maxRequests) || input.maxRequests < 1 || input.maxRequests > 20 ||
        !Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1 || input.maxOutputTokens > 8192 ||
        !Number.isSafeInteger(input.maxCashMinor) || input.maxCashMinor < 0 || input.maxCashMinor > 100000) {
      throw new MissionError(400, 'invalid_route_authorization');
    }
    const prior = this.db.prepare('SELECT * FROM mission_route_authorizations WHERE request_key=?')
      .get(input.requestId.toLowerCase()) as Record<string, unknown> | undefined;
    if (prior) {
      if (prior.mission_id !== id || prior.candidate_id !== input.candidateId ||
          prior.max_requests !== input.maxRequests || prior.max_output_tokens !== input.maxOutputTokens ||
          prior.max_cash_minor !== input.maxCashMinor) throw new MissionError(409, 'route_request_conflict');
      return this.authorization(id)!;
    }
    if (this.authorizationRow(id)) throw new MissionError(409, 'route_authorization_already_exists');
    const candidate = catalog.candidates.find((c) => c.candidateId === input.candidateId);
    if (!candidate) throw new MissionError(409, 'route_candidate_not_available');
    return this.transaction(() => {
      const now = iso();
      const authId = randomUUID();
      this.db.prepare('INSERT INTO mission_route_authorizations(id,mission_id,request_key,candidate_id,provider_id,model_id,account_ref,instance_id,created_at,expires_at,max_requests,max_output_tokens,max_cash_minor,revoked_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)')
        .run(authId, id, input.requestId.toLowerCase(), input.candidateId, candidate.providerId,
          candidate.modelId, candidate.accountRef, catalog.instanceId, now,
          new Date(Date.now() + input.ttlMinutes * 60000).toISOString(),
          input.maxRequests, input.maxOutputTokens, input.maxCashMinor);
      this.event(id, 'magpie', 'route.authorized', '已创建单账号任务租约（仅预检，不允许模型派工）', 'router');
      return this.authorization(id)!;
    });
  }

  /** Private Host-only route binding; never include in public MissionView. */
  routeBinding(id: string): MagpiePinnedBinding | null {
    this.row(id);
    const row = this.authorizationRow(id);
    if (!row || this.authorization(id)?.state !== 'authorized') return null;
    return {
      instanceId: String(row.instance_id), providerId: String(row.provider_id),
      modelId: String(row.model_id), accountRef: String(row.account_ref)
    };
  }

  scopeProbeStarted(id: string): boolean {
    this.row(id);
    return !!this.db.prepare(
      "SELECT 1 AS found FROM mission_events WHERE mission_id=? AND type='route.scope.probe.started' LIMIT 1"
    ).get(id);
  }

  beginScopeProbe(id: string): void {
    this.transaction(() => {
      const mission = this.row(id);
      if (mission.status !== 'awaiting_decision' || this.authorization(id)?.state !== 'authorized') {
        throw new MissionError(409, 'route_scope_probe_not_allowed');
      }
      const earlier = this.db.prepare(
        "SELECT 1 AS found FROM mission_events WHERE mission_id=? AND type='route.scope.probe.started' LIMIT 1"
      ).get(id);
      if (earlier) throw new MissionError(409, 'route_scope_probe_already_started');
      // Recorded before the first remote action. Unknown-after-crash cannot
      // silently replay the issued-key operation on a subsequent request.
      this.event(id, 'magpie', 'route.scope.probe.started',
        '已登记一次性网关范围检查；不发送模型请求', 'router');
    });
  }

  recordScopeProbe(id: string, verified: boolean): void {
    this.transaction(() => {
      this.row(id);
      this.event(id, 'magpie', verified ? 'route.scope.verified' : 'route.scope.unavailable',
        verified ? '短期网关密钥已验证账号限制并撤销（未调用模型）' :
          '账号范围检查失败或密钥撤销不确定，执行继续关闭', 'router');
    });
  }

  revokeRoute(id: string): MissionRouteAuthorizationView {
    this.row(id);
    const auth = this.authorization(id);
    if (!auth) throw new MissionError(404, 'route_authorization_not_found');
    if (auth.state !== 'authorized') throw new MissionError(409, 'route_authorization_not_active');
    return this.transaction(() => {
      this.db.prepare('UPDATE mission_route_authorizations SET revoked_at=? WHERE mission_id=? AND revoked_at IS NULL')
        .run(iso(), id);
      this.event(id, 'magpie', 'route.revoked', '任务路由租约已撤销，后续预检禁止使用', 'router');
      return this.authorization(id)!;
    });
  }

  preflightRoute(id: string, catalog: MagpieRoutingCatalog | null): import('@daming/contracts').MissionRoutePreflightView {
    const mission = this.row(id);
    const view = this.authorization(id);
    const raw = this.authorizationRow(id);
    const same = !!catalog && !!raw && catalog.instanceId === raw.instance_id &&
      catalog.candidates.some((candidate) =>
        candidate.candidateId === raw.candidate_id && candidate.accountRef === raw.account_ref);
    const reason = !view ? 'route_not_authorized' : mission.status !== 'awaiting_decision' ?
      'mission_not_authorizable' : view.state !== 'authorized' ?
      'route_' + view.state : !same ? 'route_account_changed_or_unavailable' : 'model_dispatch_not_integrated';
    return {
      missionId: id, authorizationId: view?.authorizationId ?? null,
      accountBindingValid: mission.status === 'awaiting_decision' && view?.state === 'authorized' && same,
      dispatchPermitted: false, reason,
      productionBlockers: [
        'persistent_tenant_identity_missing',
        'real_account_ownership_proof_missing',
        'provider_specific_live_price_verification_missing',
        'vendor_enforced_cash_cap_missing',
        'trusted_invoice_reconciliation_missing'
      ]
    };
  }


  /** Host-only synthetic principal; no browser or session ID is a tenant identity. */
  bindSyntheticMissionPrincipal(id: string, owner: { tenantId: string; principalId: string }): void {
    assertRoutePrincipal(owner);
    this.transaction(() => {
      this.row(id);
      const earlier = this.db.prepare('SELECT * FROM mission_route_principals WHERE mission_id=?')
        .get(id) as Record<string, unknown> | undefined;
      if (earlier) {
        if (earlier.tenant_id !== owner.tenantId || earlier.principal_id !== owner.principalId) {
          throw new MissionError(403, 'mission_principal_mismatch');
        }
        return;
      }
      this.db.prepare('INSERT INTO mission_route_principals(mission_id,tenant_id,principal_id) VALUES(?,?,?)')
        .run(id, owner.tenantId, owner.principalId);
      this.event(id, 'daming', 'route.principal.synthetic', '已绑定合成租户身份；不代表真实用户所有权');
    });
  }

  /** Host-only fixture claim. NOT an account ownership proof for production. */
  claimSyntheticRouteAccount(
    owner: { tenantId: string; principalId: string }, binding: MagpiePinnedBinding
  ): void {
    assertRoutePrincipal(owner);
    if (!/^[a-f0-9]{32}$/i.test(binding.instanceId) ||
        !/^[a-z0-9][a-z0-9._/-]{0,99}$/i.test(binding.providerId) ||
        !/^[a-f0-9]{10}$/i.test(binding.accountRef)) {
      throw new MissionError(400, 'invalid_synthetic_account_binding');
    }
    this.transaction(() => {
      const earlier = this.db.prepare(
        'SELECT * FROM mission_route_account_claims WHERE instance_id=? AND provider_id=? AND account_ref=?'
      ).get(binding.instanceId, binding.providerId, binding.accountRef) as Record<string, unknown> | undefined;
      if (earlier) {
        if (earlier.revoked_at || earlier.tenant_id !== owner.tenantId ||
            earlier.principal_id !== owner.principalId) throw new MissionError(403, 'account_claim_owner_mismatch');
        return;
      }
      this.db.prepare(
        'INSERT INTO mission_route_account_claims(instance_id,provider_id,account_ref,tenant_id,principal_id,proof) ' +
        "VALUES(?,?,?,?,?,'synthetic_fixture')"
      ).run(binding.instanceId, binding.providerId, binding.accountRef, owner.tenantId, owner.principalId);
    });
  }

  revokeSyntheticRouteAccount(
    owner: { tenantId: string; principalId: string }, binding: MagpiePinnedBinding
  ): void {
    assertRoutePrincipal(owner);
    this.transaction(() => {
      const updated = this.db.prepare(
        'UPDATE mission_route_account_claims SET revoked_at=? WHERE instance_id=? AND provider_id=? ' +
        'AND account_ref=? AND tenant_id=? AND principal_id=? AND revoked_at IS NULL'
      ).run(iso(), binding.instanceId, binding.providerId, binding.accountRef, owner.tenantId, owner.principalId);
      if (updated.changes !== 1) throw new MissionError(403, 'account_claim_owner_mismatch');
    });
  }

  routeReceipts(id: string): MissionRouteReceiptView[] {
    this.row(id);
    const rows = this.db.prepare(
      'SELECT r.*,a.budget_envelope_minor FROM mission_route_receipts r ' +
      'JOIN mission_route_attempts a ON r.attempt_id=a.id WHERE r.mission_id=? ' +
      'ORDER BY r.started_at,r.attempt_id LIMIT 50'
    ).all(id) as Record<string, unknown>[];
    return rows.map((r) => ({
      attemptId: String(r.attempt_id),
      state: String(r.state) as MissionRouteReceiptView['state'],
      priceBasisId: String(r.price_basis_id),
      priceCeilingMinor: Number(r.price_ceiling_minor),
      reservedEnvelopeMinor: Number(r.budget_envelope_minor),
      observedCashMinor: r.actual_cash_minor === null ? null : Number(r.actual_cash_minor),
      inputTokens: r.input_tokens === null ? null : Number(r.input_tokens),
      outputTokens: r.output_tokens === null ? null : Number(r.output_tokens),
      startedAt: String(r.started_at),
      completedAt: r.completed_at === null ? null : String(r.completed_at),
      vendorInvoiceVerified: false as const,
      productionDispatchEnabled: false as const
    }));
  }

  /**
   * OFFLINE FIXTURE ONLY: durable unknown-intent marker in the same SQLite
   * journal as the reservation, BEFORE any synthetic network side effect.
   * A second call never creates a send permit. No production execution API
   * is connected to this method.
   */
  beginSyntheticPossibleSend(
    id: string, attemptId: string, owner: { tenantId: string; principalId: string },
    catalog: MagpieRoutingCatalog, basis: SyntheticRoutePriceBasis
  ): MissionRouteReceiptView {
    assertId(id);
    assertId(attemptId);
    assertRoutePrincipal(owner);
    return this.transaction(() => {
      const binding = this.routeBinding(id);
      if (!binding || !this.preflightRoute(id, catalog).accountBindingValid) {
        throw new MissionError(409, 'route_binding_changed_or_expired');
      }
      const principal = this.db.prepare('SELECT * FROM mission_route_principals WHERE mission_id=?')
        .get(id) as Record<string, unknown> | undefined;
      if (!principal || principal.tenant_id !== owner.tenantId ||
          principal.principal_id !== owner.principalId) {
        throw new MissionError(403, 'mission_principal_not_verified');
      }
      const claim = this.db.prepare(
        'SELECT * FROM mission_route_account_claims WHERE instance_id=? AND provider_id=? ' +
        'AND account_ref=? AND tenant_id=? AND principal_id=? AND proof=? AND revoked_at IS NULL'
      ).get(binding.instanceId, binding.providerId, binding.accountRef,
        owner.tenantId, owner.principalId, 'synthetic_fixture');
      if (!claim) throw new MissionError(403, 'route_account_ownership_unverified');
      const attempt = this.db.prepare(
        'SELECT * FROM mission_route_attempts WHERE id=? AND mission_id=?'
      ).get(attemptId, id) as Record<string, unknown> | undefined;
      if (!attempt || attempt.state !== 'prepared') {
        throw new MissionError(409, 'route_attempt_not_prepared');
      }
      if (this.db.prepare('SELECT 1 FROM mission_route_receipts WHERE attempt_id=?').get(attemptId)) {
        throw new MissionError(409, 'route_attempt_may_have_been_sent');
      }
      const quote = quoteSyntheticRouteCeiling(basis, {
        providerId: binding.providerId, modelId: binding.modelId,
        outputTokens: Number(attempt.output_token_ceiling)
      });
      if (quote.ceilingMinor > Number(attempt.budget_envelope_minor)) {
        throw new MissionError(409, 'route_price_exceeds_held_envelope');
      }
      this.db.prepare(
        'INSERT INTO mission_route_receipts(attempt_id,mission_id,state,price_basis_id,' +
        'price_ceiling_minor,maximum_input_tokens,started_at) VALUES(?,?,?,?,?,?,?)'
      ).run(attemptId, id, 'unknown_after_send', quote.priceBasisId, quote.ceilingMinor,
        basis.maximumInputTokens, iso());
      this.event(id, 'magpie', 'route.send.unknown',
        '合成请求在可能发送前已持久化未知状态；费用信封冻结且禁止自动重试', 'router');
      return this.routeReceipts(id).find((r) => r.attemptId === attemptId)!;
    });
  }

  /**
   * Host-only synthetic evidence. No vendor invoice means no production
   * settlement and NEVER releases the original cash envelope or request slot.
   */
  reconcileSyntheticReceipt(
    id: string, attemptId: string, owner: { tenantId: string; principalId: string },
    evidence: { readonly evidenceRef: string; readonly inputTokens: number;
      readonly outputTokens: number; readonly cashMinor: number }
  ): MissionRouteReceiptView {
    assertId(id);
    assertId(attemptId);
    assertRoutePrincipal(owner);
    if (!evidence || typeof evidence.evidenceRef !== 'string' ||
        !/^fixture:[a-f0-9-]{36}$/i.test(evidence.evidenceRef) ||
        !Number.isSafeInteger(evidence.inputTokens) || evidence.inputTokens < 0 ||
        !Number.isSafeInteger(evidence.outputTokens) || evidence.outputTokens < 0 ||
        !Number.isSafeInteger(evidence.cashMinor) || evidence.cashMinor < 0 ||
        evidence.cashMinor > 1000000000) throw new MissionError(400, 'synthetic_receipt_invalid');
    return this.transaction(() => {
      this.row(id);
      const principal = this.db.prepare('SELECT * FROM mission_route_principals WHERE mission_id=?')
        .get(id) as Record<string, unknown> | undefined;
      if (!principal || principal.tenant_id !== owner.tenantId ||
          principal.principal_id !== owner.principalId) throw new MissionError(403, 'mission_principal_not_verified');
      const row = this.db.prepare(
        'SELECT r.*,a.output_token_ceiling,a.budget_envelope_minor FROM mission_route_receipts r ' +
        'JOIN mission_route_attempts a ON a.id=r.attempt_id WHERE r.attempt_id=? AND r.mission_id=?'
      ).get(attemptId, id) as Record<string, unknown> | undefined;
      if (!row) throw new MissionError(404, 'route_receipt_not_found');
      if (row.state !== 'unknown_after_send') {
        if (row.evidence_ref === evidence.evidenceRef && row.actual_cash_minor === evidence.cashMinor &&
            row.input_tokens === evidence.inputTokens && row.output_tokens === evidence.outputTokens) {
          return this.routeReceipts(id).find((v) => v.attemptId === attemptId)!;
        }
        throw new MissionError(409, 'route_receipt_conflict');
      }
      const duplicate = this.db.prepare(
        'SELECT attempt_id FROM mission_route_receipts WHERE evidence_ref=? LIMIT 1'
      ).get(evidence.evidenceRef) as { attempt_id: string } | undefined;
      if (duplicate && duplicate.attempt_id !== attemptId) {
        throw new MissionError(409, 'route_receipt_evidence_reused');
      }
      const breached = evidence.cashMinor > Number(row.budget_envelope_minor) ||
        evidence.cashMinor > Number(row.price_ceiling_minor) ||
        evidence.inputTokens > Number(row.maximum_input_tokens) ||
        evidence.outputTokens > Number(row.output_token_ceiling);
      const state = breached ? 'breached_synthetic' : 'settled_synthetic';
      this.db.prepare(
        'UPDATE mission_route_receipts SET state=?,completed_at=?,actual_cash_minor=?,' +
        'input_tokens=?,output_tokens=?,evidence_ref=? WHERE attempt_id=? AND state=?'
      ).run(state, iso(), evidence.cashMinor, evidence.inputTokens,
        evidence.outputTokens, evidence.evidenceRef, attemptId, 'unknown_after_send');
      this.event(id, 'magpie', breached ? 'route.receipt.breached.synthetic' : 'route.receipt.settled.synthetic',
        breached ? '模拟计费超过预留或 Token 上限，后续请求冻结' :
          '合成账本已核对，但不能当作真实供应商账单或释放费用信封', 'router');
      return this.routeReceipts(id).find((v) => v.attemptId === attemptId)!;
    });
  }

  close(): void { this.db.close(); }
}
