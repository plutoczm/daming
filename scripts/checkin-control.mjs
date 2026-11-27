#!/usr/bin/env node
/**
 * 主控侧 CLI：远程控制学校 Linux 上的常驻签到进程。
 *   node scripts/checkin-control.mjs --host 172.23.207.70 --user czm2025 --key ~/.ssh/id_rsa \
 *        --remote-dir /mnt/ext-disk/czm2025/Projects/daming-checkin --action start|stop|status|once
 * 说明：start/stop/status 均通过 SSH 远程执行，主控不持有进程；主控关闭不影响 Linux 进程，
 *       只有显式 --action stop 才会停止它。
 */
import { RemoteCheckinController } from '../apps/server/src/remote-checkin-control.ts';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const host = opt('host'); const user = opt('user'); const action = opt('action');
if (!host || !user || !['start', 'stop', 'status', 'once'].includes(action)) {
  console.error('usage: node scripts/checkin-control.mjs --host H --user U [--port 22] [--key PATH] [--remote-dir DIR] --action start|stop|status|once');
  process.exit(2);
}
const controller = new RemoteCheckinController({ host, user, port: Number(opt('port', 22)), ...(opt('key') ? { keyPath: opt('key') } : {}), ...(opt('remote-dir') ? { remoteDir: opt('remote-dir') } : {}) });
const result = await controller[action]();
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.code === 0 ? 0 : 1;
