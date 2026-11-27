import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DshExecRun } from '../src/index.ts';

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

test('DSH exec adapter parses headless JSON stream and stdin task without invoking DSH', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'daming dsh exec '));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const run = new DshExecRun({ executable: process.execPath, entry: 'D:/mock/dsh-entry.js', commandArgs: [fixture('mock-dsh-exec.mjs')], cwd, prompt: 'synthetic' });
  const result = await run.run();
  assert.equal(result.status, 'completed');
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, 'OK:synthetic');
  assert.deepEqual(result.usage, { inputTokens: 40, outputTokens: 2 });
  assert.deepEqual(result.events.map((event) => event.type), [
    'session', 'status', 'status', 'thinking', 'text', 'status', 'status', 'final'
  ]);
  assert.equal(result.events.find((event) => event.type === 'text')?.text, 'OK');
});

test('DSH exec adapter fails when the final event is missing', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'daming dsh exec nofinal '));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const run = new DshExecRun({ executable: process.execPath, entry: 'D:/mock/dsh-entry.js', commandArgs: [fixture('mock-dsh-exec-nofinal.mjs')], cwd, prompt: 'synthetic' });
  const result = await run.run();
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'missing_final_event');
  assert.equal(result.output, 'OK');
});

test('DSH exec adapter reports provider errors from the JSON stream', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'daming dsh exec fail '));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const run = new DshExecRun({ executable: process.execPath, entry: 'D:/mock/dsh-entry.js', commandArgs: [fixture('mock-dsh-exec-fail.mjs')], cwd, prompt: 'synthetic' });
  const result = await run.run();
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'mock provider failure');
  assert.ok(result.events.some((event) => event.type === 'error'));
});
