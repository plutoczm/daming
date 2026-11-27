import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON = resolve(HERE, '../remote/checkin-daemon.mjs');

function wbServer(mode: 'claim' | 'already' | '401'): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((res) => {
    const srv = createServer((req, r) => {
      let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
        const j = (o: unknown, st = 200) => { r.writeHead(st, { 'content-type': 'application/json' }); r.end(JSON.stringify(o)); };
        if (req.url?.endsWith('/checkin-activity-status')) {
          if (mode === '401') return j({}, 401);
          if (mode === 'already') return j({ active: true, today_checked_in: true, today_credit: 88 });
          return j({ active: true, today_checked_in: false });
        }
        if (req.url?.endsWith('/daily-checkin')) return j({ credit: 100, streak_days: 12 });
        r.writeHead(404); r.end();
      });
    });
    srv.listen(0, '127.0.0.1', () => res({ url: 'http://127.0.0.1:' + (srv.address() as { port: number }).port, close: () => new Promise<void>((x) => srv.close(() => x())) }));
  });
}
function runDaemonOnce(dir: string): Promise<number | null> {
  return new Promise((res) => {
    const c = spawn(process.execPath, [join(dir, 'checkin-daemon.mjs'), '--once'], { cwd: dir, stdio: 'ignore', windowsHide: true });
    c.once('close', (code) => res(code)); c.once('error', () => res(-1));
  });
}

async function scenario(mode: 'claim' | 'already' | '401', expectKind: string) {
  const up = await wbServer(mode);
  const d = mkdtempSync(join(tmpdir(), 'daming-daemon-'));
  try {
    copyFileSync(DAEMON, join(d, 'checkin-daemon.mjs'));
    writeFileSync(join(d, 'config.json'), JSON.stringify({ owner: 'linux', platform: { kind: 'workbuddy', baseUrl: up.url }, accounts: [{ accountId: 'wb1', platform: 'workbuddy', token: 'tok', owner: 'linux' }], intervalMs: 60000 }));
    const code = await runDaemonOnce(d);
    assert.equal(code, 0);
    const lines = readFileSync(join(d, 'report.jsonl'), 'utf8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    assert.equal(last.results[0].kind, expectKind);
  } finally { await up.close(); rmSync(d, { recursive: true, force: true }); }
}

test('daemon(workbuddy): active & not checked -> claimed', async () => { await scenario('claim', 'claimed'); });
test('daemon(workbuddy): today checked -> already', async () => { await scenario('already', 'already'); });
test('daemon(workbuddy): 401 -> needs_human (no bypass)', async () => { await scenario('401', 'needs_human'); });
