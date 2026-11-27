import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFixtureTask, toTaskView } from '../src/fixture.ts';
test('fixture provides one deterministic draft without a model or user data', () => {
  const task=createFixtureTask();
  assert.equal(task.taskId,'fixture-task');
  assert.equal(task.status,'draft');
  assert.equal(task.createdAt,'2026-11-06T00:00:00.000Z');
  assert.deepEqual(createFixtureTask(),task);
});
test('public view excludes the goal and internal metadata', () => {
  const task=createFixtureTask();
  const view=toTaskView(task);
  assert.deepEqual(Object.keys(view).sort(),['status','taskId','title']);
  assert.equal(view.taskId,task.taskId);
  assert.equal('goal' in view,false);
});
