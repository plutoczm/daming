import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runIsolatedTenantInspect } from './tenant-sandbox.ts';

/**
 * App-owned threads, runs and execution graph, adapted from T3 Code V2's
 * architecture (original implementation, not imported code).
 * Magpie target IDs are PLAN REFERENCES. The only enabled adapter is an
 * offline, network-denied WSL worker; no paid provider can be invoked.
 */
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const TARGET = /^(?:unbound|[a-z0-9][a-z0-9._:/+-]{0,159})$/i;
const DRIVER = 'offline-wsl-sandbox' as const;
type Row = Record<string, unknown>;
export type ChildRole = 'research' | 'analysis';
export type RootState = 'running' | 'waiting_approval' | 'blocked' | 'interrupted' | 'completed' | 'cancelled';
export type ChildState = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
export class AgentGraphError extends Error {
  readonly status: number;
  constructor(status: number, reason: string) { super(reason); this.status = status; }
}
export interface OfflineAgentDriver {
  readonly kind: typeof DRIVER;
  execute(input: { role: ChildRole; goal: string; plannedTarget: string;
    signal: AbortSignal }): Promise<string>;
}
export const sandboxAgentDriver: OfflineAgentDriver = {
  kind: DRIVER,
  async execute(input) {
    if (input.signal.aborted) throw new Error('offline_cancelled');
    const evidence = await runIsolatedTenantInspect(input.goal, {
      timeoutMs: 12000, signal: input.signal
    });
    if (input.signal.aborted) throw new Error('offline_cancelled');
    return (input.role === 'research' ? '资料梳理' : '方案对比') +
      '：独立离线沙箱处理 ' + evidence.inspectedCharacters + ' 字符、' +
      evidence.inspectedUtf8Bytes + ' 字节、' + evidence.lineCount +
      ' 行。未调用 Magpie、LLM、Agent 账号或插件。';
  }
};
export interface GraphNode {
  nodeId: string; threadId: string; runId: string; rootNodeId: string;
  parentNodeId: string | null; kind: 'root_turn' | 'subagent';
  role: 'root' | ChildRole; status: string;
  plannedMagpieTarget: string | null; actualDriver: typeof DRIVER | null;
  providerThreadId: null; summary: string | null;
}
export interface GraphEvent {
  sequence: number; nodeId: string | null; event: string; summary: string; at: string;
}
export interface AgentGraph {
  graphVersion: 1; missionId: string; tenantId: string; rootRunId: string;
  status: RootState;
  threads: { threadId: string; parentThreadId: string | null;
    rootThreadId: string; role: 'root' | ChildRole; kind: 'root' | 'subagent' }[];
  runs: { runId: string; threadId: string; rootRunId: string;
    parentRunId: string | null; role: 'root' | ChildRole; status: string;
    countsForConversation: boolean }[];
  nodes: GraphNode[]; events: GraphEvent[];
  transfers: { transferId: string; fromNodeId: string; toNodeId: string;
    kind: 'subagent_result'; summary: string }[];
  parentRequiresExplicitCompletion: true;
  paidDispatchPermitted: false; plannedRoutesNotExecuted: true;
  capabilities: { adapter: typeof DRIVER; parallelChildren: true;
    durableLineage: true; cancellation: true; explicitApproval: true;
    providerModelExecution: false };
}
export interface LaunchAgentGraph {
  tenantId: string; missionId: string; userId: string; requestId: string;
  goal: string; plannedTargets: Partial<Record<ChildRole, string>>;
}
const iso = (ms: number) => new Date(ms).toISOString();
const validId = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const safeSummary = (v: string) =>
  v.replace(/[\r\n\t\0-\x1f]/g, ' ')
   .replace(/\b(?:sk-|key_|ghp_|Bearer\s+)[a-z0-9_-]{8,}\b/gi, '[redacted]')
   .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, '[redacted-email]')
   .slice(0, 240);

export class AgentOrchestrator {
  private readonly db: DatabaseSync;
  private readonly clock: () => number;
  private readonly driver: OfflineAgentDriver;
  private readonly onChanged: () => void;
  private readonly active = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private closing = false;

