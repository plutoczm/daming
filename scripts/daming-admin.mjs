#!/usr/bin/env node
/** Persistent Daming admin console. usage: daming-admin [--port 3470]
 *  Env: ADMIN_PORT, DAMING_PROVIDERS_FILE, DAMING_PLUGINS_DIR */
import { createAdminServer } from '../services/admin/src/index.ts';

const args = process.argv.slice(2);
const pi = args.indexOf('--port');
const port = Number(pi >= 0 && args[pi + 1] ? args[pi + 1] : process.env.ADMIN_PORT ?? 3470);
const h = createAdminServer({
  ...(process.env.DAMING_PROVIDERS_FILE ? { providersFile: process.env.DAMING_PROVIDERS_FILE } : {}),
  ...(process.env.DAMING_PLUGINS_DIR ? { pluginsDir: process.env.DAMING_PLUGINS_DIR } : {}),
});
const url = await h.listen(port);
console.log('Daming admin console on', url, '→ open', url + '/admin');
