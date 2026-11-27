import { readFileSync } from 'node:fs';
import { buildWorkBuddyHeaders, wbPost } from '../services/checkin-agent/src/workbuddy.ts';
const pa = JSON.parse(readFileSync(process.env.USERPROFILE + '/.config/magpie/plugin-auth.json', 'utf8'));
const a = pa['workbuddy']; const acct = { access: a.access, uid: a.uid, domain: a.domain };
for (const model of ['deepseek-v4.1-flash', 'deepseek-v4-pro', 'auto']) {
  const h = buildWorkBuddyHeaders(acct, '5.9.3'); h['x-agent-type'] = 'main'; h['x-agent-runtime'] = 'local-agent';
  const body = JSON.stringify({ model, messages: [{ role: 'user', content: '请只回复 OK' }], stream: true, max_tokens: 64 });
  try {
    const r = await wbPost('https://copilot.tencent.com/v2/chat/completions', h, body, 60000);
    let content = '';
    for (const line of r.bodyText.split('\n')) { const t = line.trim(); if (!t.startsWith('data:')) continue; const d = t.slice(5).trim(); if (d === '[DONE]') break; try { const j = JSON.parse(d); const ch = j.choices && j.choices[0]; if (ch && ch.delta && typeof ch.delta.content === 'string') content += ch.delta.content; } catch {} }
    console.log(model, '->', r.status, '| content=', JSON.stringify(content.slice(0, 60)), r.status !== 200 ? '| ' + r.bodyText.slice(0, 160) : '');
  } catch (e) { console.log(model, '-> ERR', String(e).slice(0, 160)); }
}
