import type { TaskSnapshot } from '@daming/core';
export interface Clock { now(): string; }
export interface WorkerPort {
  readonly workerId: string;
  isAvailable(): Promise<boolean>;
}
export interface TaskReader {
  getTask(taskId: string): TaskSnapshot | undefined;
}

export type { TaskRepository } from "@daming/core";
import type { OutboxEffect, EffectOutcome } from "@daming/core";
export type EffectExecutor = (effect:Readonly<OutboxEffect>)=>Promise<EffectOutcome>;
