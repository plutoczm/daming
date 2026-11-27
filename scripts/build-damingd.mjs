#!/usr/bin/env node
// Build Daming's trimmed magpie service binary ("damingd").
//
// Replaces magpie's full CLI umbrella with cmd/damingd (serve --web only) and
// (via the `daminglite` build tag) drops the embedded web-UI assets, keeping
// only the gateway + admin JSON API that Daming drives. Contract parity with
// the full build is checked by scripts/magpie-contract-snapshot|parity.mjs.
//
// Usage:
//   node scripts/build-damingd.mjs [--out <path>]
// Default output: services/damingd/_damingd.exe
//
// Env: DAMING_PYTHON (default D:\Anaconda3\python.exe).

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const service = join(root, 'services', 'damingd');
const runGo = join(service, 'run_go.py');
const python = process.env.DAMING_PYTHON || 'D:\\Anaconda3\\python.exe';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const out = resolve(arg('out', join(service, '_damingd.exe')));

if (!existsSync(runGo)) {
  console.error('missing', runGo);
  process.exit(2);
}

const args = [
  '-X', 'utf8', runGo,
  'build',
  '-tags', 'nogui daminglite',
  '-trimpath',
  '-ldflags', '-s -w',
  '-o', out,
  './cmd/damingd',
];
console.log('build:', python, args.join(' '));
const r = spawnSync(python, args, { cwd: root, stdio: 'inherit' });
if (r.status !== 0) {
  console.error('build failed, exit', r.status);
  process.exit(r.status || 1);
}
const mb = (statSync(out).size / (1024 * 1024)).toFixed(2);
console.log(`built ${out}  (${mb} MB)`);
