import type { Task, StoredEvent, OutboxEffect, TaskRepository } from '../src/index.ts';
export class MemoryRepository implements TaskRepository {
  dispatchBlockers(_id:string):string[]{return [];}
  completionBlockers(_id:string):string[]{return [];}
  workflowHistory(){return [...this.tasks.values()].map(t=>structuredClone(t));}
  tasks = new Map<string,Task>();
  events: StoredEvent[] = [];
  effects = new Map<string,OutboxEffect>();
  atomic<T>(work:()=>T):T {
    const backup=structuredClone([this.tasks,this.events,this.effects]) as [Map<string,Task>,StoredEvent[],Map<string,OutboxEffect>];
    try { return work(); } catch(error) { [this.tasks,this.events,this.effects]=backup; throw error; }
  }
  getTask(id:string) { const t=this.tasks.get(id); return t&&structuredClone(t); }
  saveTask(task:Task,expected:number|null) {
    if ((this.tasks.get(task.taskId)?.version??null)!==expected) throw new Error('version conflict');
    this.tasks.set(task.taskId,structuredClone(task));
  }
  getEvent(source:string,id:string) { return this.events.find(e=>e.sourceId===source&&e.eventId===id); }
  appendEvent(event:StoredEvent) { this.events.push(structuredClone(event)); }
  nextSequence() { return this.events.length+1; }
  getEffect(id:string) { const e=this.effects.get(id); return e&&structuredClone(e); }
  getEffectByKey(key:string) { return [...this.effects.values()].find(e=>e.idempotencyKey===key); }
  effectsForTask(taskId:string) { return [...this.effects.values()].filter(e=>e.taskId===taskId).map(e=>structuredClone(e)); }
  insertEffect(effect:OutboxEffect) { if(this.effects.has(effect.effectId)||this.getEffectByKey(effect.idempotencyKey)) throw new Error('effect conflict'); this.effects.set(effect.effectId,structuredClone(effect)); }
  saveEffect(effect:OutboxEffect,status:OutboxEffect['status'],attempts:number) {
    const old=this.effects.get(effect.effectId);
    if(!old||old.status!==status||old.attempts!==attempts) throw new Error('stale effect');
    this.effects.set(effect.effectId,structuredClone(effect));
  }
}
