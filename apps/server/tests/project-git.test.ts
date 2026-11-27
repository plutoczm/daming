import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ProjectGit } from '../src/project-git.ts';

function makeSource(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-src-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'fixture',
    private: true,
    scripts: {
      lint: 'node -e "console.log(\'lint ok\')"',
      typecheck: 'node -e "console.log(\'tc ok\')"',
      test: 'node -e "console.log(\'test ok\')"'
    }
  }, null, 2), 'utf8');
  mkdirSync(join(dir, 'node_modules', 'junk'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'junk', 'x.js'), 'ignored', 'utf8');
  return dir;
}

test('project-git: set work dir in place, verify runs gates, commit records a hash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wb-root-'));
  const src = makeSource();
  try {
    const git = new ProjectGit(root);
    mkdirSync(join(root, 'demo'), { recursive: true });
    const prepared = git.setWorkDir('demo', src);
    assert.equal(prepared.workspaceDir, src, 'work dir is used in place (no copy)');
    assert.equal(prepared.fileCount, 1, 'count excludes node_modules');
    const verify = await git.verify('demo', 60000);
    assert.equal(verify.passed, true);
    assert.deepEqual(verify.results.map((row) => row.script), ['lint', 'typecheck', 'test']);
    assert.ok(verify.results.every((row) => row.ok));
    const commit = await git.commit('demo', 'phase 1');
    assert.equal(commit.committed, true);
    assert.ok(commit.hash && commit.hash.length >= 6);
    const status = await git.gitStatus('demo');
    assert.equal(status.isRepo, true);
    assert.equal(status.dirty, false);
    assert.match(status.lastCommit ?? '', /phase 1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});
