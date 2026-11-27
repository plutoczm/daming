import type { Engine, WorkflowPlan } from '@daming/core';
import { FixtureWorker } from '@daming/workers';
import type { WorkerDescriptor } from '@daming/workers';
import type { SqliteStore } from '@daming/store-sqlite';
import { HostAgentWorker } from '@daming/worker-process';
import { TaskCoordinator } from './task-coordinator.ts';

function descriptor(id: string, executorKind: 'dsh' | 'codex', permissions: readonly string[], concurrencyLimit: number, metrics: WorkerDescriptor['metrics']): WorkerDescriptor {
  return {
    id, executorKind, executionMode: 'fixture', runtime: 'fixture-v1', provider: 'fixture', model: 'fixture',
    routeMode: 'native', os: 'win32', health: 'ready', credentialsReady: true,
    capabilities: ['text'], permissions, network: 'offline', dataScopes: ['synthetic'],
    maxCashMinor: 10, priceVerified: true, quotaRemaining: 100, concurrencyLimit, activeCount: 0,
    isolation: 'fixture_only', metrics
  };
}

export const BOARD_WORKERS: readonly WorkerDescriptor[] = Object.freeze([
  descriptor('fixture-dsh', 'dsh', ['workspace.read', 'workspace.write'], 3, { samples: 20, successes: 18, latencyMs: 120 }),
  descriptor('fixture-codex', 'codex', ['workspace.read', 'workspace.write', 'terminal.exec'], 2, { samples: 12, successes: 11, latencyMs: 80 })
]);

export const REAL_CODEX_WORKER: WorkerDescriptor = Object.freeze({
  id: 'codex-real', executorKind: 'codex', executionMode: 'real', runtime: 'codex-0.167.0',
  provider: 'codex', model: 'codex-default', routeMode: 'native', os: 'win32',
  health: 'ready', credentialsReady: true, capabilities: ['text'], permissions: [],
  network: 'internet', dataScopes: ['synthetic'], maxCashMinor: 1, priceVerified: true,
  quotaRemaining: 100, concurrencyLimit: 1, activeCount: 0, isolation: 'supervised',
  billingSource: 'subscription'
});

export const REAL_DSH_WORKER: WorkerDescriptor = Object.freeze({
  id: 'dsh-real', executorKind: 'dsh', executionMode: 'real', runtime: 'dsh-0.2.2-rc.1',
  provider: 'deepseek', model: 'deepseek-default', routeMode: 'native', os: 'win32',
  health: 'ready', credentialsReady: true, capabilities: ['text'], permissions: [],
  network: 'internet', dataScopes: ['synthetic'], maxCashMinor: 100, priceVerified: true,
  quotaRemaining: 100, concurrencyLimit: 1, activeCount: 0, isolation: 'supervised',
  billingSource: 'official_api'
});

export const REAL_CLAUDE_WORKER: WorkerDescriptor = Object.freeze({
  id: 'claude-real', executorKind: 'claude-code', executionMode: 'real', runtime: 'claude-2.1.328',
  provider: 'anthropic', model: 'workbuddy/deepseek-v4.1-flash', routeMode: 'magpie', gatewayVerified: true, os: 'win32',
  health: 'ready', credentialsReady: true, capabilities: ['text'], permissions: [],
  network: 'internet', dataScopes: ['synthetic'], maxCashMinor: 1, priceVerified: true,
  quotaRemaining: 100, concurrencyLimit: 1, activeCount: 0, isolation: 'supervised',
  billingSource: 'subscription'
});

export function createBoardCoordinator(store: SqliteStore, engine: Engine): TaskCoordinator {
  return new TaskCoordinator({
    store, engine, authorization: 'synthetic-approved',
    workers: [
      { descriptor: BOARD_WORKERS[0], worker: new FixtureWorker('dsh', { delayMs: 2 }) },
      { descriptor: BOARD_WORKERS[1], worker: new FixtureWorker('codex', { delayMs: 2 }), behavior: 'first_invalid' }
    ]
  });
}

/** Real Codex dispatch through the UNIFIED host agent driver (codex exec --json). No Docker. */
export function createRealCodexCoordinator(store: SqliteStore, engine: Engine, _executable: string, workspaceRoot: string, approvalMode: 'auto' | 'manual' = 'manual', model?: string, _ignoreUserConfig = false): TaskCoordinator {
  return new TaskCoordinator({
    store, engine, authorization: 'synthetic-approved', executionMode: 'real', approvalMode,
    workers: [{ descriptor: REAL_CODEX_WORKER, worker: new HostAgentWorker({ agent: 'codex', workspaceRoot, timeoutMs: 300000, ...(model ? { model } : {}) }) }]
  });
}

