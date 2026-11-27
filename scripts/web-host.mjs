import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { startBoardHost } from '../apps/server/src/http.ts';
import { loadEnv } from './load-env.mjs';

loadEnv(resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env'));

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Usage: node scripts/web-host.mjs [--port 3210] [--data-dir PATH] [--token TOKEN] [--read-token TOKEN]');
  process.exit(0);
}

const portText = arg('--port');
const port = portText === undefined ? 3210 : Number(portText);
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid --port');
const dataDir = resolve(arg('--data-dir') ?? process.env.DAMING_DATA_DIR ?? join(process.env.LOCALAPPDATA ?? process.env.USERPROFILE ?? '.', 'Daming'));
const bootstrapToken = arg('--token');
const readOnlyBootstrapToken = arg('--read-token');

const host = await startBoardHost({ dataDir, port, ...(bootstrapToken ? { bootstrapToken } : {}), ...(readOnlyBootstrapToken ? { readOnlyBootstrapToken } : {}) });
console.log(`Daming Web Host ready`);
if (existsSync(join(dataDir, 'identity-required.flag'))) {
  console.log(`Sign-in URL: ${host.url}`);
  console.log('Persistent identity enabled; legacy bootstrap-token links are disabled.');
} else {
  console.log(`First-time bootstrap URL: ${host.url}?token=${encodeURIComponent(host.bootstrapToken)}`);
  if (host.readOnlyBootstrapToken) console.log(`Read-only bootstrap URL: ${host.url}?token=${encodeURIComponent(host.readOnlyBootstrapToken)}`);
}
console.log(`Data: ${dataDir}`);

const close = async () => {
  await host.close();
  process.exit(0);
};
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
await new Promise(() => undefined);
