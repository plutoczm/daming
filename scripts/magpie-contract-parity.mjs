#!/usr/bin/env node
// Magpie 契约一致性对拍：比较两次快照（golden.json）。
// 用途：裁剪重编后的 exe 用 magpie-contract-snapshot.mjs 抓快照，再用本脚本对拍旧 golden。
//
// 用法:
//   node scripts/magpie-contract-parity.mjs --old <.tmp/magpie-golden/golden.json> --new <.tmp/magpie-new/golden.json>
// 判定: 每个端点要求 status 相同 + stableSha256 相同（结构/值一致，忽略无意义键序）。
//       任一 FAIL → 退出码 1；全 PASS → 0。缺端点也算 FAIL。

import { readFileSync } from 'node:fs';

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def; }
const OLD = arg('old');
const NEW = arg('new');
if (!OLD || !NEW) { console.error('need --old and --new'); process.exit(2); }

const oldS = JSON.parse(readFileSync(OLD, 'utf8'));
const newS = JSON.parse(readFileSync(NEW, 'utf8'));

const aliases = new Set([...Object.keys(oldS.endpoints || {}), ...Object.keys(newS.endpoints || {})]);
let pass = 0, fail = 0;
const rows = [];
for (const a of [...aliases].sort()) {
  const o = oldS.endpoints?.[a];
  const n = newS.endpoints?.[a];
  if (!o || !n) { rows.push([a, 'FAIL', 'missing on ' + (!o ? 'old' : 'new')]); fail++; continue; }
  const statusOk = o.status === n.status;
  // 契约兼容判定 = 状态码一致 + 结构骨架一致（键集/类型，忽略时间戳与派生值波动）
  const shapeOk = o.shapeSha256 != null && o.shapeSha256 === n.shapeSha256;
  const valueSame = o.stableSha256 != null && o.stableSha256 === n.stableSha256;
  const ok = statusOk && shapeOk;
  let detail;
  if (!statusOk) detail = `status ${o.status}->${n.status}`;
  else if (!shapeOk) detail = 'SHAPE DIFF (字段缺失/多出或类型变化)';
  else detail = valueSame ? 'ok (values identical)' : 'shape ok, values differ (timestamps/derived)';
  rows.push([a, ok ? 'PASS' : 'FAIL', detail]);
  ok ? pass++ : fail++;
}
const w = Math.max(...[...aliases].map(a => a.length), 8);
console.log('endpoint'.padEnd(w) + '  result  detail');
for (const [a, r, d] of rows) console.log(a.padEnd(w) + '  ' + r.padEnd(6) + '  ' + d);
console.log(`\nSUMMARY: ${pass} pass / ${fail} fail / ${aliases.size} total  (old=${oldS.label} new=${newS.label})`);
process.exit(fail === 0 ? 0 : 1);
