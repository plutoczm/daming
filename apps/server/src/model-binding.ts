import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentTarget, AvailableModelsView, BindModelInputView, ModelBindingScopeView, ModelBindingView
} from '@daming/contracts';

/**
 * S5 选模型 → 选 Agent → 持久绑定 → 派工注入。
 * - 绑定按租户隔离并可撤销；写入 SQLite，重启保留。
 * - 只接受本租户统一目录内「可派工」的模型；不可用 / 额度耗尽被拒（AC-002-2/3）。
 * - resolveAgentRuntime 生成一次性运行配置（Codex 中继 model_provider / Claude ANTHROPIC_BASE_URL /
 *   DSH DEEPSEEK_BASE_URL），一次性 key 由 Host 注入的签发器提供，本模块不缓存明文。
 */
export class ModelBindingError extends Error {
  readonly status: number;
  constructor(status: number, reason: string) { super(reason); this.status = status; }
}

const AGENTS: readonly AgentTarget[] = ['dsh', 'codex', 'claude-code'];
const TENANT_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/i;
const MODEL_ID = /^[a-z0-9][a-z0-9._:/-]{0,159}$/i;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
type Row = Record<string, unknown>;

export interface OneTimeKey {
  readonly token: string;
  readonly baseUrl: string;
  readonly expiresMs: number;
}
export type OneTimeKeyIssuer = (binding: ModelBindingView) => OneTimeKey;

export interface AgentRuntimeConfig {
  readonly agent: AgentTarget;
  readonly modelId: string;
  readonly providerId: string;
  readonly billing: 'cash' | 'quota';
  readonly bindingId: string;
  readonly baseUrl: string;
  readonly expiresMs: number;
  /** sha256(token) 前缀，仅用于审计，绝不等于 token。 */
  readonly tokenRef: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface DispatchGate {
  readonly quotaRemainingPercent?: number;
  readonly budgetRemainingMinor: number;
  readonly requiredMinor: number;
}
export interface DispatchDeps {
  readonly store: ModelBindingStore;
  readonly issueKey: OneTimeKeyIssuer;
  readonly run: (runtime: AgentRuntimeConfig) => Promise<{ status: 'completed' | 'failed'; output: string }>;
}

function isAgent(value: unknown): value is AgentTarget {
  return typeof value === 'string' && (AGENTS as readonly string[]).includes(value);
}

export class ModelBindingStore {
  private readonly db: DatabaseSync;
  private readonly clock: () => number;

