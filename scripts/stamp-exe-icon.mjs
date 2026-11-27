// Write the project's brand icon + version strings into the built Daming.exe.
//
// Why not electron-builder: it insists on resolving the whole winCodeSign kit,
// and extracting that kit fails here because Windows will not let an unelevated
// process create the macOS symlinks inside it. rcedit does the same job as a
// single call, so this calls the already-unpacked rcedit-x64.exe directly.
//
// Usage: node scripts/stamp-exe-icon.mjs [path-to-exe]
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(repoRoot, 'apps', 'desktop');
const target = resolve(process.argv[2] ?? join(desktop, 'release', 'win-unpacked', 'Daming.exe'));
const icon = join(desktop, 'electron', 'assets', 'app.ico');

function findRcedit() {
  const root = join(repoRoot, '.cache', 'electron-builder', 'winCodeSign');
  if (!existsSync(root)) return '';
  const dirs = readdirSync(root)
    .map((name) => join(root, name))
    .filter((dir) => existsSync(join(dir, 'rcedit-x64.exe')))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return dirs[0] ? join(dirs[0], 'rcedit-x64.exe') : '';
}

if (!existsSync(target)) {
  console.error('exe not found: ' + target);
  process.exit(2);
}
if (!existsSync(icon)) {
  console.error('icon not found: ' + icon);
  process.exit(2);
}
const rcedit = findRcedit();
if (!rcedit) {
  console.error('rcedit-x64.exe not found under .cache/electron-builder/winCodeSign');
  process.exit(2);
}

const result = spawnSync(rcedit, [
  target,
  '--set-icon', icon,
  '--set-file-version', '0.0.0',
  '--set-product-version', '0.0.0',
  '--set-version-string', 'ProductName', 'Daming',
  '--set-version-string', 'FileDescription', 'Daming · 任务板',
  '--set-version-string', 'CompanyName', 'Daming'
], { stdio: 'inherit', shell: false, windowsHide: true });

if ((result.status ?? 1) !== 0) {
  console.error('rcedit failed with status ' + result.status);
  process.exit(result.status ?? 1);
}
console.log('icon stamped into ' + target);
