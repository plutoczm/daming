/**
 * 项目工作台（个人向，第一版骨架，不执行代码）。
 *
 * 落地用户 2026-11-26 描述的工作流前半段：
 *   上传 Spec.md + Plan.md → 冻结 → 把 Plan 拆成串行阶段 →
 *   Progress.md 只记录「当前阶段」→ 指挥官把当前阶段展开成 JSON 功能清单 features.json →
 *   完成后清空 Progress.md、进入下一阶段。
 *
 * 真源仍是 ProjectInputStore（spec/plan_baseline 冻结快照）。本模块只在项目目录里
 * 维护可直接阅读/编辑的 Spec.md、Plan.md、Progress.md、features.json 与 .daming/workbench.json。
 * 不跑命令、不碰 Git（后续阶段）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PROJECT_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;

export interface WorkbenchSeedSpecClause { readonly id: string; readonly text: string }
export interface WorkbenchSeedPlanStep { readonly stepId: string; readonly description: string }
export interface WorkbenchSeed {
  readonly title?: string;
  readonly spec: readonly WorkbenchSeedSpecClause[];
  readonly plan: readonly WorkbenchSeedPlanStep[];
}

type PhaseStatus = 'pending' | 'doing' | 'done';

export interface PhaseState {
  phaseId: string;
  title: string;
  description: string;
  status: PhaseStatus;
}

interface WorkbenchState {
  projectId: string;
  title: string;
  phases: PhaseState[];
  currentIndex: number;
  featuresPhaseId: string | null;
  createdAt: string;
  updatedAt: string;
  history: { phaseId: string; title: string; completedAt: string }[];
}

export interface WorkbenchFeature { id: string; title: string; acceptance: string[]; status: 'todo' | 'doing' | 'done' }
export interface WorkbenchView {
  projectId: string;
  directoryPath: string;
  phases: PhaseState[];
  currentPhaseIndex: number;
  currentPhase: PhaseState | null;
  done: boolean;
  progressMarkdown: string;
  features: WorkbenchFeature[];
  featuresPhaseId: string | null;
  specCount: number;
  planCount: number;
  updatedAt: string;
}

function shortTitle(description: string): string {
  const one = description.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? description;
  return one.length > 34 ? one.slice(0, 34) + '…' : one;
}

function progressTemplate(state: WorkbenchState): string {
  const phase = state.phases[state.currentIndex];
  if (!phase) {
    return '# Progress\n\n状态：全部阶段已完成 🎉\n';
  }
  return [
    '# Progress',
    '',
    `- 项目：${state.title}（${state.projectId}）`,
    `- 当前阶段：${state.currentIndex + 1}/${state.phases.length} · ${phase.title}`,
    '- 状态：进行中',
    '',
    '## 记录',
    '',
    '（这里记录本阶段正在做的事；阶段完成后本文件会被清空并进入下一阶段）',
    ''
  ].join('\n');
}

export class ProjectWorkbenchError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export class ProjectWorkbench {
  private readonly rootDir: string;
  constructor(rootDir: string) { this.rootDir = rootDir; }

  private dir(projectId: string): string {
    if (!PROJECT_ID.test(projectId)) throw new ProjectWorkbenchError(400, 'invalid_project_id');
    return join(this.rootDir, projectId);
  }

  private statePath(projectId: string): string { return join(this.dir(projectId), '.daming', 'workbench.json'); }
  private featuresPath(projectId: string): string { return join(this.dir(projectId), 'features.json'); }

  /** 读取（或按冻结快照初始化）项目工作台状态。 */
  ensure(projectId: string, seed: WorkbenchSeed): WorkbenchView {
    const dir = this.dir(projectId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const state = this.loadState(projectId) ?? this.initState(projectId, seed);
    return this.buildView(state);
  }

  view(projectId: string, seed?: WorkbenchSeed): WorkbenchView {
    const state = this.loadState(projectId);
    if (!state) {
      if (!seed) throw new ProjectWorkbenchError(404, 'workbench_not_initialized');
      return this.ensure(projectId, seed);
    }
    return this.buildView(state);
  }

  list(): { projectId: string; title: string; phaseCount: number; doneCount: number; currentPhaseIndex: number; done: boolean; updatedAt: string }[] {
    if (!existsSync(this.rootDir)) return [];
    const rows: { projectId: string; title: string; phaseCount: number; doneCount: number; currentPhaseIndex: number; done: boolean; updatedAt: string }[] = [];
    for (const name of readdirSync(this.rootDir)) {
      if (!PROJECT_ID.test(name)) continue;
      let state: WorkbenchState | null = null;
      try { state = this.loadState(name); } catch { state = null; }
      if (!state) continue;
      rows.push({
        projectId: state.projectId,
        title: state.title,
        phaseCount: state.phases.length,
        doneCount: state.phases.filter((phase) => phase.status === 'done').length,
        currentPhaseIndex: state.currentIndex,
        done: state.currentIndex >= state.phases.length,
        updatedAt: state.updatedAt
      });
    }
    return rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  advance(projectId: string, seed: WorkbenchSeed): WorkbenchView {
    const state = this.loadState(projectId) ?? this.initState(projectId, seed);
    const phase = state.phases[state.currentIndex];
    if (!phase) return this.buildView(state);
    phase.status = 'done';
    state.history.push({ phaseId: phase.phaseId, title: phase.title, completedAt: new Date().toISOString() });
    state.currentIndex += 1;
    state.featuresPhaseId = null;
    // 「完成后清空 Progress.md」——先清空旧阶段记录，再为下一阶段写新骨架（全部完成则写完成态）。
    writeFileSync(join(this.dir(projectId), 'Progress.md'), '', 'utf8');
    try { rmSync(this.featuresPath(projectId)); } catch { /* features 可选 */ }
    const next = state.phases[state.currentIndex];
    if (next) next.status = 'doing';
    state.updatedAt = new Date().toISOString();
    this.saveState(state);
    writeFileSync(join(this.dir(projectId), 'Progress.md'), progressTemplate(state), 'utf8');
    return this.buildView(state);
  }

  setProgress(projectId: string, text: string): WorkbenchView {
    const state = this.loadState(projectId);
    if (!state) throw new ProjectWorkbenchError(404, 'workbench_not_initialized');
    writeFileSync(join(this.dir(projectId), 'Progress.md'), text, 'utf8');
    state.updatedAt = new Date().toISOString();
    this.saveState(state);
    return this.buildView(state);
  }

  /** 指挥官（第一版为离线规则）把当前阶段展开成 JSON 功能清单，写入 features.json。 */
  expand(projectId: string, seed: WorkbenchSeed): WorkbenchView {
    const state = this.loadState(projectId) ?? this.initState(projectId, seed);
    const phase = state.phases[state.currentIndex];
    if (!phase) return this.buildView(state);
    const clauses = phase.description
      .split(/[；;。\n]+/)
      .map((part) => part.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, '').trim())
      .filter((part) => part.length > 0);
    const texts = clauses.length ? clauses : [phase.title];
    const features: WorkbenchFeature[] = texts.map((text, index) => ({
      id: 'F' + (index + 1),
      title: text,
      acceptance: [],
      status: 'todo'
    }));
    const payload = {
      projectId,
      phaseId: phase.phaseId,
      phaseTitle: phase.title,
      generatedBy: 'commander-rules/v1',
      dedupe: { scanned: false, note: '离线规则展开；接手项目查重将在接入代码扫描后启用' },
      generatedAt: new Date().toISOString(),
      features
    };
    writeFileSync(this.featuresPath(projectId), JSON.stringify(payload, null, 2) + '\n', 'utf8');
    state.featuresPhaseId = phase.phaseId;
    state.updatedAt = payload.generatedAt;
    this.saveState(state);
    return this.buildView(state);
  }

  private initState(projectId: string, seed: WorkbenchSeed): WorkbenchState {
    const dir = this.dir(projectId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    const phases: PhaseState[] = seed.plan.map((step, index) => ({
      phaseId: step.stepId || 'step-' + (index + 1),
      title: shortTitle(step.description),
      description: step.description,
      status: index === 0 ? 'doing' : 'pending'
    }));
    if (!phases.length) throw new ProjectWorkbenchError(409, 'project_requires_plan');
    const state: WorkbenchState = {
      projectId,
      title: seed.title?.trim() || projectId,
      phases,
      currentIndex: 0,
      featuresPhaseId: null,
      createdAt: now,
      updatedAt: now,
      history: []
    };
    writeFileSync(join(dir, 'Spec.md'), this.renderSpec(seed), 'utf8');
    writeFileSync(join(dir, 'Plan.md'), this.renderPlan(seed), 'utf8');
    mkdirSync(join(dir, '.daming'), { recursive: true });
    this.saveState(state);
    writeFileSync(join(dir, 'Progress.md'), progressTemplate(state), 'utf8');
    return state;
  }

  private renderSpec(seed: WorkbenchSeed): string {
    return ['# Spec', '', ...seed.spec.map((clause) => `- ${clause.text}`), ''].join('\n');
  }
  private renderPlan(seed: WorkbenchSeed): string {
    return ['# Plan', '', ...seed.plan.map((step, index) => `${index + 1}. ${step.description}`), ''].join('\n');
  }

  private loadState(projectId: string): WorkbenchState | null {
    const path = this.statePath(projectId);
    if (!existsSync(path)) return null;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as WorkbenchState;
      if (!raw || !Array.isArray(raw.phases)) return null;
      return raw;
    } catch { return null; }
  }

  private saveState(state: WorkbenchState): void {
    const path = this.statePath(state.projectId);
    mkdirSync(join(this.dir(state.projectId), '.daming'), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2) + '\n', 'utf8');
  }

  private buildView(state: WorkbenchState): WorkbenchView {
    const dir = this.dir(state.projectId);
    let progressMarkdown = '';
    try { progressMarkdown = readFileSync(join(dir, 'Progress.md'), 'utf8'); } catch { progressMarkdown = ''; }
    let features: WorkbenchFeature[] = [];
    let featuresPhaseId: string | null = null;
    if (existsSync(this.featuresPath(state.projectId))) {
      try {
        const payload = JSON.parse(readFileSync(this.featuresPath(state.projectId), 'utf8')) as {
          phaseId?: string; features?: WorkbenchFeature[];
        };
        features = Array.isArray(payload.features) ? payload.features : [];
        featuresPhaseId = typeof payload.phaseId === 'string' ? payload.phaseId : null;
      } catch { features = []; }
    }
    const specPath = join(dir, 'Spec.md');
    const planPath = join(dir, 'Plan.md');
    const countLines = (path: string): number => {
      try { return readFileSync(path, 'utf8').split(/\r?\n/).filter((line) => /^\s*(?:[-*+]|\d+[.)])\s+/.test(line)).length; } catch { return 0; }
    };
    return {
      projectId: state.projectId,
      directoryPath: dir,
      phases: state.phases,
      currentPhaseIndex: state.currentIndex,
      currentPhase: state.phases[state.currentIndex] ?? null,
      done: state.currentIndex >= state.phases.length,
      progressMarkdown,
      features,
      featuresPhaseId,
      specCount: countLines(specPath),
      planCount: state.phases.length,
      updatedAt: state.updatedAt
    };
  }
}

/** 供路由判断目录是否已存在（避免把非项目目录误当项目）。 */
export function isWorkbenchDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}
