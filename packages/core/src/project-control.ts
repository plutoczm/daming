import { ConflictError, DomainError } from './errors.ts';

const blockerKinds = ['manual', 'decision', 'resource', 'budget', 'reconciliation', 'recovery'] as const;
export type BlockReason = Readonly<{ kind: typeof blockerKinds[number]; id: string }>;
export type LeaseRef = Readonly<{ projectId: string; taskId: string; attemptId: string; epoch: number; startId: string }>;
type Start = LeaseRef & Readonly<{ hostId: string; offlineContainer?: string }>;
export type StopEvidence = Readonly<{
  reference: string;
  results: readonly Readonly<{ startId: string; stopped: boolean; outcome: 'settled' | 'unknown'; reference?: string }>[];
}>;
export type StopBarrier = Readonly<{
  barrierId: string;
  epoch: number;
  status: 'pausing' | 'stopped' | 'recovery_required';
  starts: readonly Start[];
  frozenRevision?: number;
}>;
export type ProjectOutput = Readonly<{ artifactRevision: string } & (
  { kind: 'artifact' } | { kind: 'check'; checkRef: string }
)>;
export interface ProjectControlState {
  readonly epoch: number;
  readonly blockers: readonly BlockReason[];
  readonly starts: readonly Start[];
  readonly barrier?: StopBarrier;
  readonly delivery?: Readonly<{ artifactRevision: string; checkRefs: readonly string[] }>;
}

export type ProjectControlCommand =
  | { type: 'start_project_operation'; lease: LeaseRef; hostId: string; offlineContainer?: string }
  | { type: 'settle_project_operation'; lease: LeaseRef; hostId: string; block?: { reason: BlockReason; barrierId: string } }
  | { type: 'close_project_starts'; reason: BlockReason; barrierId: string }
  | { type: 'record_project_stop'; barrierId: string; evidence: StopEvidence }
  | { type: 'clear_project_blocker'; reason: BlockReason }
  | { type: 'record_project_output'; lease: LeaseRef; hostId: string; output: ProjectOutput };

function sameReason(left: BlockReason, right: BlockReason): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function requireText(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') throw new DomainError('Expected control reference');
}

function validateReason(reason: BlockReason) {
  if (!reason || !blockerKinds.includes(reason.kind)) throw new DomainError('Unknown project blocker');
  requireText(reason.id);
}

function assertLease(lease: LeaseRef, projectId: string, hostId: string) {
  if (!lease || lease.projectId !== projectId) throw new ConflictError('Mismatched project lease');
  requireText(lease.startId);
  requireText(lease.taskId);
  requireText(lease.attemptId);
  requireText(hostId);
}

function matchesStart(start: Start, lease: LeaseRef, hostId: string): boolean {
  return start.startId === lease.startId && start.epoch === lease.epoch && start.hostId === hostId &&
    start.taskId === lease.taskId && start.attemptId === lease.attemptId;
}

function verifyStop(barrier: StopBarrier, evidence: StopEvidence): boolean {
  requireText(evidence?.reference);
  if (!Array.isArray(evidence.results)) throw new DomainError('Expected stop observations');
  const results = new Map(evidence.results.map(result => [result.startId, result]));
  if (results.size !== evidence.results.length || results.size !== barrier.starts.length ||
      barrier.starts.some(start => !results.has(start.startId))) {
    throw new ConflictError('Stop evidence must cover every tracked start exactly once');
  }
  return barrier.starts.every(start => {
    const result = results.get(start.startId)!;
    return result.stopped === true && result.outcome === 'settled';
  });
}

function closeStarts(control: ProjectControlState, reason: BlockReason, barrierId: string, revision: number): ProjectControlState {
  validateReason(reason);
  requireText(barrierId);
  if (control.blockers.some(existing => sameReason(existing, reason))) return control;
  const blockers = [...control.blockers, reason];
  if (control.barrier) return { ...control, blockers };
  const epoch = control.epoch + 1;
  const barrier: StopBarrier = {
    barrierId, epoch, starts: control.starts,
    ...(control.starts.length ? { status: 'pausing' } : { status: 'stopped', frozenRevision: revision }),
  };
  return { ...control, epoch, blockers, barrier };
}

/** A trusted Host supplies start receipts and stop observations to the Engine. */
export function applyControlCommand(
  control: ProjectControlState,
  command: ProjectControlCommand,
  projectId: string,
  revision: number,
  decisionsPending: boolean,
): ProjectControlState {
  switch (command.type) {
    case 'start_project_operation': {
      const { lease, hostId } = command;
      assertLease(lease, projectId, hostId);
      if (lease.epoch !== control.epoch || decisionsPending || control.blockers.length ||
          control.starts.some(start => start.startId === lease.startId || start.hostId !== hostId)) {
        throw new ConflictError('Project start is fenced or requires recovery');
      }
      const { offlineContainer } = command;
      if (offlineContainer !== undefined && !/^daming-native-[a-f0-9-]{36}$/.test(offlineContainer)) {
        throw new DomainError('Invalid native container reference');
      }
      return { ...control, starts: [...control.starts, { ...lease, hostId, ...(offlineContainer ? { offlineContainer } : {}) }] };
    }
    case 'settle_project_operation': {
      const { lease, hostId } = command;
      assertLease(lease, projectId, hostId);
      const matching = control.starts.find(start => matchesStart(start, lease, hostId));
      if (!matching) return control;
      const updated = control.blockers.length || lease.epoch !== control.epoch
        ? control : { ...control, starts: control.starts.filter(start => start !== matching) };
      return command.block ? closeStarts(updated, command.block.reason, command.block.barrierId, revision) : updated;
    }
    case 'close_project_starts':
      return closeStarts(control, command.reason, command.barrierId, revision);
    case 'record_project_stop': {
      const barrier = control.barrier;
      if (!barrier || barrier.barrierId !== command.barrierId || barrier.status === 'stopped') {
        throw new ConflictError('Stop barrier is stale or already resolved');
      }
      if (!verifyStop(barrier, command.evidence)) {
        return { ...control, barrier: { ...barrier, status: 'recovery_required' } };
      }
      return { ...control, starts: [], barrier: { ...barrier, status: 'stopped', frozenRevision: revision } };
    }
    case 'clear_project_blocker': {
      validateReason(command.reason);
      if (control.barrier?.status !== 'stopped' || !control.blockers.some(reason => sameReason(reason, command.reason))) {
        throw new ConflictError('Project blocker is unavailable or the stop barrier is unsettled');
      }
      const blockers = control.blockers.filter(reason => !sameReason(reason, command.reason));
      if (blockers.length) return { ...control, blockers };
      const { barrier: resolved, ...rest } = control;
      return { ...rest, blockers };
    }
    case 'record_project_output': {
      const { lease, hostId, output } = command;
      assertLease(lease, projectId, hostId);
      if (lease.epoch !== control.epoch || decisionsPending || control.blockers.length ||
          !control.starts.some(start => matchesStart(start, lease, hostId))) return control;
      requireText(output?.artifactRevision);
      if (output.kind === 'artifact') {
        if (control.delivery?.artifactRevision === output.artifactRevision) return control;
        return { ...control, delivery: { artifactRevision: output.artifactRevision, checkRefs: [] } };
      }
      if (output.kind !== 'check') throw new DomainError('Unknown project output');
      requireText(output.checkRef);
      if (control.delivery?.artifactRevision !== output.artifactRevision || control.delivery.checkRefs.includes(output.checkRef)) {
        return control;
      }
      return { ...control, delivery: { ...control.delivery, checkRefs: [...control.delivery.checkRefs, output.checkRef] } };
    }
  }
}