/** Real DSH dispatch through the UNIFIED host agent driver (dsh --profile acp). No Docker. */
export function createRealDshCoordinator(store: SqliteStore, engine: Engine, _executable: string, _entry: string, workspaceRoot: string, approvalMode: 'auto' | 'manual' = 'manual', cashSnapshot?: () => Promise<{ currency: string; totalMinor: number } | undefined>): TaskCoordinator {
  return new TaskCoordinator({
    store, engine, authorization: 'synthetic-approved', executionMode: 'real', approvalMode,
    workers: [{ descriptor: REAL_DSH_WORKER, worker: new HostAgentWorker({ agent: 'dsh', workspaceRoot, timeoutMs: 300000 }) }],
    ...(cashSnapshot ? { cashSnapshot } : {})
  });
}

/** Real Claude dispatch through the UNIFIED host agent driver (claude -p -> Magpie). No Docker. */
export function createRealClaudeCoordinator(store: SqliteStore, engine: Engine, workspaceRoot: string, approvalMode: 'auto' | 'manual' = 'manual'): TaskCoordinator {
  return new TaskCoordinator({
    store, engine, authorization: 'synthetic-approved', executionMode: 'real', approvalMode,
    workers: [{ descriptor: REAL_CLAUDE_WORKER, worker: new HostAgentWorker({
      agent: 'claude', workspaceRoot, timeoutMs: 300000, model: 'workbuddy/deepseek-v4.1-flash',
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3425', ANTHROPIC_API_KEY: 'magpie', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1' },
    }) }]
  });
}

function realPlan(taskId: string, goal: string, worker: WorkerDescriptor, category: string, stepId: string, description: string): WorkflowPlan {
  return {
    planId: `real-${taskId}`, version: 1, category, policyVersion: 'supervisor-v1',
    candidates: [{ id: worker.id, executorKind: worker.executorKind, executionMode: 'real', version: worker.runtime, provider: worker.provider, model: worker.model, routeMode: worker.routeMode, concurrencyLimit: worker.concurrencyLimit }],
    steps: [{
      stepId, description, workerId: worker.id, dependsOn: [],
      input: goal, maxReworks: 0,
      contract: { version: 1, checks: [{ id: 'has-result', version: 1, artifactId: 'result', kind: 'present' }] }
    }]
  };
}

export function createRealCodexPlan(taskId: string, goal: string): WorkflowPlan {
  return realPlan(taskId, goal, REAL_CODEX_WORKER, 'task5-real-codex', 'codex-exec', '真实 Codex 执行');
}
export function createRealDshPlan(taskId: string, goal: string): WorkflowPlan {
  return realPlan(taskId, goal, REAL_DSH_WORKER, 'task5-real-dsh', 'dsh-exec', '真实 DSH 执行');
}
export function createRealClaudePlan(taskId: string, goal: string): WorkflowPlan {
  return realPlan(taskId, goal, REAL_CLAUDE_WORKER, 'task5-real-claude', 'claude-exec', '真实 Claude 执行');
}

export function createBoardPlan(taskId: string): WorkflowPlan {
  const candidates = BOARD_WORKERS.map((worker) => ({
    id: worker.id, executorKind: worker.executorKind, executionMode: 'fixture' as const, version: worker.runtime,
    provider: worker.provider, model: worker.model, routeMode: worker.routeMode,
    concurrencyLimit: worker.concurrencyLimit
  }));
  const contract = { version: 1, checks: [{ id: 'result-ok', version: 1, artifactId: 'result', kind: 'json_equals' as const, expected: { ok: true } }] };
  return {
    planId: `board-${taskId}`, version: 1, category: 'task5-board', policyVersion: 'supervisor-v1', candidates,
    steps: [
      { stepId: 'research', description: '收集需求与约束', workerId: 'fixture-dsh', dependsOn: [], input: '{"ok":true}', maxReworks: 1, contract },
      { stepId: 'draft', description: '生成交付草案', workerId: 'fixture-codex', dependsOn: [], input: '{"ok":true}', maxReworks: 1, contract },
      { stepId: 'verify', description: '独立验收并汇合', workerId: 'fixture-dsh', dependsOn: ['research', 'draft'], input: '{"ok":true}', maxReworks: 1, contract }
    ]
  };
}
