import { randomUUID } from 'node:crypto';
import { ConflictError, DomainError } from '@daming/core';
import type { BlockReason, Engine, LeaseRef, Project, ProjectCommand, ProjectOutput, StopBarrier, StopEvidence } from '@daming/core';

type StartOptions = { authorize?: () => void; offlineContainer?: string };

/** Use one instance per exclusive Host. The durable gate is changed only by the Engine. */
export class ProjectControl {
  private readonly hostId = randomUUID();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly engine: Engine;
  private readonly now: () => string;

  constructor(engine: Engine, now: () => string) {
    this.engine = engine;
    this.now = now;
  }

  private async serial<T>(projectId: string, work: (project: Project) => T | Promise<T>): Promise<T> {
    const previous = this.queues.get(projectId) ?? Promise.resolve();
    const done = Promise.withResolvers<void>();
    const tail = previous.then(() => done.promise);
    this.queues.set(projectId, tail);
    await previous;
    try {
      const project = this.engine.getProject(projectId);
      if (!project) throw new DomainError('Project does not exist');
      return await work(project);
    } finally {
      done.resolve();
      if (this.queues.get(projectId) === tail) this.queues.delete(projectId);
    }
  }

  private context(project: Project, eventId = randomUUID().toString()) {
    return { projectId: project.projectId, expectedRevision: project.revision, eventId, at: this.now() };
  }

  /** The callback must return after actual launch, before waiting for completion. */
  withProjectStart<T>(lease: LeaseRef, start: () => Promise<T>, options: StartOptions = {}): Promise<T> {
    return this.serial(lease.projectId, async project => {
      const { authorize, offlineContainer } = options;
      const claimed = this.engine.executeProject({
        ...this.context(project, 'start:' + lease.startId), type: 'start_project_operation', lease, hostId: this.hostId,
        ...(offlineContainer ? { offlineContainer } : {}),
      });
      if (claimed.duplicate) throw new ConflictError('Project start already claimed');
      if (authorize) {
        try {
          // Authorization may only make local durable changes. No external action has started.
          authorize();
        } catch (error) {
          this.settle(this.engine.getProject(lease.projectId)!, lease);
          throw error;
        }
      }
      try {
        return await start();
      } catch (error) {
        this.close(this.engine.getProject(lease.projectId)!, { kind: 'reconciliation', id: lease.startId });
        throw error;
      }
    });
  }

  private close(project: Project, reason: BlockReason): StopBarrier {
    const command: ProjectCommand = {
      ...this.context(project), type: 'close_project_starts', reason, barrierId: randomUUID(),
    };
    return this.engine.executeProject(command).project.control.barrier!;
  }

  closeProjectStarts(projectId: string, reason: BlockReason): Promise<StopBarrier> {
    return this.serial(projectId, project => this.close(project, reason));
  }

  recordStopEvidence(projectId: string, barrierId: string, evidence: StopEvidence): Promise<StopBarrier> {
    return this.serial(projectId, project => {
      return this.engine.executeProject({
        ...this.context(project), type: 'record_project_stop', barrierId, evidence,
      }).project.control.barrier!;
    });
  }

  clearBlocker(projectId: string, reason: BlockReason): Promise<void> {
    return this.serial(projectId, project => {
      this.engine.executeProject({ ...this.context(project), type: 'clear_project_blocker', reason });
    });
  }

  settleStart(lease: LeaseRef, reason?: BlockReason): Promise<void> {
    return this.serial(lease.projectId, project => this.settle(project, lease, reason));
  }

  requireNativeContainer(lease: LeaseRef): string {
    const project = this.engine.getProject(lease.projectId);
    if (!project || project.accepted || project.control.epoch !== lease.epoch || project.control.blockers.length ||
        project.decisions.some(decision => decision.status === 'pending')) {
      throw new ConflictError('Native project lease is fenced');
    }
    const start = project.control.starts.find(value =>
      value.hostId === this.hostId && value.startId === lease.startId && value.taskId === lease.taskId &&
      value.attemptId === lease.attemptId && value.epoch === lease.epoch,
    );
    if (!start?.offlineContainer) throw new ConflictError('Native project lease is unavailable');
    return start.offlineContainer;
  }

  private settle(project: Project, lease: LeaseRef, reason?: BlockReason): void {
    this.engine.executeProject({
      ...this.context(project), type: 'settle_project_operation', lease, hostId: this.hostId,
      ...(reason ? { block: { reason, barrierId: randomUUID() } } : {}),
    });
  }

  recordOutput(lease: LeaseRef, output: ProjectOutput): Promise<boolean> {
    return this.serial(lease.projectId, project => {
      const { event } = this.engine.executeProject({
        ...this.context(project), type: 'record_project_output', lease, hostId: this.hostId, output,
      });
      return event.type === 'record_project_output';
    });
  }
}
