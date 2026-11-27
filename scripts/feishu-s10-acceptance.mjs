import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../packages/core/src/index.ts';
import { SqliteStore } from '../packages/store-sqlite/src/index.ts';
import { MemoryFeishuCardRepository } from '../apps/server/src/feishu-channel.ts';
import { createFeishuLongConnection } from '../apps/server/src/feishu-long-connection.ts';
import { ProjectControl } from '../apps/server/src/project-control.ts';
import { loadEnv } from './load-env.mjs';

loadEnv();
const { FEISHU_APP_ID: appId, FEISHU_APP_SECRET: appSecret, FEISHU_OWNER_OPEN_ID: ownerOpenId } = process.env;
if (!appId || !appSecret || !ownerOpenId) {
  console.error('Configure FEISHU_APP_ID, FEISHU_APP_SECRET and FEISHU_OWNER_OPEN_ID locally.');
  process.exit(2);
}

const sendCards = process.argv.includes('--send');
const configureCallbacks = process.argv.includes('--setup');
const runId = randomUUID();
const out = resolve('.cache/verification/feishu-s10-' + runId);
mkdirSync(out, { recursive: true });
const proof = { scope: 'feishu_owner_decisions', modelRequests: 0, connected: false, steps: [] };
const store = new SqliteStore(join(out, 'project.sqlite'));
const engine = new Engine(store, store);
const at = () => new Date().toISOString();
const control = new ProjectControl(engine, at);
const projectOwnerId = 's10-feishu-owner';
const pauseReason = { kind: 'manual', id: 'feishu-s10-check' };
let socket;

function createProject(projectId) {
  return engine.executeProject({
    type: 'create_project', eventId: 'create', projectId, ownerId: projectOwnerId,
    expectedRevision: 0, at: at(), goal: 'S10 Feishu test card', documents: {
      spec: [{ id: 'scope', text: 'Verify Feishu owner decisions' }],
      plan: [{ id: 'plan', text: 'Initial test plan' }],
      acceptance: [{ id: 'check', text: 'Feishu callback is durable and bound to the owner' }],
    },
  }).project;
}

function openDecision(projectId, decisionId, question, content) {
  const current = engine.getProject(projectId);
  return engine.executeProject({
    type: 'open_decision', eventId: 'open-' + decisionId, projectId,
    expectedRevision: current.revision, at: at(), decisionId, question, ...content,
  }).project.decisions.find(decision => decision.decisionId === decisionId);
}

async function verifyAction(projectId, decision, body, action, label, verify) {
  const expiry = Date.now() + 180_000;
  await socket.publish({
    projectId, decisionId: decision.decisionId, targetRevision: decision.targetRevision,
    decisionKind: decision.kind, ownerOpenId, expiresAtMs: expiry,
    title: '大铭 S10 测试卡', body, buttons: [{ action, label }],
  });
  console.log(`等待飞书本人点击「${label}」`);
  while (Date.now() < expiry) {
    if (verify(engine.getProject(projectId))) {
      proof.steps.push(action);
      console.log(`已记录：${label}`);
      return;
    }
    await delay(300);
  }
  throw new Error('feishu_action_timeout:' + action);
}

try {
  socket = createFeishuLongConnection({
    appId, appSecret, ownerOpenId, projectOwnerId, engine, repository: new MemoryFeishuCardRepository(),
    pause: async projectId => {
      const project = engine.getProject(projectId);
      if (project.control.starts.length) throw new Error('feishu_test_project_has_active_work');
      const barrier = await control.closeProjectStarts(projectId, pauseReason);
      if (barrier.status !== 'stopped') throw new Error('feishu_test_pause_incomplete');
    },
  });
  await socket.start();
  const connectBy = Date.now() + 15_000;
  while (socket.status() !== 'connected' && Date.now() < connectBy) await delay(250);
  if (socket.status() !== 'connected') throw new Error('feishu_long_connection_unavailable');
  proof.connected = true;
  console.log('飞书长连接已建立。');
  if (configureCallbacks) {
    console.log('长连接保持 2 分钟。请在飞书后台保存长连接回调配置。');
    await delay(120_000);
    if (socket.status() !== 'connected') throw new Error('feishu_long_connection_unavailable');
  }
  if (sendCards) {
    const projectId = 'feishu-approval-acceptance-' + runId;
    createProject(projectId);
    const proposal = openDecision(projectId, 'propose', '批准测试计划变更？', {
      kind: 'proposal', changes: [{ document: 'plan', operation: 'replace', clause: { id: 'plan', text: 'Approved test plan' } }],
    });
    await verifyAction(projectId, proposal, '仅批准本次测试计划，不会发起模型请求。', 'approve', '批准测试',
      state => state.decisions.some(item => item.decisionId === 'propose' && item.status === 'answered'));

    const pauseId = 'feishu-pause-' + runId;
    createProject(pauseId);
    const pause = openDecision(pauseId, 'pause-check', '暂停测试项目？', { kind: 'clarification' });
    await verifyAction(pauseId, pause, '仅暂停本次测试项目。', 'pause', '暂停测试',
      state => state.control.barrier?.status === 'stopped' && state.control.blockers.some(item => item.id === pauseReason.id));

    const lease = { projectId, taskId: 'synthetic', attemptId: 'one', startId: 'produce', epoch: engine.getProject(projectId).control.epoch };
    await control.withProjectStart(lease, async () => {});
    const artifactRevision = 'feishu-synthetic-receipt';
    const checkRef = 'feishu-owner-approval-observed';
    await control.recordOutput(lease, { kind: 'artifact', artifactRevision });
    await control.recordOutput(lease, { kind: 'check', artifactRevision, checkRef });
    await control.settleStart(lease);
    const acceptance = openDecision(projectId, 'accept', '验收飞书测试回执？', {
      kind: 'acceptance', evidence: { artifactRevision, checkRefs: [checkRef] },
    });
    await verifyAction(projectId, acceptance, '验收范围仅为本次飞书测试回执。', 'accept', '验收测试',
      state => state.accepted?.decisionId === acceptance.decisionId);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : '';
  proof.failure = /^feishu_[a-z_]+(?::[a-z_]+)?$/.test(message) ? message : 'feishu_acceptance_failed';
  console.error(proof.failure);
  process.exitCode = 1;
} finally {
  socket?.close();
  store.close();
  writeFileSync(join(out, 'proof.json'), JSON.stringify(proof, null, 2) + '\n');
}
