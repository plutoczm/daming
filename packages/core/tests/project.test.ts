import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyProjectCommand, ConflictError, DomainError } from '../src/index.ts';
import type { ProjectCommand } from '../src/index.ts';

const projectId = 'project-a';
const ownerId = 'user-a';
const at = '2026-11-18T00:00:00Z';
const context = (eventId: string, expectedRevision: number) => ({ projectId, eventId, expectedRevision, at });
const docs = {
  spec: [{ id: 'a', text: 'Keep A' }, { id: 'b', text: 'Original B' }],
  plan: [{ id: 'build', text: 'Build the project' }],
  acceptance: [{ id: 'test', text: 'Pass the integration test' }],
};

function createProject() {
  return applyProjectCommand(undefined, {
    ...context('create', 0), type: 'create_project', ownerId, goal: 'Deliver the project', documents: docs,
  }).project;
}

const changes = [
  { document: 'spec', operation: 'replace', clause: { id: 'b', text: 'Revised B' } },
  { document: 'spec', operation: 'add', clause: { id: 'c', text: 'Append C' } },
] as const;

test('applies an explicitly scoped replacement and a separate addition', () => {
  const initial = createProject();
  const question = applyProjectCommand(initial, {
    ...context('question', 1), type: 'open_decision', decisionId: 'q', question: 'Confirm the requested scope',
    kind: 'clarification',
  }).project;
  const answer = {
    ...context('answer', 2), type: 'answer_decision', decisionId: 'q', targetRevision: 2, actorId: ownerId,
    response: { action: 'revise', text: 'Replace B and append C', changes },
  } satisfies ProjectCommand;
  assert.throws(() => applyProjectCommand(question, { ...answer, actorId: 'user-b' }), DomainError);
  assert.throws(() => applyProjectCommand(question, { ...answer, targetRevision: 1 }), ConflictError);
  const result = applyProjectCommand(question, answer).project;
  assert.deepEqual(result.documents.spec, {
    revision: 2, clauses: [docs.spec[0], changes[0].clause, changes[1].clause],
  });
  assert.deepEqual(result.documents.plan, initial.documents.plan);
  assert.deepEqual(question.documents.spec.clauses, docs.spec);
  assert.throws(() => applyProjectCommand(result, { ...answer, expectedRevision: 3 }), ConflictError);
});

test('ambiguous answers append a clarification and leave the original question open', () => {
  const { project } = applyProjectCommand(createProject(), {
    ...context('question', 1), type: 'open_decision', decisionId: 'q', question: 'What should change?',
    kind: 'clarification',
  });
  const { project: next } = applyProjectCommand(project, {
    ...context('unclear', 2), type: 'answer_decision', decisionId: 'q', targetRevision: 2, actorId: ownerId,
    response: { action: 'unclear', text: 'Do it differently', followup: 'Which clause should be replaced?' },
  });
  assert.deepEqual(next.documents, project.documents);
  assert.deepEqual(next.decisions[0], project.decisions[0]);
  assert.equal(next.decisions[1]?.parentDecisionId, 'q');
  assert.equal(next.decisions[1]?.status, 'pending');
});

test('an agent proposal becomes effective only on owner approval of the recorded diff', () => {
  const { project } = applyProjectCommand(createProject(), {
    ...context('proposal', 1), type: 'open_decision', decisionId: 'p', question: 'B cannot be delivered as written',
    kind: 'proposal', changes,
  });
  assert.deepEqual(project.documents.spec.clauses, docs.spec);
  const { project: approved } = applyProjectCommand(project, {
    ...context('approve', 2), type: 'answer_decision', decisionId: 'p', targetRevision: 2, actorId: ownerId,
    response: { action: 'approve', text: 'Apply the proposed diff' },
  });
  assert.equal(approved.documents.spec.clauses[1]?.text, 'Revised B');
});

test('acceptance requires the owner to accept the artifact revision covered by trusted checks', () => {
  const lease = { projectId, taskId: 'task', attemptId: 'attempt', startId: 'write-artifact', epoch: 0 };
  const hostId = 'host';
  let state = createProject();
  state = applyProjectCommand(state, {
    ...context('start', state.revision), type: 'start_project_operation', lease, hostId,
  }).project;
  state = applyProjectCommand(state, {
    ...context('artifact-v4', state.revision), type: 'record_project_output', lease, hostId,
    output: { kind: 'artifact', artifactRevision: 'v4' },
  }).project;
  state = applyProjectCommand(state, {
    ...context('check-v4', state.revision), type: 'record_project_output', lease, hostId,
    output: { kind: 'check', artifactRevision: 'v4', checkRef: 'check-v4' },
  }).project;
  state = applyProjectCommand(state, {
    ...context('settled', state.revision), type: 'settle_project_operation', lease, hostId,
  }).project;
  const open = {
    ...context('delivery', state.revision), type: 'open_decision', decisionId: 'accept', question: 'Accept this delivery?',
    kind: 'acceptance', evidence: { artifactRevision: 'v4', checkRefs: ['check-v4'] },
  } satisfies ProjectCommand;
  assert.throws(() => applyProjectCommand(state, { ...open, evidence: { artifactRevision: 'v4', checkRefs: ['unrecorded'] } }), ConflictError);
  const { project } = applyProjectCommand(state, open);
  const answer = {
    ...context('accept', project.revision), type: 'answer_decision', decisionId: 'accept', targetRevision: project.revision, actorId: ownerId,
    artifactRevision: 'v4', response: { action: 'accept', text: 'Approved' },
  } satisfies ProjectCommand;
  assert.throws(() => applyProjectCommand(project, { ...answer, artifactRevision: 'v3' }), ConflictError);
  const { project: completed } = applyProjectCommand(project, answer);
  assert.deepEqual(completed.accepted, {
    decisionId: 'accept', artifactRevision: 'v4', checkRefs: ['check-v4'],
    documentRevisions: { spec: 1, plan: 1, acceptance: 1 },
  });
});