  constructor(dataDir: string, clock: () => number = Date.now) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dataDir, 'model-bindings.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS model_bindings(' +
      'binding_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent TEXT NOT NULL,' +
      'model_id TEXT NOT NULL, provider_id TEXT NOT NULL, source_kind TEXT NOT NULL,' +
      'billing TEXT NOT NULL, scope_kind TEXT NOT NULL, task_id TEXT,' +
      'status TEXT NOT NULL, created_ms INTEGER NOT NULL, revoked_ms INTEGER);' +
      'CREATE INDEX IF NOT EXISTS model_bindings_tenant ON model_bindings(tenant_id, agent, status);'
    );
    this.clock = clock;
  }
  close(): void { this.db.close(); }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private tenant(tenantId: unknown): string {
    if (typeof tenantId !== 'string' || !TENANT_ID.test(tenantId)) throw new ModelBindingError(400, 'tenant_id_invalid');
    return tenantId;
  }
  private scope(scope: unknown): ModelBindingScopeView {
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw new ModelBindingError(400, 'binding_scope_invalid');
    const value = scope as Record<string, unknown>;
    if (value.kind === 'tenant') {
      if (Object.keys(value).some((key) => key !== 'kind')) throw new ModelBindingError(400, 'binding_scope_invalid');
      return { kind: 'tenant' };
    }
    if (value.kind === 'task') {
      if (Object.keys(value).some((key) => key !== 'kind' && key !== 'taskId') ||
          typeof value.taskId !== 'string' || !TASK_ID.test(value.taskId)) {
        throw new ModelBindingError(400, 'binding_scope_invalid');
      }
      return { kind: 'task', taskId: value.taskId };
    }
    throw new ModelBindingError(400, 'binding_scope_invalid');
  }
  private view(row: Row): ModelBindingView {
    const kind = String(row.scope_kind);
    const scope: ModelBindingScopeView = kind === 'task'
      ? { kind: 'task', taskId: String(row.task_id) } : { kind: 'tenant' };
    return {
      bindingId: String(row.binding_id), tenantId: String(row.tenant_id),
      agent: String(row.agent) as AgentTarget, modelId: String(row.model_id),
      providerId: String(row.provider_id),
      sourceKind: String(row.source_kind) as ModelBindingView['sourceKind'],
      billing: String(row.billing) as ModelBindingView['billing'],
      scope, status: String(row.status) as ModelBindingView['status'],
      createdAt: new Date(Number(row.created_ms)).toISOString(),
      ...(row.revoked_ms === null || row.revoked_ms === undefined ? {} : { revokedAt: new Date(Number(row.revoked_ms)).toISOString() })
    };
  }
  private rowOf(tenantId: string, bindingId: string): Row | undefined {
    return this.db.prepare('SELECT * FROM model_bindings WHERE tenant_id=? AND binding_id=?')
      .get(tenantId, bindingId) as Row | undefined;
  }

  /** 绑定可用模型到指定 Agent。仅接受本租户目录中 dispatchable 的模型。 */
  bind(input: { tenantId: string } & BindModelInputView, catalog: AvailableModelsView): ModelBindingView {
    const tenantId = this.tenant(input?.tenantId);
    if (!catalog || catalog.tenantId !== tenantId || !Array.isArray(catalog.models)) {
      throw new ModelBindingError(403, 'catalog_tenant_mismatch');
    }
    const agent = input?.agent;
    if (!isAgent(agent)) throw new ModelBindingError(400, 'agent_invalid');
    if (typeof input?.modelId !== 'string' || !MODEL_ID.test(input.modelId)) throw new ModelBindingError(400, 'model_id_invalid');
    const scope = this.scope(input?.scope);
    const model = catalog.models.find((entry) => entry.modelId === input.modelId);
    if (!model) throw new ModelBindingError(409, 'model_unavailable');
    if (!model.dispatchable) {
      throw new ModelBindingError(409, model.reason === 'quota_exhausted' ? 'quota_exhausted' : 'model_not_dispatchable');
    }
    return this.transaction(() => {
      // 同一 Agent + 同一 scope 只保留一个 active 绑定；新绑定取代旧绑定。
      this.db.prepare(
        "UPDATE model_bindings SET status='revoked', revoked_ms=? WHERE tenant_id=? AND agent=? " +
        "AND status='active' AND scope_kind=? AND COALESCE(task_id,'')=COALESCE(?,'')"
      ).run(this.clock(), tenantId, agent, scope.kind, scope.taskId ?? null);
      const bindingId = randomUUID();
      const created = this.clock();
      this.db.prepare(
        'INSERT INTO model_bindings(binding_id,tenant_id,agent,model_id,provider_id,source_kind,billing,' +
        'scope_kind,task_id,status,created_ms,revoked_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'
      ).run(bindingId, tenantId, agent, model.modelId, model.providerId, model.sourceKind,
        model.billing, scope.kind, scope.taskId ?? null, 'active', created, null);
      return this.view(this.rowOf(tenantId, bindingId)!);
    });
  }

  revoke(tenantId: string, bindingId: string): ModelBindingView {
    const tenant = this.tenant(tenantId);
    if (typeof bindingId !== 'string' || !UUID.test(bindingId)) throw new ModelBindingError(404, 'binding_not_found');
    return this.transaction(() => {
      const row = this.rowOf(tenant, bindingId);
      if (!row) throw new ModelBindingError(404, 'binding_not_found');
      if (row.status === 'active') {
        this.db.prepare("UPDATE model_bindings SET status='revoked', revoked_ms=? WHERE tenant_id=? AND binding_id=? AND status='active'")
          .run(this.clock(), tenant, bindingId);
      }
      return this.view(this.rowOf(tenant, bindingId)!);
    });
  }

  get(tenantId: string, bindingId: string): ModelBindingView | undefined {
    const tenant = this.tenant(tenantId);
    if (typeof bindingId !== 'string' || !UUID.test(bindingId)) return undefined;
    const row = this.rowOf(tenant, bindingId);
    return row ? this.view(row) : undefined;
  }

  list(tenantId: string, agent?: AgentTarget): ModelBindingView[] {
    const tenant = this.tenant(tenantId);
    if (agent !== undefined && !isAgent(agent)) throw new ModelBindingError(400, 'agent_invalid');
    const rows = (agent === undefined
      ? this.db.prepare('SELECT * FROM model_bindings WHERE tenant_id=? ORDER BY created_ms DESC,binding_id DESC LIMIT 100').all(tenant)
      : this.db.prepare('SELECT * FROM model_bindings WHERE tenant_id=? AND agent=? ORDER BY created_ms DESC,binding_id DESC LIMIT 100').all(tenant, agent)) as Row[];
    return rows.map((row) => this.view(row));
  }

  /** 任务级绑定优先于租户级；仅返回本租户的 active 绑定。 */
  resolve(tenantId: string, agent: AgentTarget, options: { taskId?: string } = {}): ModelBindingView | undefined {
    const tenant = this.tenant(tenantId);
    if (!isAgent(agent)) throw new ModelBindingError(400, 'agent_invalid');
    if (options.taskId !== undefined) {
      if (typeof options.taskId !== 'string' || !TASK_ID.test(options.taskId)) throw new ModelBindingError(400, 'task_id_invalid');
      const taskRow = this.db.prepare(
        "SELECT * FROM model_bindings WHERE tenant_id=? AND agent=? AND status='active' " +
        "AND scope_kind='task' AND task_id=? ORDER BY created_ms DESC LIMIT 1"
      ).get(tenant, agent, options.taskId) as Row | undefined;
      if (taskRow) return this.view(taskRow);
    }
    const tenantRow = this.db.prepare(
      "SELECT * FROM model_bindings WHERE tenant_id=? AND agent=? AND status='active' " +
      "AND scope_kind='tenant' ORDER BY created_ms DESC LIMIT 1"
    ).get(tenant, agent) as Row | undefined;
    return tenantRow ? this.view(tenantRow) : undefined;
  }
}

