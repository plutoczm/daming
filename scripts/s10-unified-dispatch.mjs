/** S10 dispatch wiring proof: TaskCoordinator real-mode tasks execute through the UNIFIED host driver (HostAgentWorker -> runAgent). */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Engine } from '../packages/core/src/index.ts';
import { SqliteStore } from '../packages/store-sqlite/src/index.ts';
import { HostAgentWorker } from '../packages/worker-process/src/host-agent-worker.ts';
import { TaskCoordinator } from '../apps/server/src/task-coordinator.ts';
import { REAL_CODEX_WORKER, REAL_DSH_WORKER, REAL_CLAUDE_WORKER, createRealCodexCoordinator, createRealDshPlan, createRealCodexPlan, createRealClaudeCoordinator, createRealClaudePlan } from '../apps/server/src/board-fixture.ts';

const GOAL = 'Reply with exactly: OK. Do not call tools.';
const MAGPIE_ENV = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3425', ANTHROPIC_API_KEY: 'magpie', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1' };
const proof = { stage: 'S10', kind: 'TaskCoordinator real dispatch via unified host driver (no Docker)', observedAt: new Date().toISOString(), results: [] };

async function runOne(agent, build) {
  const dir = mkdtempSync(join(tmpdir(), `daming-dispatch-${agent}-`));
  const store = new SqliteStore(join(dir, 'tasks.sqlite'));
  try {
    const engine = new Engine(store);
    const { coordinator, plan, taskId } = build(store, engine, join(dir, 'ws'));
    coordinator.createTask({ taskId, title: `real ${agent}`, goal: GOAL, plan, limitMinor: 100 });
    const task = await coordinator.run(taskId);
    const delivery = task.workflow?.assignments[0]?.delivery;
    proof.results.push({ agent, status: task.status, delivery: delivery?.status, artifactResult: delivery?.artifacts?.result?.toString().slice(0, 80) });
  } catch (e) {
    proof.results.push({ agent, status: 'failed', error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
  } finally {
    try { store.close(); } catch {}
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }); } catch {}
  }
}

try {
  // DSH via a subscription clone (so no official-cash reconciliation path) + HostAgentWorker('dsh')
  await runOne('dsh', (store, engine, ws) => {
    const desc = { ...REAL_DSH_WORKER, billingSource: 'subscription' };
    const coordinator = new TaskCoordinator({ store, engine, authorization: 'synthetic-approved', executionMode: 'real', approvalMode: 'auto',
      workers: [{ descriptor: desc, worker: new HostAgentWorker({ agent: 'dsh', workspaceRoot: ws, timeoutMs: 300000 }) }] });
    return { coordinator, plan: createRealDshPlan('dsh-dispatch', GOAL), taskId: 'dsh-dispatch' };
  });
  await runOne('codex', (store, engine, ws) => {
    const coordinator = createRealCodexCoordinator(store, engine, '', ws, 'auto');
    return { coordinator, plan: createRealCodexPlan('codex-dispatch', GOAL), taskId: 'codex-dispatch' };
  });
  await runOne('claude', (store, engine, ws) => {
    const coordinator = createRealClaudeCoordinator(store, engine, ws, 'auto');
    return { coordinator, plan: createRealClaudePlan('claude-dispatch', GOAL), taskId: 'claude-dispatch' };
  });
  proof.allCompleted = proof.results.length === 3 && proof.results.every((r) => r.status === 'completed' && r.delivery === 'completed');
} catch (e) {
  proof.error = e instanceof Error ? e.message.slice(0, 200) : String(e);
}
mkdirSync(resolve('docs/verification'), { recursive: true });
mkdirSync(resolve('.cache/verification'), { recursive: true });
const json = JSON.stringify(proof, null, 2) + '\n';
writeFileSync(resolve('docs/verification/s10-unified-dispatch-2026-11-19.json'), json);
writeFileSync(resolve('.cache/verification/s10-unified-dispatch.json'), json);
console.log(json);
if (!proof.allCompleted) process.exitCode = 1;
