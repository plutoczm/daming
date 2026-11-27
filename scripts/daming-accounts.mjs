#!/usr/bin/env node
/** Daming account inventory CLI. usage: daming-accounts list [--magpie-dir DIR] */
import { resolve } from 'node:path';
import { scanAccounts, readQuotas } from '../services/accounts/src/index.ts';

const args = process.argv.slice(2);
const i = args.indexOf('--magpie-dir');
const opts = i >= 0 && args[i + 1] ? { magpieDir: resolve(args[i + 1]) } : {};
if (args[0] === 'quota') {
  const qs = await readQuotas(opts);
  console.log(`quotas: ${qs.length}`);
  for (const q of qs) console.log('  ' + q.provider.padEnd(12), q.id.padEnd(20), q.remainingMinor !== undefined ? (`remaining=${q.remainingMinor} ${q.unit || ''}`) : (q.unknown ? 'unknown' : ''), q.error ? 'ERR ' + q.error : '');
  process.exit(0);
}
if (args[0] !== 'list') { console.log('usage: daming-accounts list|quota [--magpie-dir DIR]'); process.exit(0); }
const { accounts, errors } = scanAccounts(opts);
console.log(`accounts: ${accounts.length}${errors.length ? ' errors=' + errors.join(',') : ''}`);
for (const a of accounts) {
  const exp = a.expiresAt ? new Date(a.expiresAt * (a.expiresAt < 1e12 ? 1000 : 1)).toISOString().slice(0, 19) : '-';
  console.log('  ' + a.provider.padEnd(12), a.id.padEnd(20), 'access=' + (a.hasAccess ? 'Y' : 'N'), 'refresh=' + (a.hasRefresh ? 'Y' : 'N'), 'type=' + (a.type || '-'), 'exp=' + exp, a.accountId ? 'acct=' + a.accountId : '', a.detail || '');
}
