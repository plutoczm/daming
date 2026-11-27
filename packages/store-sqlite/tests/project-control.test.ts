import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConflictError, Engine } from '@daming/core';
import type { ProjectCommand } from '@daming/core';
import { SqliteStore } from '../src/index.ts';

test('persists project documents and event deduplication alongside existing tasks', t => {
  const dir = mkdtempSync(join(tmpdir(), 'daming project '));
  const path = join(dir, 'state.sqlite');
  let store = new SqliteStore(path);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  let engine = new Engine(store, store);
  const at = '2026-11-18T00:00:00Z';
  engine.execute({
    type: 'create_task', title: 'Legacy task', goal: 'Keep its persisted history',
    context: { taskId: 'legacy', runId: 'run', attemptId: 'attempt', sourceId: 'host', eventId: 'create', occurredAt: at },
  });
  const create = {
    type: 'create_project', projectId: 'project', eventId: 'create', at, expectedRevision: 0,
    ownerId: 'owner', goal: 'New project', documents: {
      spec: [{ id: 'a', text: 'Original' }], plan: [{ id: 'p', text: 'Implement' }],
      acceptance: [{ id: 'test', text: 'Verify' }],
    },
  } satisfies ProjectCommand;
  engine.executeProject(create);
  engine.executeProject({ ...create, projectId: 'independent' });
  engine.executeProject({
    projectId: 'project', eventId: 'question', at, expectedRevision: 1,
    type: 'open_decision', decisionId: 'q', kind: 'clarification', question: 'What should A say?',
  });
  const answer = {
    projectId: 'project', eventId: 'answer', at, expectedRevision: 2,
    type: 'answer_decision', decisionId: 'q', targetRevision: 2, actorId: 'owner',
    response: { action: 'revise', text: 'Use the new text', changes: [
      { document: 'spec', operation: 'replace', clause: { id: 'a', text: 'New text' } },
    ] },
  } satisfies ProjectCommand;
  const first = engine.executeProject(answer);
  store.close();
  store = new SqliteStore(path);
  engine = new Engine(store, store);
  const repeated = engine.executeProject(answer);
  assert.equal(repeated.duplicate, true);
  assert.deepEqual(repeated.event, first.event);
  assert.throws(() => engine.executeProject({ ...answer, response: { action: 'reply', text: 'Different' } }), ConflictError);
  assert.equal(engine.getProject('project')?.documents.spec.revision, 2);
  assert.equal(store.getProjectEvent('project', 'create')?.snapshot.documents.spec.clauses[0]?.text, 'Original');
  assert.equal(engine.getProject('independent')?.revision, 1);
  assert.equal(engine.getTask('legacy')?.version, 1);
  assert.equal(store.listEvents('legacy').length, 1);
});
