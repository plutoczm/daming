import { DatabaseSync } from 'node:sqlite';
import type { GovernanceRepository,GovRecords,GovernanceAudit } from '@daming/governance';
import type { ProjectSendPermit, ProjectSpendBudget, ProjectSpendRepository } from '@daming/governance';
import { ConflictError, DomainError, canonicalJson } from '@daming/core';
import type { TaskRepository, Task, StoredEvent, OutboxEffect, ProjectRepository, Project, ProjectEvent } from '@daming/core';

function decode<T>(row:Record<string,unknown>|undefined):T|undefined {
  return row ? JSON.parse(String(row.data)) as T : undefined;
}
/** SQLite is the durable adapter; task facts are changed through Engine. */
export class SqliteStore implements TaskRepository,GovernanceRepository,ProjectRepository,ProjectSpendRepository {
  private readonly db:DatabaseSync;
  private closed=false;
  private savepoint=0;
  constructor(file:string) {
    this.db=new DatabaseSync(file,{timeout:5000,enableForeignKeyConstraints:true,allowExtension:false});
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.atomic(()=>{
        const version=Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
        if(version>4) throw new DomainError('Unsupported database schema version: '+version);
        if(version===0) {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS daming_tasks(
              id TEXT PRIMARY KEY, version INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))
            );
            CREATE TABLE IF NOT EXISTS daming_events(
              sequence INTEGER PRIMARY KEY,
              source_id TEXT NOT NULL,event_id TEXT NOT NULL,
              task_id TEXT NOT NULL REFERENCES daming_tasks(id),
              data TEXT NOT NULL CHECK(json_valid(data)),
              UNIQUE(source_id,event_id)
            );
            CREATE INDEX IF NOT EXISTS daming_events_task ON daming_events(task_id,sequence);
            CREATE TABLE IF NOT EXISTS daming_effects(
              id TEXT PRIMARY KEY,
              task_id TEXT NOT NULL REFERENCES daming_tasks(id),
              idempotency_key TEXT NOT NULL UNIQUE,
              status TEXT NOT NULL CHECK(status IN ('pending','executing','succeeded','needs_reconciliation','failed','cancelled')),
              attempts INTEGER NOT NULL,
              data TEXT NOT NULL CHECK(json_valid(data))
            );
            CREATE INDEX IF NOT EXISTS daming_effects_pending ON daming_effects(status);
            PRAGMA user_version=1;
          `);
        }
        if(version<2) {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS daming_governance(
              collection TEXT NOT NULL CHECK(collection IN ('budgets','quotes','approvals','reservations','executions')),
              id TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES daming_tasks(id),
              version INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),PRIMARY KEY(collection,id)
            );
            CREATE INDEX IF NOT EXISTS daming_governance_task ON daming_governance(collection,task_id);
            CREATE TABLE IF NOT EXISTS daming_governance_audit(
              sequence INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL REFERENCES daming_tasks(id),
              data TEXT NOT NULL CHECK(json_valid(data))
            );
            PRAGMA user_version=2;
          `);
        }
        if(version<3) {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS daming_projects(
              id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))
            );
            CREATE TABLE IF NOT EXISTS daming_project_events(
              project_id TEXT NOT NULL REFERENCES daming_projects(id),
              event_id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
              PRIMARY KEY(project_id,event_id), UNIQUE(project_id,revision)
            );
            PRAGMA user_version=3;
          `);
        }
        if(version<4) {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS daming_project_budgets(
              project_id TEXT PRIMARY KEY REFERENCES daming_projects(id),
              data TEXT NOT NULL CHECK(json_valid(data))
            );
            CREATE TABLE IF NOT EXISTS daming_project_sends(
              project_id TEXT NOT NULL REFERENCES daming_project_budgets(project_id),
              send_id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
              PRIMARY KEY(project_id,send_id)
            );
            PRAGMA user_version=4;
          `);
        }
      });
    } catch(error) { this.db.close();this.closed=true;throw error; }
  }
  atomic<T>(work:()=>T):T {
    const nested=this.db.isTransaction;
    const point='daming_'+(++this.savepoint);
    this.db.exec(nested?'SAVEPOINT '+point:'BEGIN IMMEDIATE');
    try {
      const result=work();
      if(result&&typeof (result as {then?:unknown}).then==='function') throw new DomainError('SQLite transactions must be synchronous');
      this.db.exec(nested?'RELEASE SAVEPOINT '+point:'COMMIT');
      return result;
    } catch(error) {
      if(nested) this.db.exec('ROLLBACK TO SAVEPOINT '+point+'; RELEASE SAVEPOINT '+point);
      else this.db.exec('ROLLBACK');
      throw error;
    }
  }
  workflowHistory():Task[] {return this.db.prepare("SELECT data FROM daming_tasks WHERE json_type(data,'$.workflow')='object' ORDER BY json_extract(data,'$.workflow.frozenSequence')").all().map(row=>decode<Task>(row)!);}
  dispatchBlockers(taskId:string):string[] {
    const reasons:string[]=[];
    if(this.governanceGet('budgets',taskId)?.breached)reasons.push('cash_breached');
    if(this.governanceList('reservations',taskId).some(r=>['unknown','breached'].includes(r.status)))reasons.push('unknown_reservation');
    if(this.governanceList('executions',taskId).some(e=>e.status==='needs_reconciliation'))reasons.push('unknown_execution');
    return reasons;
  }
  completionBlockers(taskId:string):string[] {
    const reasons:string[]=[];
    const b=this.governanceGet('budgets',taskId);if(b&&(b.heldMinor>0||b.breached))reasons.push('cash_not_clear');
    if(this.governanceList('reservations',taskId).some(r=>['reserved','unknown','breached'].includes(r.status)))reasons.push('open_reservation');
    if(this.governanceList('executions',taskId).some(e=>['started','needs_reconciliation'].includes(e.status)))reasons.push('open_execution');
    return reasons;
  }
  close():void { if(!this.closed) { this.db.close();this.closed=true; } }
  getProject(id:string):Project|undefined {
    return decode<Project>(this.db.prepare('SELECT data FROM daming_projects WHERE id=?').get(id));
  }
  saveProject(project:Project,expectedRevision:number):void {
    const data=canonicalJson(project);
    if(expectedRevision===0) {
      this.db.prepare('INSERT INTO daming_projects(id,revision,data) VALUES(?,?,?)').run(project.projectId,project.revision,data);
      return;
    }
    const changed=this.db.prepare('UPDATE daming_projects SET revision=?,data=? WHERE id=? AND revision=?')
      .run(project.revision,data,project.projectId,expectedRevision);
    if(Number(changed.changes)!==1) throw new ConflictError('Project revision conflict');
  }
  getProjectEvent(projectId:string,eventId:string):ProjectEvent|undefined {
    return decode<ProjectEvent>(this.db.prepare('SELECT data FROM daming_project_events WHERE project_id=? AND event_id=?')
      .get(projectId,eventId));
  }
  appendProjectEvent(event:ProjectEvent):void {
    this.db.prepare('INSERT INTO daming_project_events(project_id,event_id,revision,data) VALUES(?,?,?,?)')
      .run(event.projectId,event.eventId,event.snapshot.revision,canonicalJson(event));
  }
  getProjectBudget(projectId: string): ProjectSpendBudget|undefined {
    return decode<ProjectSpendBudget>(this.db.prepare('SELECT data FROM daming_project_budgets WHERE project_id=?').get(projectId));
  }
  saveProjectBudget(budget: ProjectSpendBudget): void {
    this.db.prepare('INSERT INTO daming_project_budgets(project_id,data) VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET data=excluded.data')
      .run(budget.projectId,canonicalJson(budget));
  }
  getProjectSend(projectId: string,sendId: string): ProjectSendPermit|undefined {
    return decode<ProjectSendPermit>(this.db.prepare('SELECT data FROM daming_project_sends WHERE project_id=? AND send_id=?')
      .get(projectId,sendId));
  }
  saveProjectSend(permit: ProjectSendPermit): void {
    this.db.prepare('INSERT INTO daming_project_sends(project_id,send_id,data) VALUES(?,?,?) ON CONFLICT(project_id,send_id) DO UPDATE SET data=excluded.data')
      .run(permit.intent.projectId,permit.intent.sendId,canonicalJson(permit));
  }
  getTask(id:string):Task|undefined { return decode<Task>(this.db.prepare('SELECT data FROM daming_tasks WHERE id=?').get(id)); }
  saveTask(task:Task,expected:number|null):void {
    if(expected===null) {
      this.db.prepare('INSERT INTO daming_tasks(id,version,data) VALUES(?,?,?)').run(task.taskId,task.version,canonicalJson(task));return;
    }
    const changed=this.db.prepare('UPDATE daming_tasks SET version=?,data=? WHERE id=? AND version=?').run(task.version,canonicalJson(task),task.taskId,expected);
    if(Number(changed.changes)!==1) throw new ConflictError('Task version conflict');
  }
  getEvent(sourceId:string,eventId:string):StoredEvent|undefined { return decode<StoredEvent>(this.db.prepare('SELECT data FROM daming_events WHERE source_id=? AND event_id=?').get(sourceId,eventId)); }
  appendEvent(event:StoredEvent):void {
    this.db.prepare('INSERT INTO daming_events(sequence,source_id,event_id,task_id,data) VALUES(?,?,?,?,?)').run(event.sequence,event.sourceId,event.eventId,event.taskId,canonicalJson(event));
  }
  nextSequence():number { return Number(this.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM daming_events').get()!.next); }
  listEvents(taskId?:string):StoredEvent[] {
    const rows=taskId===undefined?this.db.prepare('SELECT data FROM daming_events ORDER BY sequence').all():this.db.prepare('SELECT data FROM daming_events WHERE task_id=? ORDER BY sequence').all(taskId);
    return rows.map(row=>decode<StoredEvent>(row)!);
  }
  getEffect(id:string):OutboxEffect|undefined { return decode<OutboxEffect>(this.db.prepare('SELECT data FROM daming_effects WHERE id=?').get(id)); }
  getEffectByKey(key:string):OutboxEffect|undefined { return decode<OutboxEffect>(this.db.prepare('SELECT data FROM daming_effects WHERE idempotency_key=?').get(key)); }
  effectsForTask(taskId:string):OutboxEffect[] { return this.db.prepare('SELECT data FROM daming_effects WHERE task_id=? ORDER BY rowid').all(taskId).map(row=>decode<OutboxEffect>(row)!); }
  insertEffect(effect:OutboxEffect):void {
    this.db.prepare('INSERT INTO daming_effects(id,task_id,idempotency_key,status,attempts,data) VALUES(?,?,?,?,?,?)').run(effect.effectId,effect.taskId,effect.idempotencyKey,effect.status,effect.attempts,canonicalJson(effect));
  }
  saveEffect(effect:OutboxEffect,status:OutboxEffect['status'],attempts:number):void {
    const changed=this.db.prepare('UPDATE daming_effects SET status=?,attempts=?,data=? WHERE id=? AND status=? AND attempts=?').run(effect.status,effect.attempts,canonicalJson(effect),effect.effectId,status,attempts);
    if(Number(changed.changes)!==1) throw new ConflictError('Stale effect claim or settlement');
  }
  claimNext(at:string,taskId?:string):OutboxEffect|undefined {
    // Releasing a nested savepoint is not a durable commit. Never dispatch from an outer transaction.
    if(this.db.isTransaction) throw new DomainError('Outbox claims require a top-level transaction');
    return this.atomic(()=>{
      const effect=decode<OutboxEffect>(this.db.prepare(`
        SELECT e.data FROM daming_effects e JOIN daming_tasks t ON e.task_id=t.id
        WHERE e.status='pending' AND (? IS NULL OR e.task_id=?) AND json_extract(t.data,'$.status') IN ('running','reviewing')
        ORDER BY e.rowid LIMIT 1
      `).get(taskId??null,taskId??null));
      if(!effect)return;
      const next:OutboxEffect={...effect,status:'executing',attempts:effect.attempts+1,updatedAt:at};
      this.saveEffect(next,'pending',effect.attempts);
      return next;
    });
  }
  executingEffects():OutboxEffect[] {
    return this.db.prepare("SELECT data FROM daming_effects WHERE status='executing' ORDER BY rowid").all().map(row=>decode<OutboxEffect>(row)!);
  }
  assertOutsideTransaction():void {if(this.db.isTransaction)throw new DomainError('External execution requires a top-level commit');}
  governanceGet<K extends keyof GovRecords>(collection:K,id:string):GovRecords[K]|undefined {
    return decode<GovRecords[K]>(this.db.prepare('SELECT data FROM daming_governance WHERE collection=? AND id=?').get(collection,id));
  }
  governancePut<K extends keyof GovRecords>(collection:K,value:GovRecords[K],expectedVersion:number|null):void {
    if(expectedVersion===null){this.db.prepare('INSERT INTO daming_governance(collection,id,task_id,version,data) VALUES(?,?,?,?,?)').run(collection,value.id,value.taskId,value.version,canonicalJson(value));return;}
    const changed=this.db.prepare('UPDATE daming_governance SET version=?,data=? WHERE collection=? AND id=? AND task_id=? AND version=?').run(value.version,canonicalJson(value),collection,value.id,value.taskId,expectedVersion);
    if(Number(changed.changes)!==1)throw new ConflictError('Governance version conflict');
  }
  governanceList<K extends keyof GovRecords>(collection:K,taskId?:string):GovRecords[K][] {
    const rows=taskId===undefined?this.db.prepare('SELECT data FROM daming_governance WHERE collection=? ORDER BY rowid').all(collection):this.db.prepare('SELECT data FROM daming_governance WHERE collection=? AND task_id=? ORDER BY rowid').all(collection,taskId);
    return rows.map(row=>decode<GovRecords[K]>(row)!);
  }
  appendGovernanceAudit(event:GovernanceAudit):void {this.db.prepare('INSERT INTO daming_governance_audit(task_id,data) VALUES(?,?)').run(event.taskId,canonicalJson(event));}
  listGovernanceAudit(taskId:string):GovernanceAudit[] {return this.db.prepare('SELECT sequence,data FROM daming_governance_audit WHERE task_id=? ORDER BY sequence').all(taskId).map(row=>({...decode<GovernanceAudit>(row)!,sequence:Number(row.sequence)}));}

}
