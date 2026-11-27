#!/usr/bin/env node
// Package apps/desktop into Daming-Setup.exe using electron-builder + electron-builder.yml.
// Requires the host bundle from scripts/build-desktop.mjs and installed electron deps.
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(repoRoot, 'apps', 'desktop');

// Keep electron-builder's download cache inside the project rather than on C:.
const EB_CACHE = join(repoRoot, '.cache', 'electron-builder');
mkdirSync(EB_CACHE, { recursive: true });
process.env.ELECTRON_BUILDER_CACHE = EB_CACHE;

if (!existsSync(join(desktop, 'build', 'host', 'host.mjs'))) {
  console.error('缺少 Host 打包产物，请先运行: node scripts/build-desktop.mjs');
  process.exit(2);
}

const cli = join(desktop, 'node_modules', 'electron-builder', 'cli.js');
if (!existsSync(cli)) {
  console.error('未安装 electron-builder，请在 apps/desktop 运行 pnpm install（或 corepack pnpm install）。');
  process.exit(2);
}

// Reuse the already-downloaded Electron runtime from node_modules instead of re-fetching from GitHub.
const electronDist = join(desktop, 'node_modules', 'electron', 'dist');
const args = [cli, '--win', 'nsis', '--x64', '--config', 'electron-builder.yml'];
// Windows refuses to create the darwin symlinks inside winCodeSign when the
// process is unelevated, which aborts the whole repack. rcedit itself is a plain
// exe and already unpacked in the project cache, so point electron-builder at it
// and it never needs to re-extract that archive.
function findLocalRcedit() {
  const root = join(repoRoot, '.cache', 'electron-builder', 'winCodeSign');
  try {
    
    for (const entry of readdirSync(root)) {
      const candidate = join(root, entry, 'rcedit-x64.exe');
      if (existsSync(candidate) && existsSync(join(root, entry, 'windows-10'))) return candidate;
    }
  } catch { /* fall through */ }
  return '';
}
const rceditX64 = findLocalRcedit();
if (rceditX64) {
  // winCodeSign is still resolved for the archive check unless the tool itself
  // is overridden; both are honoured when set.
  process.env.ELECTRON_BUILDER_RCEDIT = rceditX64;
}

// Signing is skipped locally (no certificate), but the executable MUST still be
// edited: rcedit writes our own icon into Daming.exe and its version info, so the
// window/taskbar/shortcut show the real brand mark instead of Electron's default.
// signAndEditExecutable must be true for rcedit to run (it also gates signing, but
// with no certificate configured electron-builder simply skips the signing step).
args.push('--config.win.signAndEditExecutable=true');
if (existsSync(electronDist)) args.push('--config.electronDist=' + electronDist);
// Binary helper artifacts (nsis/winCodeSign) come from a reachable mirror by default.
if (!process.env.ELECTRON_BUILDER_BINARIES_MIRROR) {
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR = 'https://registry.npmmirror.com/-/binary/electron-builder-binaries/';
}
const result = spawnSync(process.execPath, args, { cwd: desktop, stdio: 'inherit', shell: false, windowsHide: true });
process.exit(result.status ?? 1);
