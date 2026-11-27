#!/usr/bin/env node
// Managed Host launcher for the Daming desktop shell.
//
// This process IS the single Host. The Electron main process only spawns it, watches for the
// ready handshake on stdout, and reaps it (whole process tree) on quit. It never writes task,
// approval, cost or audit state itself.
import { resolve, isAbsolute, join } from 'node:path';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { startBoardHost } from '../../server/src/http.ts';

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requireAbsolute(value, name) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(name + ' must be an absolute path');
  return value;
}

const dataDir = requireAbsolute(arg('--data-dir'), '--data-dir');
const webRoot = requireAbsolute(arg('--web-root'), '--web-root');
const portText = arg('--port') ?? '3210';
const port = Number(portText);
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid --port');
const bootstrapToken = arg('--token');
const singleUser = process.argv.includes('--single-user') || process.env.DAMING_SINGLE_USER === '1';

// Real local Magpie: when the desktop Magpie app is already running, attach to its gateway
// instead of spawning an empty embedded profile, so the UI shows real providers/accounts.
if (!process.env.DAMING_MAGPIE_EXISTING_GATEWAY_PORT) {
  try {
    const callerKeys = JSON.parse(readFileSync(join(homedir(), '.config', 'magpie', 'caller-keys.json'), 'utf8'));
    const secret = Array.isArray(callerKeys) && typeof callerKeys[0]?.secret === 'string' ? callerKeys[0].secret : '';
    if (secret) {
      process.env.DAMING_MAGPIE_EXISTING_GATEWAY_PORT = '3425';
      process.env.DAMING_MAGPIE_EXISTING_GATEWAY_KEY = secret;
    }
  } catch { /* no local Magpie config: use the embedded default */ }
}

// Real Agent executables: use the installed local CLIs when present so multi-Agent dispatch is real.
if (!process.env.DAMING_CODEX_EXE) {
  try {
    const root = join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin');
    const found = existsSync(root)
      ? readdirSync(root).sort().reverse().map((dir) => join(root, dir, 'codex.exe')).find((file) => existsSync(file))
      : undefined;
    if (found) process.env.DAMING_CODEX_EXE = found;
  } catch { /* no Codex CLI */ }
}
if (!process.env.DAMING_DSH_EXE || !process.env.DAMING_DSH_ENTRY) {
  const dshExe = 'D:/dsh/DeepSeek Harness.exe';
  const dshEntry = 'D:/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js';
  if (existsSync(dshExe)) {
    process.env.DAMING_DSH_EXE = process.env.DAMING_DSH_EXE || dshExe;
    // The entry lives inside app.asar; the DSH Electron executable reads it with ELECTRON_RUN_AS_NODE.
    process.env.DAMING_DSH_ENTRY = process.env.DAMING_DSH_ENTRY || dshEntry;
  }
}

const host = await startBoardHost({
  dataDir,
  port,
  webRoot,
  ...(singleUser ? { singleUser: true } : {}),
  ...(bootstrapToken ? { bootstrapToken } : {}),
});

// Stable handshake consumed by apps/desktop/src/host-lifecycle.ts.
process.stdout.write('DAMING_HOST_READY ' + JSON.stringify({ url: host.url, port: host.port }) + '\n');
process.stderr.write('Daming managed Host data: ' + dataDir + '\n');

let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  try { await host.close(); } finally { process.exit(0); }
};
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
process.on('disconnect', () => { void close(); });
// Graceful shutdown channel: the Electron shell writes "shutdown" to stdin so the Host can
// release its exclusive directory lock before exit (a hard kill would leave a stale lock).
process.stdin.resume();
process.stdin.on('data', (chunk) => { if (chunk.toString().includes('shutdown')) void close(); });
process.stdin.on('end', () => { void close(); });
await new Promise(() => undefined);
