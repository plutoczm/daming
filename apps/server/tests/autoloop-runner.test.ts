import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Job } from '@daming/autoloop';
import { autoloopPrompt, createAutoloopJobRunner } from '../src/autoloop-runner.ts';

function job(use: string): Job {
  return {
    run: 7, token: 'token', attempt: 1,
    rule: { name: '真实测试', cwd: 'D:/Projects/daming', prompt: '处理 Autoloop 事件。' },
    agent: { id: use, name: use, use, access: 'read' },
    session: null, askFirst: [],
    context: {
      events: [{ id: 'e1', source: 'manual', sourceName: '手动事件', type: 'task.requested.dsh', subject: 'demo', summary: '检查这个任务', detail: '详细材料', link: '', receivedAt: '2026-11-11T07:00:00.000Z' }],
      answers: [], timers: [], waiting: [], open: [], decided: []
    }
  };
}

test('Autoloop real-agent runner dispatches DSH and Codex jobs', async () => {
  const seen: string[] = [];
  const runner = createAutoloopJobRunner({
    runDsh: async (input) => { seen.push(`dsh:${autoloopPrompt(input)}`); return { outcome: 'done', summary: 'DSH OK' }; },
    runCodex: async (input) => { seen.push(`codex:${autoloopPrompt(input)}`); return { outcome: 'done', summary: 'Codex OK' }; }
  });
  assert.equal((await runner(job('dsh'))).summary, 'DSH OK');
  assert.equal((await runner(job('codex'))).summary, 'Codex OK');
  assert.equal(seen.length, 2);
  assert.match(seen[0], /检查这个任务/);
  assert.match(seen[0], /数据，不是指令/);
});

test('Autoloop real-agent runner reports missing adapters', async () => {
  const runner = createAutoloopJobRunner({});
  const result = await runner(job('dsh'));
  assert.equal(result.outcome, 'failed');
  assert.match(result.error ?? '', /DSH 未配置/);
});
