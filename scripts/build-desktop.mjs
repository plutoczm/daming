#!/usr/bin/env node
// Build the Daming desktop package assets:
//   1. bundle the managed Host launcher into a single ESM file
//   2. ship a Node 24 runtime so node:sqlite is always present
//   3. copy the built web UI next to the host
// The Electron/NSIS packaging step is scripts/package-desktop.mjs.
import { createRequire } from 'node:module';
import { cpSync, copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(repoRoot, 'apps', 'desktop');
const { build } = createRequire(join(desktop, 'package.json'))('esbuild');
const outHost = join(desktop, 'build', 'host');
const webDist = join(repoRoot, 'apps', 'web', 'dist');
const hostEntry = join(desktop, 'host', 'main.mjs');

if (!existsSync(join(webDist, 'index.html'))) {
  console.error('缺少 apps/web/dist，请先运行: corepack pnpm build:web');
  process.exit(2);
}

rmSync(outHost, { recursive: true, force: true });
mkdirSync(outHost, { recursive: true });

await build({
  entryPoints: [hostEntry],
  outfile: join(outHost, 'host.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  legalComments: 'none',
  logLevel: 'info',
  // Node builtins stay external; every workspace package is bundled in.
  banner: { js: '// Daming managed Host bundle. Single state writer; spawned by the desktop shell.' },
});

// Bundle the data-plane gateway serve entry next to the host so the packaged app
// can actually start the gateway from the platform's providers.json.
await build({
  entryPoints: [join(repoRoot, 'scripts', 'daming-gateway-serve.mjs')],
  outfile: join(outHost, 'gateway-serve.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  legalComments: 'none',
  logLevel: 'info',
  banner: { js: '// Daming gateway serve bundle (data plane).' },
});

// Ship the exact Node runtime that produced this bundle (node:sqlite + type features match).
if (process.platform === 'win32') {
  copyFileSync(process.execPath, join(outHost, 'node.exe'));
}

// Copy the built renderer next to the host (served by the Host, loaded by Electron).
cpSync(webDist, join(outHost, 'web'), { recursive: true });

const sizeMb = (p) => (statSync(p).size / (1024 * 1024)).toFixed(1) + 'MB';
writeFileSync(join(outHost, 'BUILD.json'), JSON.stringify({
  builtAt: new Date().toISOString(),
  node: process.version,
  host: 'host.mjs',
  gateway: 'gateway-serve.mjs',
  web: 'web/',
}, null, 2) + '\n');

console.log('desktop host bundle ready:', outHost);
console.log('  host.mjs', sizeMb(join(outHost, 'host.mjs')));
if (process.platform === 'win32') console.log('  node.exe', sizeMb(join(outHost, 'node.exe')));
