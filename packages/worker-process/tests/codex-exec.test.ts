import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexExecRun } from '../src/index.ts';
import { createCodexModelConnection } from '../src/codex-model-connection.ts';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

test('Codex exec adapter parses real JSONL event shape without invoking Codex', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'daming codex exec '));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const mock = fileURLToPath(new URL('./fixtures/mock-codex-exec.mjs', import.meta.url));
  const run = new CodexExecRun({ executable: process.execPath, commandArgs: [mock], cwd, prompt: 'synthetic' });
  const result = await run.run();
  assert.equal(result.status, 'completed');
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, 'OK');
  assert.deepEqual(result.usage, { input_tokens: 4, output_tokens: 1 });
  assert.deepEqual(result.events.map((event) => event.type), ['thread.started', 'turn.started', 'item.completed', 'turn.completed']);
  assert.equal(result.events.find((event) => event.type === 'item.completed')?.text, 'OK');
});

test('Codex connection uses disposable home, stdin prompt and no personal provider secrets', async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'daming codex connected '));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const connection = await createCodexModelConnection('stage/sample', async () => { throw new Error('not invoked'); });
  t.after(() => connection.close());
  const mock = fileURLToPath(new URL('./fixtures/mock-codex-connection.mjs', import.meta.url));
  const run = new CodexExecRun({ executable: process.execPath, commandArgs: [mock], cwd,
    prompt: '中文 synthetic $(not a command)', connection });
  const result = await run.run();
  assert.equal(result.status, 'completed');
  const observed = JSON.parse(result.output);
  assert.equal(observed.prompt, '中文 synthetic $(not a command)');
  assert.equal(observed.args.at(-1), '-');
  assert.equal(observed.args.includes(observed.prompt), false);
  assert.equal(observed.args.some((arg: string) => arg.includes(connection.token)), false);
  assert.equal(observed.personalConfigPresent, false);
  assert.equal(observed.apiKey, null);
  assert.equal(observed.relayTokenSet, true);
  assert.equal(existsSync(observed.home), false, 'temporary config is removed after actual process exit');
  assert.ok(observed.args.includes('model_providers.daming.request_max_retries=0'));
  assert.ok(observed.args.includes('model_providers.daming.stream_max_retries=0'));
  assert.ok(observed.args.includes('--ignore-user-config'));
  assert.ok(observed.args.includes('read-only'));
});

test('Codex refuses a forged connection or conflicting fixed model before spawning', () => {
  const cwd = process.cwd();
  assert.throws(() => new CodexExecRun({ executable: process.execPath, cwd, prompt: 'x',
    connection: { model: 'stage/sample', baseUrl: 'http://127.0.0.1:1/v1', token: 'forged', signal: new AbortController().signal, close: async () => {} } }), /connection/);
});

test('cancelled Codex closes its process before resolving and removes disposable config', async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'daming codex cancel '));
  t.after(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const connection = await createCodexModelConnection('stage/sample', async () => { throw new Error('unused'); });
  t.after(() => connection.close());
  const marker = join(cwd,'home.txt');
  const controller = new AbortController();
  const mock = fileURLToPath(new URL('./fixtures/mock-codex-hang.mjs', import.meta.url));
  const run = new CodexExecRun({ executable: process.execPath, commandArgs: [mock], cwd,
    prompt: marker, connection, signal: controller.signal });
  const running = run.run();
  for (let n = 0; n < 100 && !existsSync(marker); n++) await new Promise(r => setTimeout(r,10));
  assert.ok(existsSync(marker));
  const home = readFileSync(marker, 'utf8');
  controller.abort();
  const result = await running;
  assert.equal(result.status, 'cancelled');
  assert.equal(existsSync(home), false);
});

test('connected Codex exit zero without terminal turn receipt cannot report completion', async t => {
  const connection = await createCodexModelConnection('stage/sample', async () => { throw new Error('unused'); });
  t.after(() => connection.close());
  const mock = fileURLToPath(new URL('./fixtures/mock-codex-incomplete.mjs', import.meta.url));
  const result = await new CodexExecRun({ executable: process.execPath, commandArgs: [mock],
    cwd: process.cwd(), prompt: 'synthetic', connection }).run();
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'missing_successful_turn_receipt');
});

test('temporary config deletion failure settles run so owner can revoke its model capability', { timeout: 2000 }, async t => {
  const connection = await createCodexModelConnection('stage/sample', async () => { throw new Error('unused'); });
  t.after(() => connection.close());
  const original = fs.rmSync;
  const held: string[] = [];
  const mocked = t.mock.method(fs, 'rmSync', (path: fs.PathLike, options?: fs.RmOptions) => {
    if (String(path).includes('daming-codex-connection-')) { held.push(String(path)); throw new Error('synthetic EBUSY'); }
    return original(path, options);
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); held.forEach(p => original(p, { recursive: true, force: true })); });
  const mock = fileURLToPath(new URL('./fixtures/mock-codex-exec.mjs', import.meta.url));
  const result = await new CodexExecRun({ executable: process.execPath, commandArgs: [mock],
    cwd: process.cwd(), prompt: 'synthetic', connection }).run();
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'codex_temporary_config_cleanup_failed');
  assert.equal(held.length, 1);
});
