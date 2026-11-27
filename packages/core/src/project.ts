import { ConflictError, DomainError } from './errors.ts';
import { applyControlCommand } from './project-control.ts';
import type { ProjectControlCommand, ProjectControlState } from './project-control.ts';

const documentKinds = ['spec', 'plan', 'acceptance'] as const;
type DocumentKind = typeof documentKinds[number];
type DocumentClause = Readonly<{ id: string; text: string }>;
type DocumentRevision = Readonly<{ revision: number; clauses: readonly DocumentClause[] }>;
type Documents = Readonly<Record<DocumentKind, DocumentRevision>>;
type DocumentRevisions = Readonly<Record<DocumentKind, number>>;
type DocumentChange = Readonly<{ document: DocumentKind; operation: 'add' | 'replace'; clause: DocumentClause }>;
type DeliveryEvidence = Readonly<{ artifactRevision: string; checkRefs: readonly string[] }>;

type DecisionContent =
  | { kind: 'clarification' }
  | { kind: 'proposal'; changes: readonly DocumentChange[] }
  | { kind: 'acceptance'; evidence: DeliveryEvidence };

type Decision = Readonly<DecisionContent & {
  decisionId: string;
  question: string;
  targetRevision: number;
  documentRevisions: DocumentRevisions;
  status: 'pending' | 'answered' | 'superseded';
  parentDecisionId?: string;
}>;

export interface Project {
  readonly projectId: string;
  readonly ownerId: string;
  readonly goal: string;
  readonly revision: number;
  readonly documents: Documents;
  readonly decisions: readonly Decision[];
  readonly control: ProjectControlState;
  readonly accepted?: DeliveryEvidence & { readonly decisionId: string; readonly documentRevisions: DocumentRevisions };
}

type DecisionResponse = { text: string } & (
  | { action: 'reply' | 'approve' | 'reject' | 'accept' }
  | { action: 'revise'; changes: readonly DocumentChange[] }
  | { action: 'unclear'; followup: string }
);

export type ProjectCommand = {
  projectId: string;
  eventId: string;
  at: string;
  expectedRevision: number;
} & (
  | { type: 'create_project'; ownerId: string; goal: string; documents: Record<DocumentKind, readonly DocumentClause[]> }
  | ({ type: 'open_decision'; decisionId: string; question: string } & DecisionContent)
  | ProjectControlCommand
  | {
    type: 'answer_decision';
    decisionId: string;
    targetRevision: number;
    actorId: string;
    artifactRevision?: string;
    response: DecisionResponse;
  }
);

export interface ProjectTransition {
  project: Project;
  type: 'project_created' | 'decision_opened' | 'clarification_requested' | 'decision_answered' | 'delivery_accepted'
    | ProjectControlCommand['type'] | 'project_output_ignored';
}

export interface ProjectEvent {
  projectId: string;
  eventId: string;
  at: string;
  type: ProjectTransition['type'];
  commandJson: string;
  snapshot: Project;
}

export interface ProjectCommandResult {
  duplicate: boolean;
  project: Project;
  event: ProjectEvent;
}

function requireText(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new DomainError('Expected nonempty ' + field);
}

function validateClauses(clauses: readonly DocumentClause[]) {
  if (!Array.isArray(clauses) || !clauses.length) throw new DomainError('Expected document clauses');
  const ids = new Set<string>();
  for (const clause of clauses) {
    requireText(clause?.id, 'clause id');
    requireText(clause.text, 'clause text');
    if (ids.has(clause.id)) throw new DomainError('Duplicate clause id');
    ids.add(clause.id);
  }
}

function reviseDocuments(documents: Documents, changes: readonly DocumentChange[]): Documents {
  if (!Array.isArray(changes as unknown) || !changes.length) throw new DomainError('Expected an explicitly scoped document change');
  const updated = { ...documents };
  const seen = new Set<string>();
  for (const change of changes) {
    if (!documentKinds.includes(change?.document) || !['add', 'replace'].includes(change.operation)) {
      throw new DomainError('Invalid document change');
    }
    const { document, operation, clause } = change;
    validateClauses([clause]);
    const key = JSON.stringify([document, clause.id]);
    if (seen.has(key)) throw new DomainError('A clause can be changed only once per answer');
    seen.add(key);
    const clauses = [...updated[document].clauses];
    const index = clauses.findIndex(item => item.id === clause.id);
    if (operation === 'replace' && index >= 0) clauses[index] = clause;
    else if (operation === 'add' && index < 0) clauses.push(clause);
    else throw new ConflictError('Document change does not match the current clause');
    updated[document] = { revision: documents[document].revision + 1, clauses };
  }
  return updated;
}

