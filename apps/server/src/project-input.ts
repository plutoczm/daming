import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * S7 项目输入（REQ-001，四件套完成流程）：
 *  1) spec          — 需求真值（目标/范围/验收标准）；按 revision 冻结，验收只来自 spec。
 *  2) plan          — 含 plan_baseline（初始存档，只读不变）与 plan_runtime（当前执行路线，
 *                     初始=baseline，随项目推进由 Agent 与用户沟通调整细节后生成新版本；不得降低 spec 验收）。
 *  3) progress      — Agent 自写的当前阶段执行记录快照；当前阶段验收通过后清空，再进入下一阶段填入新记录；供 LLM 读。
 *  4) naturalLanguage — 用户可选输入给 LLM（范围/约束），绝不作验收标准。
 * 旧 spec 版本保留可追溯、不被静默覆盖。
 */
export class ProjectInputError extends Error {
  readonly status: number;
  constructor(status: number, reason: string) { super(reason); this.status = status; }
}

export interface SpecClauseCheck { readonly kind: 'present' | 'json_equals'; readonly expected?: unknown; }
export interface SpecClause { readonly id: string; readonly text: string; readonly check?: SpecClauseCheck; }
export interface PlanStep {
  readonly stepId: string; readonly description: string;
  readonly dependsOn?: readonly string[];
  /** 计划声明“可豁免”的 spec 验收条款 id；baseline 里出现记为冲突(spec 优先)，runtime 里出现则直接拒绝。 */
  readonly waives?: readonly string[];
}
export interface SubmitProjectInput {
  readonly ownerId: string;
  readonly spec: readonly SpecClause[];
  readonly planBaseline: readonly PlanStep[];
  /** 可选；缺省则初始 runtime = baseline。 */
  readonly planRuntime?: readonly PlanStep[];
  /** 可选（用户自选输入）。 */
  readonly naturalLanguage?: string;
  readonly projectId?: string;
  readonly expectedRevision?: number;
}
export interface ProjectConflict { readonly kind: 'plan_waives_acceptance'; readonly clauseId: string; readonly detail: string; }
export interface AcceptanceCriterion { readonly id: string; readonly text: string; readonly check?: SpecClauseCheck; }
export type ProgressStatus = 'todo' | 'doing' | 'done' | 'blocked';
export interface ProgressSnapshot { readonly projectId: string; readonly stage: string; readonly status: ProgressStatus; readonly record: string; readonly updatedAt: string; }
export interface PlanRuntimeRevision { readonly projectId: string; readonly runtimeRevision: number; readonly specRevision: number; readonly plan: readonly PlanStep[]; readonly note: string; readonly createdAt: string; }
export interface FrozenProjectInput {
  readonly projectId: string;
  readonly revision: number;
  readonly ownerId: string;
  readonly spec: readonly SpecClause[];
  readonly planBaseline: readonly PlanStep[];
  readonly planRuntime: readonly PlanStep[];
  readonly runtimeRevision: number;
  readonly naturalLanguage?: string;
  readonly acceptance: readonly AcceptanceCriterion[];
  readonly conflicts: readonly ProjectConflict[];
  readonly status: 'frozen' | 'frozen_spec_precedence';
  readonly requiresHumanArbitration: boolean;
  readonly naturalLanguageIsAcceptance: false;
  readonly specHash: string;
  readonly baselineHash: string;
  readonly frozenAt: string;
  readonly supersededBy?: number;
}

