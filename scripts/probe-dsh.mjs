import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './load-env.mjs';

loadEnv(resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env'));

if (!process.env.DEEPSEEK_API_KEY?.trim()) {
  console.error('DEEPSEEK_API_KEY is empty in D:/Projects/daming/.env');
  process.exit(2);
}
const executable = process.env.DAMING_DSH_EXE?.trim() || 'D:/dsh/DeepSeek Harness.exe';
const entry = process.env.DAMING_DSH_ENTRY?.trim() || 'D:/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js';
const prompt = process.argv.slice(2).join(' ').trim() || 'Reply with only OK. Do not run commands or edit files.';
const result = spawnSync(executable, [entry, '--profile', 'headless', '--json', '-'], {
  cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, input: prompt, encoding: 'utf8', timeout: 180000, windowsHide: true
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
