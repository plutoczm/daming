#!/usr/bin/env node
/**
 * 把 Magpie 现存账号导入 Daming 自己的加密签到库（Daming 之后自己签到、逐步剥离 Magpie）。
 *   # 只列出（不导入、不打印密钥）
 *   node scripts/checkin-import-magpie.mjs --magpie-dir "<~/.config/magpie>" --list
 *   # 导入（AES-256-GCM 落盘；--include 只导入可签到平台如 workbuddy,zcode,kiro）
 *   node scripts/checkin-import-magpie.mjs --magpie-dir "<dir>" --store-dir "<dir>" \
 *        --passphrase "口令" --owner windows [--include workbuddy,kiro,zcode]
 * 也支持只读单个文件： --magpie-logins "<logins.json>"。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CheckinPolicy } from '../packages/governance/src/index.ts';
import {
  LocalCredentialStore, importMagpieAccounts, importMagpieSources, listMagpieAccounts, listMagpieSources,
} from '../services/checkin-agent/src/index.ts';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const flag = (n) => argv.includes('--' + n);
const readJson = (p) => JSON.parse(readFileSync(resolve(p), 'utf8'));

const dir = opt('magpie-dir');
const single = opt('magpie-logins');
if (!dir && !single) { console.error('usage: --magpie-dir <~/.config/magpie> [--list] | --magpie-logins <logins.json> [--list]'); process.exit(2); }

let sources;
if (dir) {
  const loginsPath = join(resolve(dir), 'logins.json');
  const pluginPath = join(resolve(dir), 'plugin-auth.json');
  sources = {
    ...(existsSync(loginsPath) ? { logins: readJson(loginsPath) } : {}),
    ...(existsSync(pluginPath) ? { pluginAuth: readJson(pluginPath) } : {}),
  };
} else {
  sources = { logins: readJson(single) };
}

if (flag('list')) {
  const accounts = dir ? listMagpieSources(sources) : listMagpieAccounts(sources.logins);
  console.log(JSON.stringify({ count: accounts.length, accounts }, null, 2));
  process.exit(0);
}

const storeDir = opt('store-dir');
const passphrase = opt('passphrase');
const owner = opt('owner', 'windows');
if (!storeDir || !passphrase) { console.error('导入需要 --store-dir 与 --passphrase'); process.exit(2); }
const include = opt('include') ? String(opt('include')).split(',').map((s) => s.trim()).filter(Boolean) : undefined;
const store = new LocalCredentialStore({ dir: storeDir, passphrase });
const policy = new CheckinPolicy();
const summary = dir
  ? importMagpieSources(sources, { store, policy, owner, nowMs: Date.now(), ...(include ? { include } : {}) })
  : importMagpieAccounts(sources.logins, { store, policy, owner, nowMs: Date.now(), ...(include ? { include } : {}) });
console.log(JSON.stringify({ storeDir: resolve(storeDir), owner, ...(include ? { include } : {}), ...summary }, null, 2));
