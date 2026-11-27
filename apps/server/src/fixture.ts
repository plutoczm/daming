import type { TaskSnapshot } from '@daming/core';
import type { TaskView } from '@daming/contracts';
import { parseEvent } from '@daming/source-protocol';
/** An offline test fixture; this is not a task submission API or an Engine. */
export function createFixtureTask(): TaskSnapshot {
  const event = parseEvent({id:'fixture-event',type:'task.created',subject:'fixture-task',summary:'Fixture task',detail:'Synthetic acceptance fixture'});
  return { taskId:event.subject, title:event.summary, goal:event.detail, status:'draft', createdAt:'2026-11-06T00:00:00.000Z' };
}
export function toTaskView(task: TaskSnapshot): TaskView {
  return {taskId:task.taskId, title:task.title, status:task.status};
}

export { createModelFixtureTool } from './model-fixture-tool.ts';
