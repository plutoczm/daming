import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConflictError, Engine } from '@daming/core';
import { SqliteStore } from '@daming/store-sqlite';
import { ProjectControl } from '../src/project-control.ts';

const at = '2026-11-18T00:00:00Z';
const manual = { kind: 'manual', id: 'owner-pause' } as const;
const resource = { kind: 'resource', id: 'account-window' } as const;
const lease = (projectId: string, epoch = 0, startId = 'send') => ({
  projectId, epoch, startId, taskId: 'task', attemptId: 'attempt',
});

function setup(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'daming project control '));
  const path = join(directory, 'projects.sqlite');
  let store = new SqliteStore(path);
  const open = () => {
    const engine = new Engine(store, store);
    return { engine, control: new ProjectControl(engine, () => at) };
  };
  const first = open();
  for (const projectId of ['a', 'b']) first.engine.executeProject({
    type: 'create_project', projectId, eventId: 'create', expectedRevision: 0, at,
    goal: 'Deliver', ownerId: 'owner', documents: {
      spec: [{ id: 'spec', text: 'Spec' }], plan: [{ id: 'plan', text: 'Plan' }],
      acceptance: [{ id: 'checks', text: 'Checks' }],
    },
  });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { ...first, reopen: () => { store.close(); store = new SqliteStore(path); return open(); } };
}

test('pausing first fences queued starts and leaves another project available', async t => {
  const { control } = setup(t);
  const stop = control.closeProjectStarts('a', manual);
  let calls = 0;
  await assert.rejects(control.withProjectStart(lease('a'), async () => { ++calls; }), ConflictError);
  assert.equal((await stop).status, 'stopped');
  assert.equal(calls, 0);
  assert.equal(await control.withProjectStart(lease('b'), async () => 'other project launched'), 'other project launched');
});

test('a start first enters the stop snapshot and blocks completion without evidence', async t => {
  const { control, engine } = setup(t);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<string>();
  const launch = control.withProjectStart(lease('a'), () => {
    started.resolve();
    return release.promise;
  });
  await started.promise;
  const stopping = control.closeProjectStarts('a', manual);
  assert.equal(await control.withProjectStart(lease('b'), async () => 'independent'), 'independent');
  release.resolve('launched');
  assert.equal(await launch, 'launched');
  const barrier = await stopping;
  assert.equal(barrier.status, 'pausing');
  assert.deepEqual(barrier.starts.map(start => start.startId), ['send']);
  await assert.rejects(control.recordStopEvidence('a', barrier.barrierId, { reference: 'no result', results: [] }), ConflictError);
  await control.recordStopEvidence('a', barrier.barrierId, {
    reference: 'runtime confirmed exit but provider receipt unavailable',
    results: [{ startId: 'send', stopped: true, outcome: 'unknown' }],
  });
  assert.equal(engine.getProject('a')?.control.barrier?.status, 'recovery_required');
  await assert.rejects(control.clearBlocker('a', manual), ConflictError);
});

test('restart retains stacked blockers and old leases cannot publish or send', async t => {
  const h = setup(t);
  await h.control.closeProjectStarts('a', manual);
  await h.control.closeProjectStarts('a', resource);
  const current = h.engine.getProject('a')!;
  h.engine.executeProject({
    type: 'open_decision', projectId: 'a', eventId: 'decision', expectedRevision: current.revision, at,
    decisionId: 'q', kind: 'clarification', question: 'Which output format should be used?',
  });
  const { control, engine } = h.reopen();
  await control.clearBlocker('a', resource);
  assert.deepEqual(engine.getProject('a')?.control.blockers, [manual]);
  assert.equal(await control.recordOutput(lease('a'), { kind: 'artifact', artifactRevision: 'late' }), false);
  assert.equal(engine.getProject('a')?.control.delivery, undefined);
  await control.clearBlocker('a', manual);
  const epoch = engine.getProject('a')!.control.epoch;
  await assert.rejects(control.withProjectStart(lease('a', epoch), async () => 'must not launch'), ConflictError);
  const pending = engine.getProject('a')!;
  engine.executeProject({
    type: 'answer_decision', projectId: 'a', eventId: 'answer', expectedRevision: pending.revision, at,
    decisionId: 'q', targetRevision: pending.decisions[0]!.targetRevision, actorId: 'owner',
    response: { action: 'reply', text: 'Use Markdown' },
  });
  await assert.rejects(control.withProjectStart(lease('a'), async () => 'stale epoch'), ConflictError);
  assert.equal(await control.withProjectStart(lease('a', epoch), async () => 'resumed'), 'resumed');
});

test('restart with a claimed start requires release evidence before more work', async t => {
  const h = setup(t);
  await h.control.withProjectStart(lease('a'), async () => 'started');
  const { control, engine } = h.reopen();
  await assert.rejects(control.withProjectStart(lease('a', 0, 'other'), async () => 'must not launch'), ConflictError);
  const recovery = { kind: 'recovery', id: 'old-host' } as const;
  const barrier = await control.closeProjectStarts('a', recovery);
  await control.recordStopEvidence('a', barrier.barrierId, {
    reference: 'confirmed runtime stopped and outcome settled',
    results: [{ startId: 'send', stopped: true, outcome: 'settled' }],
  });
  await control.clearBlocker('a', recovery);
  assert.equal(engine.getProject('a')?.control.starts.length, 0);
  assert.equal(await control.withProjectStart(lease('a', barrier.epoch, 'new'), async () => 'new run'), 'new run');
});