const PROJECT_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/i;
type Row = Record<string, unknown>;

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ProjectInputError(400, 'missing_' + field);
  return value;
}
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function validateCheck(check: unknown): SpecClauseCheck | undefined {
  if (check === undefined) return undefined;
  if (!check || typeof check !== 'object' || Array.isArray(check)) throw new ProjectInputError(400, 'invalid_spec_check');
  const c = check as Record<string, unknown>;
  if (c.kind !== 'present' && c.kind !== 'json_equals') throw new ProjectInputError(400, 'invalid_spec_check');
  if (c.kind === 'json_equals' && !('expected' in c)) throw new ProjectInputError(400, 'invalid_spec_check');
  return c.kind === 'present' ? { kind: 'present' } : { kind: 'json_equals', expected: c.expected };
}
function validateSpec(spec: unknown): SpecClause[] {
  if (!Array.isArray(spec) || spec.length === 0) throw new ProjectInputError(400, 'missing_spec');
  const ids = new Set<string>();
  return spec.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ProjectInputError(400, 'invalid_spec');
    const clause = raw as Record<string, unknown>;
    if (Object.keys(clause).some((key) => !['id', 'text', 'check'].includes(key))) throw new ProjectInputError(400, 'invalid_spec');
    const id = text(clause.id, 'spec_clause_id');
    if (ids.has(id)) throw new ProjectInputError(400, 'duplicate_spec_clause');
    ids.add(id);
    const check = validateCheck(clause.check);
    return { id, text: text(clause.text, 'spec_clause_text'), ...(check ? { check } : {}) };
  });
}
function validatePlan(plan: unknown, label: string): PlanStep[] {
  if (!Array.isArray(plan) || plan.length === 0) throw new ProjectInputError(400, 'missing_' + label);
  const stepIds = new Set<string>();
  const parsed = plan.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ProjectInputError(400, 'invalid_' + label);
    const step = raw as Record<string, unknown>;
    if (Object.keys(step).some((key) => !['stepId', 'description', 'dependsOn', 'waives'].includes(key))) throw new ProjectInputError(400, 'invalid_' + label);
    const stepId = text(step.stepId, 'plan_step_id');
    if (stepIds.has(stepId)) throw new ProjectInputError(400, 'duplicate_plan_step');
    stepIds.add(stepId);
    const dependsOn = step.dependsOn === undefined ? undefined
      : Array.isArray(step.dependsOn) ? step.dependsOn.map((dep) => text(dep, 'plan_dependency')) : (() => { throw new ProjectInputError(400, 'invalid_' + label); })();
    const waives = step.waives === undefined ? undefined
      : Array.isArray(step.waives) ? step.waives.map((id) => text(id, 'plan_waiver')) : (() => { throw new ProjectInputError(400, 'invalid_' + label); })();
    return { stepId, description: text(step.description, 'plan_description'), ...(dependsOn ? { dependsOn } : {}), ...(waives ? { waives } : {}) };
  });
  for (const step of parsed) {
    for (const dep of step.dependsOn ?? []) {
      if (!stepIds.has(dep)) throw new ProjectInputError(400, 'plan_dependency_unknown');
      if (dep === step.stepId) throw new ProjectInputError(400, 'plan_dependency_cycle');
    }
  }
  return parsed;
}
function baselineConflicts(plan: readonly PlanStep[], specIds: ReadonlySet<string>): ProjectConflict[] {
  const conflicts: ProjectConflict[] = [];
  for (const step of plan) {
    for (const clauseId of step.waives ?? []) {
      if (!specIds.has(clauseId)) throw new ProjectInputError(400, 'plan_waives_unknown_clause');
      conflicts.push({ kind: 'plan_waives_acceptance', clauseId, detail: 'plan_baseline step ' + step.stepId + ' tried to waive acceptance clause ' + clauseId + '; spec wins' });
    }
  }
  return conflicts;
}
function assertRuntimeDoesNotLower(plan: readonly PlanStep[], specIds: ReadonlySet<string>): void {
  for (const step of plan) {
    for (const clauseId of step.waives ?? []) {
      if (!specIds.has(clauseId)) throw new ProjectInputError(400, 'plan_waives_unknown_clause');
      throw new ProjectInputError(409, 'plan_runtime_lowers_spec');
    }
  }
}