  constructor(directory: string, opts: { clock?: () => number; driver?: OfflineAgentDriver;
    onChanged?: () => void } = {}) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, 'agent-graph.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;' +
      'PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS app_threads(' +
      'id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,mission_id TEXT NOT NULL,' +
      'parent_thread_id TEXT,root_thread_id TEXT NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS agent_runs(' +
      'id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES app_threads(id),' +
      'tenant_id TEXT NOT NULL,mission_id TEXT NOT NULL,root_run_id TEXT NOT NULL,' +
      'parent_run_id TEXT,request_id TEXT,role TEXT NOT NULL,status TEXT NOT NULL,' +
      'counts_for_conversation INTEGER NOT NULL,goal TEXT,created_ms INTEGER NOT NULL,updated_ms INTEGER NOT NULL);' +
      'CREATE UNIQUE INDEX IF NOT EXISTS agent_request_once ON agent_runs(tenant_id,request_id)' +
      ' WHERE request_id IS NOT NULL;' +
      'CREATE INDEX IF NOT EXISTS agent_mission_runs ON agent_runs(tenant_id,mission_id,created_ms);' +
      'CREATE TABLE IF NOT EXISTS execution_nodes(' +
      'id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,thread_id TEXT NOT NULL,' +
      'run_id TEXT NOT NULL REFERENCES agent_runs(id),root_run_id TEXT NOT NULL,' +
      'parent_node_id TEXT,root_node_id TEXT NOT NULL,kind TEXT NOT NULL,role TEXT NOT NULL,' +
      'status TEXT NOT NULL,target_id TEXT,actual_driver TEXT,summary TEXT,updated_ms INTEGER NOT NULL);' +
      'CREATE INDEX IF NOT EXISTS execution_nodes_root ON execution_nodes(root_run_id,role);' +
      'CREATE TABLE IF NOT EXISTS graph_events(' +
      'sequence INTEGER PRIMARY KEY AUTOINCREMENT,tenant_id TEXT NOT NULL,root_run_id TEXT NOT NULL,' +
      'node_id TEXT,event_type TEXT NOT NULL,summary TEXT NOT NULL,occurred_ms INTEGER NOT NULL);' +
      'CREATE INDEX IF NOT EXISTS graph_events_root ON graph_events(root_run_id,sequence);' +
      'CREATE TABLE IF NOT EXISTS context_transfers(' +
      'id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,root_run_id TEXT NOT NULL,' +
      'from_node_id TEXT NOT NULL,to_node_id TEXT NOT NULL,' +
      'kind TEXT NOT NULL,summary TEXT NOT NULL,created_ms INTEGER NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS graph_commands(' +
      'tenant_id TEXT NOT NULL,request_id TEXT NOT NULL,root_run_id TEXT NOT NULL,' +
      'action TEXT NOT NULL,created_ms INTEGER NOT NULL,PRIMARY KEY(tenant_id,request_id));'
    );
    this.clock = opts.clock ?? Date.now;
    this.driver = opts.driver ?? sandboxAgentDriver;
    this.onChanged = opts.onChanged ?? (() => undefined);
    if (this.driver.kind !== DRIVER) throw new Error('real_provider_driver_not_enabled');
    this.reconcile();
  }

  private tx<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      this.onChanged();
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private event(tenant: string, rootRun: string, node: string | null,
    kind: string, summary: string): void {
    this.db.prepare('INSERT INTO graph_events(tenant_id,root_run_id,node_id,' +
      'event_type,summary,occurred_ms) VALUES(?,?,?,?,?,?)')
      .run(tenant, rootRun, node, kind, safeSummary(summary), this.clock());
  }
  private root(runId: string, tenant: string): Row {
    if (!validId(runId) || !validId(tenant)) {
      throw new AgentGraphError(404, 'agent_run_not_found');
    }
    const row = this.db.prepare('SELECT * FROM agent_runs WHERE id=? AND tenant_id=? ' +
      'AND parent_run_id IS NULL').get(runId, tenant) as Row | undefined;
    if (!row) throw new AgentGraphError(404, 'agent_run_not_found');
    return row;
  }
  private reconcile(): void {
    // Running work has unknown effects on crash: NEVER auto-send it again.
    this.tx(() => {
      const rows = this.db.prepare("SELECT id,tenant_id FROM agent_runs " +
        "WHERE parent_run_id IS NULL AND status='running'").all() as Row[];
      for (const row of rows) {
        const root = String(row.id), tenant = String(row.tenant_id), now = this.clock();
        this.db.prepare("UPDATE agent_runs SET status='interrupted',updated_ms=?" +
          " WHERE root_run_id=? AND status IN ('running','queued')")
          .run(now, root);
        this.db.prepare("UPDATE execution_nodes SET status='interrupted',updated_ms=?" +
          " WHERE root_run_id=? AND status IN ('running','queued')")
          .run(now, root);
        this.event(tenant, root, null, 'root.interrupted',
          '重启发现未完成执行；禁止自动重试');
      }
    });
  }

  /** Writes all app-owned IDs and child work records in one transaction. */
  create(input: LaunchAgentGraph): AgentGraph {
    if (this.closing) throw new AgentGraphError(503, 'agent_runtime_stopping');
    if (!input || !validId(input.tenantId) || !validId(input.missionId) ||
        !validId(input.userId) || !validId(input.requestId) ||
        typeof input.goal !== 'string' || !input.goal.trim() ||
        input.goal.length > 1500 ||
        Object.keys(input.plannedTargets ?? {}).some(k => k !== 'research' && k !== 'analysis') ||
        (['research','analysis'] as const).some(role => {
          const t = input.plannedTargets?.[role] ?? 'unbound';
          return typeof t !== 'string' || !TARGET.test(t) ||
            t.includes('..') || t.includes('://');
        })) {
      throw new AgentGraphError(400, 'agent_graph_input_invalid');
    }
    const previous = this.db.prepare(
      'SELECT * FROM agent_runs WHERE tenant_id=? AND request_id=?'
    ).get(input.tenantId, input.requestId) as Row | undefined;
    if (previous) {
      if (previous.mission_id !== input.missionId || previous.goal !== input.goal) {
        throw new AgentGraphError(409, 'agent_request_id_conflict');
      }
      return this.graph(String(previous.id), input.tenantId);
    }
    const runId = this.tx(() => {
      const inFlight = this.db.prepare(
        "SELECT 1 FROM agent_runs WHERE tenant_id=? AND mission_id=? AND " +
        "parent_run_id IS NULL AND status IN ('running','waiting_approval') LIMIT 1"
      ).get(input.tenantId, input.missionId);
      if (inFlight) throw new AgentGraphError(409, 'agent_run_already_active');
      const count = this.db.prepare("SELECT COUNT(*) n FROM agent_runs WHERE tenant_id=? " +
        "AND parent_run_id IS NULL AND status='running'")
        .get(input.tenantId) as { n: number };
      if (count.n >= 3) throw new AgentGraphError(429, 'tenant_parallel_run_limit');
      const thread = randomUUID(), run = randomUUID(), node = randomUUID();
      const now = this.clock();
      this.db.prepare(
        "INSERT INTO app_threads(id,tenant_id,mission_id,parent_thread_id,root_thread_id,role,kind)" +
        " VALUES(?,?,?,NULL,?,'root','root')"
      ).run(thread, input.tenantId, input.missionId, thread);
      this.db.prepare(
        'INSERT INTO agent_runs(id,thread_id,tenant_id,mission_id,root_run_id,' +
        'parent_run_id,request_id,role,status,counts_for_conversation,goal,created_ms,updated_ms)' +
        " VALUES(?,?,?,?,?,NULL,?,'root','running',1,?,?,?)"
      ).run(run, thread, input.tenantId, input.missionId, run,
        input.requestId, input.goal, now, now);
      this.db.prepare(
        'INSERT INTO execution_nodes(id,tenant_id,thread_id,run_id,root_run_id,' +
        'parent_node_id,root_node_id,kind,role,status,target_id,actual_driver,summary,updated_ms)' +
        " VALUES(?,?,?,?,?,NULL,?,'root_turn','root','running',NULL,NULL,NULL,?)"
      ).run(node, input.tenantId, thread, run, run, node, now);
      for (const role of ['research','analysis'] as const) {
        const childThread = randomUUID(), childRun = randomUUID(), childNode = randomUUID();
        this.db.prepare(
          'INSERT INTO app_threads(id,tenant_id,mission_id,parent_thread_id,root_thread_id,role,kind)' +
          " VALUES(?,?,?,?,?,?,'subagent')"
        ).run(childThread, input.tenantId, input.missionId, thread, thread, role);
        this.db.prepare(
          'INSERT INTO agent_runs(id,thread_id,tenant_id,mission_id,root_run_id,' +
          'parent_run_id,request_id,role,status,counts_for_conversation,goal,created_ms,updated_ms)' +
          " VALUES(?,?,?,?,?,?,NULL,?,'queued',0,NULL,?,?)"
        ).run(childRun, childThread, input.tenantId, input.missionId, run,
          run, role, now, now);
        this.db.prepare(
          'INSERT INTO execution_nodes(id,tenant_id,thread_id,run_id,root_run_id,' +
          'parent_node_id,root_node_id,kind,role,status,target_id,actual_driver,summary,updated_ms)' +
          " VALUES(?,?,?,?,?,?,?,'subagent',?,'queued',?,?,NULL,?)"
        ).run(childNode, input.tenantId, childThread, childRun, run, node,
          node, role, input.plannedTargets?.[role] ?? 'unbound', DRIVER, now);
        this.event(input.tenantId, run, childNode, 'subagent.queued',
          role + ' 已排队（Magpie 仅作路由计划）');
      }
      this.db.prepare(
        'INSERT INTO graph_commands(tenant_id,request_id,root_run_id,action,created_ms)' +
        " VALUES(?,?,?,'launch',?)"
      ).run(input.tenantId, input.requestId, run, now);
      this.event(input.tenantId, run, node, 'root.started',
        '父任务启动；等待两个独立离线执行分支');
      return run;
    });
    return this.graph(runId, input.tenantId);
  }

  latest(missionId: string, tenantId: string): AgentGraph | null {
    if (!validId(missionId) || !validId(tenantId)) {
      throw new AgentGraphError(404, 'agent_graph_not_found');
    }
    const record = this.db.prepare(
      'SELECT id FROM agent_runs WHERE tenant_id=? AND mission_id=? ' +
      'AND parent_run_id IS NULL ORDER BY created_ms DESC,rowid DESC LIMIT 1'
    ).get(tenantId, missionId) as { id: string } | undefined;
    return record ? this.graph(record.id, tenantId) : null;
  }

  graph(runId: string, tenantId: string): AgentGraph {
    const root = this.root(runId, tenantId);
    const runs = this.db.prepare(
      'SELECT * FROM agent_runs WHERE root_run_id=? AND tenant_id=? ' +
      'ORDER BY counts_for_conversation DESC,role'
    ).all(runId, tenantId) as Row[];
    const threads = this.db.prepare(
      'SELECT * FROM app_threads WHERE tenant_id=? AND id IN(' +
      'SELECT thread_id FROM agent_runs WHERE root_run_id=? AND tenant_id=?)'
    ).all(tenantId, runId, tenantId) as Row[];
    const nodes = this.db.prepare(
      "SELECT * FROM execution_nodes WHERE root_run_id=? AND tenant_id=? " +
      "ORDER BY CASE WHEN kind='root_turn' THEN 0 ELSE 1 END,role"
    ).all(runId, tenantId) as Row[];
    const events = this.db.prepare(
      'SELECT * FROM (SELECT * FROM graph_events WHERE root_run_id=? ' +
      'AND tenant_id=? ORDER BY sequence DESC LIMIT 120) ORDER BY sequence'
    ).all(runId, tenantId) as Row[];
    const transfers = this.db.prepare(
      'SELECT * FROM context_transfers WHERE root_run_id=? AND tenant_id=? ORDER BY created_ms'
    ).all(runId, tenantId) as Row[];
    return {
      graphVersion: 1, missionId: String(root.mission_id), tenantId,
      rootRunId: runId, status: root.status as RootState,
      threads: threads.map(t => ({
        threadId: String(t.id),
        parentThreadId: t.parent_thread_id == null ? null : String(t.parent_thread_id),
        rootThreadId: String(t.root_thread_id), role: String(t.role) as 'root' | ChildRole,
        kind: String(t.kind) as 'root' | 'subagent'
      })),
      runs: runs.map(r => ({
        runId: String(r.id), threadId: String(r.thread_id),
        rootRunId: String(r.root_run_id),
        parentRunId: r.parent_run_id == null ? null : String(r.parent_run_id),
        role: String(r.role) as 'root' | ChildRole, status: String(r.status),
        countsForConversation: Number(r.counts_for_conversation) === 1
      })),
      nodes: nodes.map(n => ({
        nodeId: String(n.id), threadId: String(n.thread_id), runId: String(n.run_id),
        rootNodeId: String(n.root_node_id),
        parentNodeId: n.parent_node_id == null ? null : String(n.parent_node_id),
        kind: String(n.kind) as GraphNode['kind'],
        role: String(n.role) as GraphNode['role'], status: String(n.status),
        plannedMagpieTarget: n.target_id == null ? null : String(n.target_id),
        actualDriver: n.actual_driver == null ? null : DRIVER,
        providerThreadId: null,
        summary: n.summary == null ? null : String(n.summary)
      })),
      events: events.map(e => ({
        sequence: Number(e.sequence),
        nodeId: e.node_id == null ? null : String(e.node_id),
        event: String(e.event_type), summary: String(e.summary),
        at: iso(Number(e.occurred_ms))
      })),
      transfers: transfers.map(t => ({
        transferId: String(t.id), fromNodeId: String(t.from_node_id),
        toNodeId: String(t.to_node_id), kind: 'subagent_result',
        summary: String(t.summary)
      })),
      parentRequiresExplicitCompletion: true,
      paidDispatchPermitted: false, plannedRoutesNotExecuted: true,
      capabilities: { adapter: DRIVER, parallelChildren: true,
        durableLineage: true, cancellation: true, explicitApproval: true,
        providerModelExecution: false }
    };
  }

  /** Exactly two independent child threads run concurrently; child completion
   * only advances the parent to WAITING, never completes a user-visible turn. */
  dispatch(runId: string, tenantId: string): Promise<void> {
    if (this.closing) return Promise.resolve();
    this.root(runId, tenantId);
    const previous = this.active.get(runId);
    if (previous) return previous;
    const work = (async () => {
      const root = this.root(runId, tenantId);
      if (root.status !== 'running') return;
      const children = this.db.prepare(
        "SELECT id FROM execution_nodes WHERE tenant_id=? AND root_run_id=? " +
        "AND kind='subagent' AND status='queued' ORDER BY role"
      ).all(tenantId, runId) as { id: string }[];
      await Promise.all(children.map(c => this.executeChild(c.id, runId, tenantId)));
    })().finally(() => { this.active.delete(runId); });
    this.active.set(runId, work);
    return work;
  }

  private async executeChild(nodeId: string, rootRunId: string, tenantId: string): Promise<void> {
    const claimed = this.tx(() => {
      const root = this.root(rootRunId, tenantId);
      const child = this.db.prepare(
        "SELECT * FROM execution_nodes WHERE id=? AND tenant_id=? AND status='queued'"
      ).get(nodeId, tenantId) as Row | undefined;
      if (!child || root.status !== 'running') return null;
      const now = this.clock();
      this.db.prepare("UPDATE execution_nodes SET status='running',updated_ms=? WHERE id=?")
        .run(now, nodeId);
      this.db.prepare("UPDATE agent_runs SET status='running',updated_ms=? WHERE id=?")
        .run(now, String(child.run_id));
      this.event(tenantId, rootRunId, nodeId, 'subagent.running',
        '启动无网络隔离 Worker，未执行 Magpie 路由');
      return {
        role: String(child.role) as ChildRole, goal: String(root.goal),
        plannedTarget: String(child.target_id), childRunId: String(child.run_id)
      };
    });
    if (!claimed) return;
    const controller = new AbortController();
    this.controllers.set(nodeId, controller);
    let state: ChildState = 'completed', summary: string;
    try {
      summary = safeSummary(await this.driver.execute({
        role: claimed.role, goal: claimed.goal,
        plannedTarget: claimed.plannedTarget, signal: controller.signal
      }));
      if (!summary) throw new Error('empty_offline_result');
    } catch {
      state = controller.signal.aborted ? 'interrupted' : 'failed';
      summary = state === 'failed'
        ? '离线 Worker 未获得有效结果；需人工重新发起新运行'
        : '离线 Worker 已中断，执行结果不确定';
    } finally { this.controllers.delete(nodeId); }
    this.tx(() => {
      const root = this.root(rootRunId, tenantId);
      const child = this.db.prepare(
        'SELECT * FROM execution_nodes WHERE id=? AND tenant_id=?'
      ).get(nodeId, tenantId) as Row | undefined;
      // Cancellation/restart wins over late results; never resurrect a run.
      if (root.status !== 'running' || child?.status !== 'running') return;
      const now = this.clock();
      this.db.prepare('UPDATE execution_nodes SET status=?,summary=?,updated_ms=? WHERE id=?')
        .run(state, summary, now, nodeId);
      this.db.prepare('UPDATE agent_runs SET status=?,updated_ms=? WHERE id=?')
        .run(state, now, claimed.childRunId);
      if (state === 'completed') {
        const rootNode = this.db.prepare(
          "SELECT id FROM execution_nodes WHERE root_run_id=? AND kind='root_turn'"
        ).get(rootRunId) as { id: string };
        this.db.prepare(
          'INSERT INTO context_transfers(id,tenant_id,root_run_id,from_node_id,' +
          "to_node_id,kind,summary,created_ms) VALUES(?,?,?,?,?,'subagent_result',?,?)"
        ).run(randomUUID(), tenantId, rootRunId, nodeId, rootNode.id, summary, now);
      }
      this.event(tenantId, rootRunId, nodeId, 'subagent.' + state, summary);
      const pending = this.db.prepare(
        "SELECT COUNT(*) n FROM execution_nodes WHERE root_run_id=? AND kind='subagent' " +
        "AND status IN ('queued','running')"
      ).get(rootRunId) as { n: number };
      if (Number(pending.n) !== 0) return;
      const failures = this.db.prepare(
        "SELECT COUNT(*) n FROM execution_nodes WHERE root_run_id=? AND kind='subagent' " +
        "AND status<>'completed'"
      ).get(rootRunId) as { n: number };
      const next: RootState = Number(failures.n) ? 'blocked' : 'waiting_approval';
      this.db.prepare('UPDATE agent_runs SET status=?,updated_ms=? WHERE id=?')
        .run(next, now, rootRunId);
      this.db.prepare(
        "UPDATE execution_nodes SET status=?,updated_ms=? WHERE root_run_id=? AND kind='root_turn'"
      ).run(next, now, rootRunId);
      this.event(tenantId, rootRunId, null, next === 'waiting_approval'
        ? 'root.waiting_approval' : 'root.blocked',
        next === 'waiting_approval'
          ? '两名子 Agent 已完成并将结果交给父节点；等待人工确认'
          : '至少一名子 Agent 未成功，禁止批准父任务');
    });
  }

  decide(tenantId: string, runId: string, requestId: string,
    action: 'approve' | 'cancel'): AgentGraph {
    if (!validId(requestId) || !['approve','cancel'].includes(action)) {
      throw new AgentGraphError(400, 'agent_decision_invalid');
    }
    this.tx(() => {
      const root = this.root(runId, tenantId);
      const receipt = this.db.prepare(
        'SELECT * FROM graph_commands WHERE tenant_id=? AND request_id=?'
      ).get(tenantId, requestId) as Row | undefined;
      if (receipt) {
        if (receipt.root_run_id !== runId || receipt.action !== action) {
          throw new AgentGraphError(409, 'agent_command_request_conflict');
        }
        return;
      }
      if (action === 'approve' && root.status !== 'waiting_approval') {
        throw new AgentGraphError(409, 'agent_children_not_ready');
      }
      if (action === 'cancel' &&
          !['running','waiting_approval','blocked','interrupted'].includes(String(root.status))) {
        throw new AgentGraphError(409, 'agent_run_not_cancellable');
      }
      if (action === 'approve' && this.db.prepare(
        "SELECT 1 FROM execution_nodes WHERE root_run_id=? AND kind='subagent' " +
        "AND status<>'completed' LIMIT 1"
      ).get(runId)) throw new AgentGraphError(409, 'agent_child_not_complete');
      const next = action === 'approve' ? 'completed' : 'cancelled';
      const now = this.clock();
      this.db.prepare('UPDATE agent_runs SET status=?,updated_ms=? WHERE id=?')
        .run(next, now, runId);
      this.db.prepare(
        "UPDATE execution_nodes SET status=?,updated_ms=? WHERE root_run_id=? AND kind='root_turn'"
      ).run(next, now, runId);
      if (action === 'cancel') {
        this.db.prepare(
          "UPDATE agent_runs SET status='cancelled',updated_ms=? WHERE root_run_id=? " +
          "AND parent_run_id IS NOT NULL AND status IN ('queued','running')"
        ).run(now, runId);
        this.db.prepare(
          "UPDATE execution_nodes SET status='cancelled',updated_ms=? WHERE root_run_id=? " +
          "AND kind='subagent' AND status IN ('queued','running')"
        ).run(now, runId);
      }
      this.db.prepare(
        'INSERT INTO graph_commands(tenant_id,request_id,root_run_id,action,created_ms)' +
        ' VALUES(?,?,?,?,?)'
      ).run(tenantId, requestId, runId, action, now);
      this.event(tenantId, runId, null,
        action === 'approve' ? 'root.completed' : 'root.cancelled',
        action === 'approve'
          ? '人类确认父任务完成；子任务结果此前已持久化'
          : '人工取消父任务；未完成的子工作作废');
    });
    if (action === 'cancel') {
      const children = this.db.prepare(
        "SELECT id FROM execution_nodes WHERE root_run_id=? AND kind='subagent'"
      ).all(runId) as { id: string }[];
      for (const child of children) this.controllers.get(child.id)?.abort();
    }
    return this.graph(runId, tenantId);
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.active.values()]);
    this.reconcile();
    this.db.close();
  }
}