function revisions(documents: Documents): DocumentRevisions {
  return {
    spec: documents.spec.revision, plan: documents.plan.revision, acceptance: documents.acceptance.revision,
  };
}

function createProject(command: Extract<ProjectCommand, { type: 'create_project' }>): ProjectTransition {
  requireText(command.ownerId, 'project owner');
  requireText(command.goal, 'project goal');
  for (const kind of documentKinds) validateClauses(command.documents?.[kind]);
  const documents = {
    spec: { revision: 1, clauses: command.documents.spec },
    plan: { revision: 1, clauses: command.documents.plan },
    acceptance: { revision: 1, clauses: command.documents.acceptance },
  };
  return {
    project: {
      projectId: command.projectId, ownerId: command.ownerId, goal: command.goal, revision: 1, documents,
      decisions: [], control: { epoch: 0, blockers: [], starts: [] },
    },
    type: 'project_created',
  };
}

function openDecision(current: Project, command: Extract<ProjectCommand, { type: 'open_decision' }>): ProjectTransition {
  if (current.control.starts.length || (current.control.barrier && current.control.barrier.status !== 'stopped')) {
    throw new ConflictError('Wait for confirmed project stop before opening a decision');
  }
  requireText(command.decisionId, 'decision id');
  requireText(command.question, 'decision question');
  if (current.decisions.some(decision => decision.decisionId === command.decisionId)) {
    throw new ConflictError('Decision id already exists');
  }
  let content: DecisionContent;
  switch (command.kind) {
    case 'clarification':
      content = { kind: command.kind };
      break;
    case 'proposal':
      reviseDocuments(current.documents, command.changes);
      content = { kind: command.kind, changes: command.changes };
      break;
    case 'acceptance': {
      const unresolved = current.decisions.some(decision => decision.kind !== 'acceptance' && decision.status === 'pending');
      if (unresolved) throw new DomainError('Resolve pending requirements before opening acceptance');
      const evidence = command.evidence;
      requireText(evidence?.artifactRevision, 'artifact revision');
      if (!Array.isArray(evidence.checkRefs) || !evidence.checkRefs.length) throw new DomainError('Expected trusted checks');
      for (const ref of evidence.checkRefs) requireText(ref, 'check reference');
      const delivery = current.control.delivery;
      if (!delivery || delivery.artifactRevision !== evidence.artifactRevision ||
          new Set(evidence.checkRefs).size !== evidence.checkRefs.length ||
          !evidence.checkRefs.every(ref => delivery.checkRefs.includes(ref))) {
        throw new ConflictError('Acceptance evidence does not match the current delivery');
      }
      content = { kind: command.kind, evidence };
      break;
    }
    default:
      throw new DomainError('Unknown decision kind');
  }
  const revision = current.revision + 1;
  const decisions = current.decisions.map(decision =>
    decision.status === 'pending' && decision.kind === 'acceptance'
      ? { ...decision, status: 'superseded' as const } : decision);
  decisions.push({
    ...content, decisionId: command.decisionId, question: command.question,
    targetRevision: revision, documentRevisions: revisions(current.documents), status: 'pending',
  });
  const control = current.control.barrier || current.decisions.some(decision => decision.status === 'pending')
    ? current.control : { ...current.control, epoch: current.control.epoch + 1 };
  return { project: { ...current, revision, decisions, control }, type: 'decision_opened' };
}