export class ProjectInputStore {
  private readonly db: DatabaseSync;
  private readonly clock: () => number;
  private closed = false;
  constructor(dataDir: string, clock: () => number = Date.now) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dataDir, 'project-inputs.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS project_inputs(' +
      'project_id TEXT NOT NULL, revision INTEGER NOT NULL, created_by TEXT NOT NULL, created_ms INTEGER NOT NULL,' +
      'spec_json TEXT NOT NULL, plan_baseline_json TEXT NOT NULL, natural_language TEXT,' +
      'acceptance_json TEXT NOT NULL, conflicts_json TEXT NOT NULL, status TEXT NOT NULL,' +
      'spec_hash TEXT NOT NULL, baseline_hash TEXT NOT NULL, superseded_by INTEGER,' +
      'PRIMARY KEY(project_id, revision));' +
      'CREATE TABLE IF NOT EXISTS plan_runtime_revisions(' +
      'project_id TEXT NOT NULL, runtime_revision INTEGER NOT NULL, spec_revision INTEGER NOT NULL,' +
      'plan_runtime_json TEXT NOT NULL, note TEXT NOT NULL, created_by TEXT NOT NULL, created_ms INTEGER NOT NULL,' +
      'PRIMARY KEY(project_id, runtime_revision));' +
      'CREATE TABLE IF NOT EXISTS progress(' +
      'project_id TEXT PRIMARY KEY, stage TEXT NOT NULL, status TEXT NOT NULL, record TEXT NOT NULL, updated_at TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS project_directories(' +
      'project_id TEXT PRIMARY KEY, directory TEXT NOT NULL, created_by TEXT NOT NULL, created_ms INTEGER NOT NULL);'
    );
    this.clock = clock;
  }
  close(): void { if (this.closed) return; this.closed = true; this.db.close(); }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private latestRevision(projectId: string): number {
    const row = this.db.prepare('SELECT MAX(revision) AS revision FROM project_inputs WHERE project_id=?').get(projectId) as { revision: number | null };
    return row.revision === null ? 0 : Number(row.revision);
  }
  private latestRuntime(projectId: string): number {
    const row = this.db.prepare('SELECT MAX(runtime_revision) AS revision FROM plan_runtime_revisions WHERE project_id=?').get(projectId) as { revision: number | null };
    return row.revision === null ? 0 : Number(row.revision);
  }
  /** Remember the user's project directory (spec + plan_baseline live there). */
  registerDirectory(projectId: string, directory: string, ownerId: string): void {
    this.db.prepare(
      'INSERT INTO project_directories(project_id,directory,created_by,created_ms) VALUES(?,?,?,?) ' +
      'ON CONFLICT(project_id) DO UPDATE SET directory=excluded.directory'
    ).run(projectId, directory, ownerId, this.clock());
  }
  listProjects(): { projectId: string; directory: string; revision: number; status: string; specCount: number; planCount: number; updatedAt: string }[] {
    const rows = this.db.prepare('SELECT * FROM project_directories ORDER BY created_ms DESC').all() as Row[];
    return rows.flatMap((row) => {
      const projectId = String(row.project_id);
      const latest = this.latest(projectId);
      if (!latest) return [];
      return [{
        projectId,
        directory: String(row.directory),
        revision: latest.revision,
        status: latest.status,
        specCount: latest.spec.length,
        planCount: latest.planBaseline.length,
        updatedAt: latest.frozenAt
      }];
    });
  }
  /** 列出所有已提交项目的最新一版（不要求已登记目录），供组合治理聚合。 */
  listAll(): { projectId: string; revision: number; status: string; specCount: number; planCount: number; updatedAt: string }[] {
    const rows = this.db.prepare('SELECT project_id, MAX(revision) AS revision FROM project_inputs GROUP BY project_id').all() as Row[];
    return rows.flatMap((row) => {
      const latest = this.latest(String(row.project_id));
      if (!latest) return [];
      return [{
        projectId: latest.projectId, revision: latest.revision, status: latest.status,
        specCount: latest.spec.length, planCount: latest.planBaseline.length, updatedAt: latest.frozenAt
      }];
    });
  }
  /** Permanently remove a project: its intake revisions, runtime revisions, progress and directory record. */
  deleteProject(projectId: string): boolean {
    const pid = text(projectId, 'project');
    return this.transaction(() => {
      const existed = Boolean(
        this.db.prepare('SELECT 1 FROM project_directories WHERE project_id=?').get(pid) ??
        this.db.prepare('SELECT 1 FROM project_inputs WHERE project_id=? LIMIT 1').get(pid)
      );
      this.db.prepare('DELETE FROM project_inputs WHERE project_id=?').run(pid);
      this.db.prepare('DELETE FROM plan_runtime_revisions WHERE project_id=?').run(pid);
      this.db.prepare('DELETE FROM progress WHERE project_id=?').run(pid);
      this.db.prepare('DELETE FROM project_directories WHERE project_id=?').run(pid);
      return existed;
    });
  }
  private specOf(projectId: string, revision: number): SpecClause[] {
    const row = this.db.prepare('SELECT spec_json FROM project_inputs WHERE project_id=? AND revision=?').get(projectId, revision) as Row | undefined;
    if (!row) throw new ProjectInputError(404, 'project_input_missing');
    return JSON.parse(String(row.spec_json)) as SpecClause[];
  }
  private currentRuntimeRow(projectId: string): Row | undefined {
    return this.db.prepare('SELECT * FROM plan_runtime_revisions WHERE project_id=? ORDER BY runtime_revision DESC LIMIT 1').get(projectId) as Row | undefined;
  }

  submitProject(input: SubmitProjectInput): FrozenProjectInput {
    if (!input || typeof input !== 'object') throw new ProjectInputError(400, 'invalid_input');
    const ownerId = text(input.ownerId, 'owner');
    const spec = validateSpec(input.spec);
    const specIds = new Set(spec.map((clause) => clause.id));
    const planBaseline = validatePlan(input.planBaseline, 'plan_baseline');
    let planRuntime: PlanStep[];
    if (input.planRuntime === undefined) {
      planRuntime = planBaseline; // 初始 runtime = baseline（不在此处做“降级”拒绝，baseline 的豁免已记为冲突、spec 优先）
    } else {
      planRuntime = validatePlan(input.planRuntime, 'plan_runtime');
      assertRuntimeDoesNotLower(planRuntime, specIds);
    }
    const conflicts = baselineConflicts(planBaseline, specIds);
    const naturalLanguage = input.naturalLanguage === undefined ? undefined
      : (typeof input.naturalLanguage === 'string' ? input.naturalLanguage : (() => { throw new ProjectInputError(400, 'invalid_natural_language'); })());
    const projectId = input.projectId === undefined ? randomUUID()
      : (PROJECT_ID.test(input.projectId) ? input.projectId : (() => { throw new ProjectInputError(400, 'invalid_project_id'); })());
    const acceptance: AcceptanceCriterion[] = spec.map((clause) => ({ id: clause.id, text: clause.text, ...(clause.check ? { check: clause.check } : {}) }));
    const status: FrozenProjectInput['status'] = conflicts.length ? 'frozen_spec_precedence' : 'frozen';
    const specHash = hash(spec); const baselineHash = hash(planBaseline);
    return this.transaction(() => {
      const latest = this.latestRevision(projectId);
      if (input.expectedRevision !== undefined &&
          (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== latest)) {
        throw new ProjectInputError(409, 'revision_conflict');
      }
      const revision = latest + 1;
      this.db.prepare(
        'INSERT INTO project_inputs(project_id,revision,created_by,created_ms,spec_json,plan_baseline_json,natural_language,' +
        'acceptance_json,conflicts_json,status,spec_hash,baseline_hash,superseded_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ).run(projectId, revision, ownerId, this.clock(), JSON.stringify(spec), JSON.stringify(planBaseline),
        naturalLanguage ?? null, JSON.stringify(acceptance), JSON.stringify(conflicts), status, specHash, baselineHash, null);
      if (latest > 0) {
        this.db.prepare('UPDATE project_inputs SET superseded_by=? WHERE project_id=? AND revision=? AND superseded_by IS NULL').run(revision, projectId, latest);
      }
      const runtimeRevision = this.latestRuntime(projectId) + 1;
      this.db.prepare('INSERT INTO plan_runtime_revisions(project_id,runtime_revision,spec_revision,plan_runtime_json,note,created_by,created_ms) VALUES(?,?,?,?,?,?,?)')
        .run(projectId, runtimeRevision, revision, JSON.stringify(planRuntime), input.planRuntime === undefined ? '初始 runtime = baseline' : '提交时显式提供 runtime', ownerId, this.clock());
      return this.get(projectId, revision)!;
    });
  }

  /** Agent 与用户沟通后写入新的 plan_runtime；不得降低 spec 验收；保留 runtime 历史。 */
  revisePlanRuntime(input: { projectId: string; planRuntime: readonly PlanStep[]; note: string; expectedRuntimeRevision?: number; ownerId?: string }): PlanRuntimeRevision {
    const projectId = input.projectId;
    if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId)) throw new ProjectInputError(400, 'invalid_project_id');
    const latestSpec = this.latestRevision(projectId);
    if (latestSpec === 0) throw new ProjectInputError(404, 'project_input_missing');
    const specIds = new Set(this.specOf(projectId, latestSpec).map((clause) => clause.id));
    const planRuntime = validatePlan(input.planRuntime, 'plan_runtime');
    assertRuntimeDoesNotLower(planRuntime, specIds);
    const note = typeof input.note === 'string' && input.note.trim() ? input.note : (() => { throw new ProjectInputError(400, 'missing_note'); })();
    return this.transaction(() => {
      const latest = this.latestRuntime(projectId);
      if (input.expectedRuntimeRevision !== undefined &&
          (!Number.isSafeInteger(input.expectedRuntimeRevision) || input.expectedRuntimeRevision !== latest)) {
        throw new ProjectInputError(409, 'runtime_revision_conflict');
      }
      const runtimeRevision = latest + 1;
      this.db.prepare('INSERT INTO plan_runtime_revisions(project_id,runtime_revision,spec_revision,plan_runtime_json,note,created_by,created_ms) VALUES(?,?,?,?,?,?,?)')
        .run(projectId, runtimeRevision, latestSpec, JSON.stringify(planRuntime), note, input.ownerId ?? 'agent', this.clock());
      return this.runtimeView(projectId, runtimeRevision)!;
    });
  }

  /** Agent 自写当前阶段进度；随阶段验收由 clearProgress 清空。 */
  writeProgress(input: { projectId: string; stage: string; status: ProgressStatus; record: string }): ProgressSnapshot {
    const projectId = input?.projectId;
    if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId)) throw new ProjectInputError(400, 'invalid_project_id');
    if (this.latestRevision(projectId) === 0) throw new ProjectInputError(404, 'project_input_missing');
    const stage = text(input.stage, 'stage');
    if (!['todo', 'doing', 'done', 'blocked'].includes(input.status)) throw new ProjectInputError(400, 'invalid_progress_status');
    if (typeof input.record !== 'string' || input.record.length > 8192) throw new ProjectInputError(400, 'invalid_progress_record');
    const updatedAt = new Date(this.clock()).toISOString();
    this.db.prepare(
      'INSERT INTO progress(project_id,stage,status,record,updated_at) VALUES(?,?,?,?,?) ' +
      'ON CONFLICT(project_id) DO UPDATE SET stage=excluded.stage,status=excluded.status,record=excluded.record,updated_at=excluded.updated_at'
    ).run(projectId, stage, input.status, input.record, updatedAt);
    return { projectId, stage, status: input.status, record: input.record, updatedAt };
  }
  getProgress(projectId: string): ProgressSnapshot | undefined {
    const row = this.db.prepare('SELECT * FROM progress WHERE project_id=?').get(projectId) as Row | undefined;
    return row ? { projectId: String(row.project_id), stage: String(row.stage), status: String(row.status) as ProgressStatus, record: String(row.record), updatedAt: String(row.updated_at) } : undefined;
  }
  /** 当前阶段验收通过：清空 progress，等待下一阶段重新写入。 */
  clearProgress(projectId: string): void {
    if (this.latestRevision(projectId) === 0) throw new ProjectInputError(404, 'project_input_missing');
    this.db.prepare('DELETE FROM progress WHERE project_id=?').run(projectId);
  }

  latest(projectId: string): FrozenProjectInput | undefined {
    const revision = this.latestRevision(projectId);
    return revision === 0 ? undefined : this.get(projectId, revision);
  }
  get(projectId: string, revision: number): FrozenProjectInput | undefined {
    const row = this.db.prepare('SELECT * FROM project_inputs WHERE project_id=? AND revision=?').get(projectId, revision) as Row | undefined;
    if (!row) return undefined;
    const runtime = this.currentRuntimeRow(projectId);
    return this.view(row, runtime ?? null);
  }
  history(projectId: string): FrozenProjectInput[] {
    return (this.db.prepare('SELECT * FROM project_inputs WHERE project_id=? ORDER BY revision ASC').all(projectId) as Row[])
      .map((row) => this.view(row, null));
  }
  runtimeHistory(projectId: string): PlanRuntimeRevision[] {
    return (this.db.prepare('SELECT * FROM plan_runtime_revisions WHERE project_id=? ORDER BY runtime_revision ASC').all(projectId) as Row[])
      .map((row) => this.runtimeViewFromRow(row));
  }
  /** 四件套快照（供 LLM 读取）：spec + plan(baseline/runtime) + progress + naturalLanguage。 */
  pieces(projectId: string): { projectId: string; revision: number; spec: readonly SpecClause[]; plan: { baseline: readonly PlanStep[]; runtime: readonly PlanStep[] }; progress: ProgressSnapshot | null; naturalLanguage?: string } {
    const frozen = this.latest(projectId);
    if (!frozen) throw new ProjectInputError(404, 'project_input_missing');
    return { projectId, revision: frozen.revision, spec: frozen.spec, plan: { baseline: frozen.planBaseline, runtime: frozen.planRuntime }, progress: this.getProgress(projectId) ?? null, ...(frozen.naturalLanguage === undefined ? {} : { naturalLanguage: frozen.naturalLanguage }) };
  }
  private runtimeView(projectId: string, runtimeRevision: number): PlanRuntimeRevision | undefined {
    const row = this.db.prepare('SELECT * FROM plan_runtime_revisions WHERE project_id=? AND runtime_revision=?').get(projectId, runtimeRevision) as Row | undefined;
    return row ? this.runtimeViewFromRow(row) : undefined;
  }
  private runtimeViewFromRow(row: Row): PlanRuntimeRevision {
    return {
      projectId: String(row.project_id), runtimeRevision: Number(row.runtime_revision), specRevision: Number(row.spec_revision),
      plan: JSON.parse(String(row.plan_runtime_json)) as PlanStep[], note: String(row.note), createdAt: new Date(Number(row.created_ms)).toISOString()
    };
  }
  private view(row: Row, runtimeRow: Row | null): FrozenProjectInput {
    const runtime = runtimeRow ?? this.currentRuntimeRow(String(row.project_id));
    const conflicts = JSON.parse(String(row.conflicts_json)) as ProjectConflict[];
    const naturalLanguage = row.natural_language === null || row.natural_language === undefined ? undefined : String(row.natural_language);
    return {
      projectId: String(row.project_id), revision: Number(row.revision), ownerId: String(row.created_by),
      spec: JSON.parse(String(row.spec_json)) as SpecClause[],
      planBaseline: JSON.parse(String(row.plan_baseline_json)) as PlanStep[],
      planRuntime: runtime ? JSON.parse(String(runtime.plan_runtime_json)) as PlanStep[] : (JSON.parse(String(row.plan_baseline_json)) as PlanStep[]),
      runtimeRevision: runtime ? Number(runtime.runtime_revision) : 1,
      ...(naturalLanguage === undefined ? {} : { naturalLanguage }),
      acceptance: JSON.parse(String(row.acceptance_json)) as AcceptanceCriterion[],
      conflicts, status: String(row.status) as FrozenProjectInput['status'],
      requiresHumanArbitration: conflicts.length > 0,
      naturalLanguageIsAcceptance: false,
      specHash: String(row.spec_hash), baselineHash: String(row.baseline_hash),
      frozenAt: new Date(Number(row.created_ms)).toISOString(),
      ...(row.superseded_by === null || row.superseded_by === undefined ? {} : { supersededBy: Number(row.superseded_by) })
    };
  }
}