/** 由 active 绑定 + 一次性 key 生成注入配置。key 不落库、不进审计，仅哈希前缀留痕。 */
export function resolveAgentRuntime(binding: ModelBindingView, issue: OneTimeKeyIssuer): AgentRuntimeConfig {
  if (!binding || binding.status !== 'active') throw new ModelBindingError(409, 'binding_inactive');
  const key = issue(binding);
  if (!key || typeof key.token !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(key.token) ||
      typeof key.baseUrl !== 'string' || !Number.isSafeInteger(key.expiresMs)) {
    throw new ModelBindingError(500, 'one_time_key_invalid');
  }
  let origin: string;
  try {
    const url = new URL(key.baseUrl);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) throw new Error('bad');
    origin = key.baseUrl;
  } catch { throw new ModelBindingError(500, 'one_time_key_invalid'); }
  const tokenRef = createHash('sha256').update(key.token).digest('hex').slice(0, 16);
  const env: Record<string, string> = binding.agent === 'codex'
    ? { CODEX_MODEL_PROVIDER: 'daming-magpie', MAGPIE_BASE_URL: origin, MAGPIE_API_KEY: key.token, CODEX_MODEL: binding.modelId }
    : binding.agent === 'claude-code'
      ? { ANTHROPIC_BASE_URL: origin, ANTHROPIC_API_KEY: key.token, ANTHROPIC_MODEL: binding.modelId }
      : { DEEPSEEK_BASE_URL: origin, DEEPSEEK_API_KEY: key.token, DEEPSEEK_MODEL: binding.modelId };
  return {
    agent: binding.agent, modelId: binding.modelId, providerId: binding.providerId,
    billing: binding.billing, bindingId: binding.bindingId,
    baseUrl: origin, expiresMs: key.expiresMs, tokenRef, env
  };
}

/** 一次受治理派工：解析绑定 → 额度/预算闸门 → 注入一次性运行配置 → 执行一次。 */
export async function governedDispatch(
  deps: DispatchDeps,
  request: { tenantId: string; agent: AgentTarget; taskId?: string; gate: DispatchGate }
): Promise<{ binding: ModelBindingView; runtime: AgentRuntimeConfig; result: { status: 'completed' | 'failed'; output: string } }> {
  const binding = deps.store.resolve(request.tenantId, request.agent, request.taskId === undefined ? {} : { taskId: request.taskId });
  if (!binding) throw new ModelBindingError(409, 'binding_missing');
  if (request.gate.quotaRemainingPercent === 0) throw new ModelBindingError(409, 'quota_exhausted');
  if (request.gate.budgetRemainingMinor < request.gate.requiredMinor) throw new ModelBindingError(409, 'budget_denied');
  const runtime = resolveAgentRuntime(binding, deps.issueKey);
  const result = await deps.run(runtime);
  return { binding, runtime, result };
}