function answerDecision(current: Project, command: Extract<ProjectCommand, { type: 'answer_decision' }>): ProjectTransition {
  // The Host must supply the actor from authenticated identity, not from an untrusted request body.
  if (command.actorId !== current.ownerId) throw new DomainError('Decision actor is not the project owner');
  const decision = current.decisions.find(item => item.decisionId === command.decisionId);
  if (!decision || decision.status !== 'pending' || command.targetRevision !== decision.targetRevision ||
      current.decisions.some(item => item.parentDecisionId === decision.decisionId && item.status === 'pending')) {
    throw new ConflictError('Decision is stale or unavailable');
  }
  if (decision.kind === 'acceptance' && command.artifactRevision !== decision.evidence.artifactRevision) {
    throw new ConflictError('Acceptance artifact revision does not match');
  }
  const { response } = command;
  requireText(response?.text, 'decision response');
  const revision = current.revision + 1;
  if (response.action === 'unclear') {
    requireText(response.followup, 'clarification question');
    const decisionId = 'followup:' + command.eventId;
    if (current.decisions.some(item => item.decisionId === decisionId)) throw new ConflictError('Decision id already exists');
    const followup: Decision = {
      ...decision, decisionId, question: response.followup, targetRevision: revision, parentDecisionId: decision.decisionId,
    };
    return {
      project: { ...current, revision, decisions: [...current.decisions, followup] },
      type: 'clarification_requested',
    };
  }

  let documents = current.documents;
  let accepted: Project['accepted'];
  if (decision.kind === 'proposal' && response.action === 'approve') {
    documents = reviseDocuments(documents, decision.changes);
  } else if (decision.kind === 'clarification' && response.action === 'revise') {
    documents = reviseDocuments(documents, response.changes);
  } else if (decision.kind === 'acceptance' && response.action === 'accept') {
    accepted = { ...decision.evidence, decisionId: decision.decisionId, documentRevisions: decision.documentRevisions };
  } else if (!(decision.kind === 'clarification' && response.action === 'reply') &&
             !(decision.kind !== 'clarification' && response.action === 'reject')) {
    throw new DomainError('Response action does not match the decision kind');
  }

  const resolved = new Set([decision.decisionId]);
  let parentId = decision.parentDecisionId;
  while (parentId !== undefined) {
    resolved.add(parentId);
    parentId = current.decisions.find(item => item.decisionId === parentId)?.parentDecisionId;
  }
  const decisions = current.decisions.map(item => {
    if (resolved.has(item.decisionId)) return { ...item, status: 'answered' as const };
    if (item.status === 'pending' && documents !== current.documents) return { ...item, status: 'superseded' as const };
    return item;
  });
  const { delivery: oldDelivery, ...controlWithoutDelivery } = current.control;
  return {
    project: {
      ...current, revision, documents, decisions,
      control: documents === current.documents ? current.control : controlWithoutDelivery,
      ...(accepted ? { accepted } : {}),
    },
    type: accepted ? 'delivery_accepted' : 'decision_answered',
  };
}

/** A pure project transition. Event deduplication and both durable writes are owned by Engine. */
export function applyProjectCommand(current: Project | undefined, command: ProjectCommand): ProjectTransition {
  requireText(command.projectId, 'project id');
  requireText(command.eventId, 'event id');
  if (typeof command.at !== 'string' || !/(?:Z|[+-]\d\d:\d\d)$/.test(command.at) || !Number.isFinite(Date.parse(command.at))) {
    throw new DomainError('Expected a project timestamp with timezone');
  }
  if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision !== (current?.revision ?? 0) ||
      (current && current.projectId !== command.projectId)) {
    throw new ConflictError('Project revision does not match');
  }
  if (!current && command.type === 'create_project') return createProject(command);
  if (!current) throw new DomainError('Project does not exist');
  if (command.type === 'create_project') throw new ConflictError('Project already exists');
  if (current.accepted) throw new ConflictError('Accepted project is immutable');
  if (command.type === 'open_decision') return openDecision(current, command);
  if (command.type === 'answer_decision') return answerDecision(current, command);
  const revision = current.revision + 1;
  const control = applyControlCommand(current.control, command, current.projectId, revision,
    current.decisions.some(decision => decision.status === 'pending'));
  if (!control) throw new DomainError('Unknown project command');
  const type = command.type === 'record_project_output' && control === current.control ? 'project_output_ignored' : command.type;
  return { project: { ...current, revision, control }, type };
}
