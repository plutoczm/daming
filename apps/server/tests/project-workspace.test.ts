import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  writeFileSync, symlinkSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectWorkspace, validateProjectFiles } from '../src/project-workspace.ts';

function setup(t: { after(fn: () => void): void }) {
  const base = mkdtempSync(join(tmpdir(), 'daming-agent-preview-'));
  const sourceRoot = join(base, 'source');
  mkdirSync(join(sourceRoot, 'src'), { recursive: true });
  writeFileSync(join(sourceRoot, 'src', 'sample.ts'), 'const answer = 1;\n', 'utf8');
  writeFileSync(join(sourceRoot, '.env'), 'SKIP_ME=secret\n', 'utf8');
  writeFileSync(join(sourceRoot, 'src', 'other.json'), '{"hello":true}\n', 'utf8');
  const workspaceRoot = join(base, 'workspaces');
  const workspace = new ProjectWorkspace(sourceRoot, workspaceRoot);
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return { base, workspace, sourceRoot, workspaceRoot };
}

test('selected relative project files are validated with no secrets, traversal or globs', () => {
  assert.deepEqual(validateProjectFiles(['src/sample.ts','src/other.json']), ['src/sample.ts','src/other.json']);
  for (const bad of [
    ['../secret.ts'], ['.env'], ['.git/config.json'], ['src/../README.md'],
    ['src/password.json'], ['src/creDentials.ts'], ['src/id_rsa.pem'],
    ['src/*.ts'], ['C:\\Windows\\file.ts'], ['/Windows/file.ts'],
    ['src/sample.ts', 'SRC/SAMPLE.TS'], [], Array.from({ length: 9 }, () => 'foo.md')
  ]) assert.throws(() => validateProjectFiles(bad));
});

test('import copies only explicitly selected files; exact replacement is staged and reviewed', (t) => {
  const h = setup(t);
  const taskId = randomUUID();
  const files = ['src/sample.ts', 'src/other.json'];
  assert.equal(existsSync(h.workspace.folder(taskId)), false);
  h.workspace.import(taskId, files);
  assert.equal(existsSync(join(h.workspace.folder(taskId), '.env')), false);
  assert.deepEqual(readdirSync(join(h.workspace.folder(taskId), 'source')), ['src']);
  assert.equal(h.workspace.promptBundle(taskId, files).includes('SKIP_ME'), false);

  h.workspace.apply(taskId, JSON.stringify({ path: 'src/sample.ts', find: 'answer = 1', replace: 'answer = 2' }), files);
  assert.equal(readFileSync(join(h.sourceRoot, 'src', 'sample.ts'), 'utf8'), 'const answer = 1;\n');
  assert.equal(readFileSync(join(h.workspace.folder(taskId), 'staged', 'src', 'sample.ts'), 'utf8'), 'const answer = 2;\n');
  assert.equal(h.workspace.verify(taskId, '{"approved":true,"reason":"Confirmed the change stays in the copied file"}', files), true);
  const preview = h.workspace.preview(taskId, files);
  assert.equal(preview.verified, true);
  assert.equal(preview.mergeEnabled, false);
  assert.equal(preview.originalUnchanged, true);
  assert.match(preview.after, /answer = 2/);
  assert.throws(() => h.workspace.preview(taskId, ['src/sample.ts']), /project_manifest_identity_mismatch/);

  writeFileSync(join(h.sourceRoot, 'src', 'sample.ts'), 'const answer = 99;\n');
  assert.equal(h.workspace.preview(taskId, files).originalUnchanged, false);
  writeFileSync(join(h.workspace.folder(taskId), 'staged', 'src', 'sample.ts'), 'malicious\0');
  assert.throws(() => h.workspace.preview(taskId, files));
});

test('model can only replace exactly one source occurrence in an allowlisted file', (t) => {
  const h = setup(t);
  const taskId = randomUUID();
  const files = ['src/sample.ts'];
  h.workspace.import(taskId, files);
  for (const change of [
    { path: '../outside.ts', find: 'answer', replace: 'oops' },
    { path: 'src/other.json', find: 'hello', replace: 'oops' },
    { path: 'src/sample.ts', find: 'NOT_IN_FILE', replace: 'oops' },
    { path: 'src/sample.ts', find: 'answer', replace: 'answer', extra: true },
    { path: 'src/sample.ts', find: '', replace: 'noop' },
    { path: 'src/sample.ts', find: 'answer', replace: 'answer' }
  ]) assert.throws(() => h.workspace.apply(taskId, JSON.stringify(change), files));
  assert.equal(readFileSync(join(h.workspace.folder(taskId), 'source', 'src', 'sample.ts'), 'utf8'), 'const answer = 1;\n');
  assert.equal(existsSync(join(h.workspace.folder(taskId), 'proposal.json')), false);
});

test('file-type guard rejects a pre-planted symlink or hardlink instead of following it', (t) => {
  const h = setup(t);
  const taskId = randomUUID();
  const external = join(h.base, 'elsewhere');
  mkdirSync(external);
  writeFileSync(join(external, 'special.ts'), 'const secret = "never copy";\n');
  const link = join(h.sourceRoot, 'src', 'linked.ts');
  try {
    symlinkSync(join(external, 'special.ts'), link, 'file');
  } catch {
    t.diagnostic('Windows symlink unavailable; guardedFile still exercised by other tests');
    return;
  }
  assert.throws(() => h.workspace.import(taskId, ['src/linked.ts']), /project_file_link_denied|project_file_escaped/);
  assert.equal(existsSync(h.workspace.folder(taskId)), false);
});

test('an unexpected staged file is not silently included or accepted as a reviewed edit', (t) => {
  const h = setup(t);
  const taskId = randomUUID();
  const files = ['src/sample.ts'];
  h.workspace.import(taskId, files);
  h.workspace.apply(taskId, JSON.stringify({ path: 'src/sample.ts', find: 'answer = 1', replace: 'answer = 2' }), files);
  writeFileSync(join(h.workspace.folder(taskId), 'staged', 'src', 'extra.ts'), 'surprise\n');
  assert.throws(() => h.workspace.verify(taskId, '{"approved":true,"reason":"Looks fine"}', files), /project_unexpected_file/);
  assert.equal(existsSync(join(h.workspace.folder(taskId), 'review.json')), false);
});
