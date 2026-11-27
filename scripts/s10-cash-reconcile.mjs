/**
 * S10 authoritative cash reconciliation against a REAL paid vendor (DeepSeek official API).
 * Uses the provider-reported account balance as the authoritative number:
 *   1) read balance before
 *   2) one paid chat/completions call (single attempt, no retry)
 *   3) read balance after (poll until it settles)
 *   4) reconcile: observed delta>0 and <= approved hard limit (¥3 = 300 minor)
 * Records usage tokens + balance before/after/delta. Balance is provider-authoritative;
 * per-call invoice is not available from the vendor, so balance delta IS the receipt.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const env = readFileSync(resolve('.env'), 'utf8');
const key = (env.split(/\r?\n/).find((l) => l.startsWith('DEEPSEEK_API_KEY=')) || '').slice('DEEPSEEK_API_KEY='.length).trim();
if (!key) { console.error('no DEEPSEEK_API_KEY'); process.exit(2); }
const HARD_LIMIT_MINOR = 300; // ¥3
const BASE = 'https://api.deepseek.com';
const bal = async () => {
  const r = await fetch(BASE + '/user/balance', { headers: { authorization: 'Bearer ' + key } });
  const j = await r.json();
  const info = j.balance_infos?.[0];
  return { available: j.is_available, currency: info?.currency, total: Number(info?.total_balance) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proof = { stage: 'S10', vendor: 'DeepSeek official API', observedAt: new Date().toISOString(),
  hardLimitCnyMinor: HARD_LIMIT_MINOR, singleAttempt: true, automaticRetry: false };
try {
  const before = await bal();
  proof.before = before;
  const body = {
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: '逐行输出阿拉伯数字 1 到 2500，每行一个数字，禁止省略、禁止使用省略号，从 1 一直写到 2500。' }],
    max_tokens: 4096, stream: false, temperature: 0,
  };
  const t0 = Date.now();
  const res = await fetch(BASE + '/chat/completions', {
    method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await res.json();
  proof.elapsedMs = Date.now() - t0;
  proof.httpStatus = res.status;
  proof.usage = j.usage;
  proof.finishReason = j.choices?.[0]?.finish_reason;
  proof.outputChars = (j.choices?.[0]?.message?.content || '').length;
  if (res.status !== 200 || !j.usage) throw new Error('call_failed:' + res.status + ':' + (j.error?.message || ''));
  // Balance may lag; poll up to ~45s until it changes (or confirm stable).
  let after = await bal(); proof.after = after; proof.polledMs = 0;
  for (let i = 0; i < 15; i++) {
    if (after.total < before.total) break;
    await sleep(3000); proof.polledMs += 3000; after = await bal(); proof.after = after;
  }
  const deltaCny = Number((before.total - after.total).toFixed(4));
  proof.deltaCny = deltaCny;
  proof.deltaMinor = Math.round(deltaCny * 100);
  proof.reconciled = deltaCny > 0 && proof.deltaMinor <= HARD_LIMIT_MINOR;
  proof.method = 'provider balance delta (authoritative); per-call invoice not offered by vendor';
  if (!proof.reconciled) {
    proof.note = deltaCny > 0
      ? 'delta exceeds hard limit'
      : 'balance did not move at 2dp within poll window; cost sub-cent or balance lag — mark 未知待核对, do NOT fabricate';
  }
  if (!proof.reconciled) process.exitCode = 1;
} catch (error) {
  proof.error = String(error?.message || error).slice(0, 200);
  process.exitCode = 1;
} finally {
  mkdirSync('.cache/verification', { recursive: true });
  mkdirSync('docs/verification', { recursive: true });
  const json = JSON.stringify(proof, null, 2) + '\n';
  writeFileSync('.cache/verification/s10-cash-reconcile.json', json);
  writeFileSync('docs/verification/s10-cash-reconcile-2026-11-19.json', json);
  console.log(json);
}
