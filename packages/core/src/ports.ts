import type { Task, StoredEvent, OutboxEffect } from './model.ts';
import type { Project, ProjectEvent } from './project.ts';

export interface ProjectRepository {
  atomic<T>(work:()=>T):T;
  getProject(projectId: string): Project | undefined;
  saveProject(project: Project, expectedRevision: number): void;
  getProjectEvent(projectId: string, eventId: string): ProjectEvent | undefined;
  appendProjectEvent(event: ProjectEvent): void;
}
/** Synchronous transaction boundary. Adapters must roll back all writes on error. */
export interface TaskRepository {
  dispatchBlockers(taskId:string):string[];
  completionBlockers(taskId:string):string[];
  workflowHistory():Task[];
  atomic<T>(work:()=>T):T;
  getTask(taskId:string):Task|undefined;
  saveTask(task:Task,expectedVersion:number|null):void;
  getEvent(sourceId:string,eventId:string):StoredEvent|undefined;
  appendEvent(event:StoredEvent):void;
  nextSequence():number;
  getEffect(effectId:string):OutboxEffect|undefined;
  getEffectByKey(key:string):OutboxEffect|undefined;
  effectsForTask(taskId:string):OutboxEffect[];
  insertEffect(effect:OutboxEffect):void;
  saveEffect(effect:OutboxEffect,expectedStatus:OutboxEffect['status'],expectedAttempts:number):void;
}
