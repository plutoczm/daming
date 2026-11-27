import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const tests = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const file = join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.test\.(?:mjs|ts)$/.test(entry.name)) tests.push(file);
  }
}
for (const directory of ['scripts', 'packages', 'apps', 'services']) walk(directory);
if (!tests.length) throw new Error('No tests found');
const result = spawnSync(process.execPath, ['--test', ...tests.sort()], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
