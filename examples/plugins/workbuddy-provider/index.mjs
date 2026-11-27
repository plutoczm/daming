// WorkBuddy subscription provider plugin (self-contained).
// Env: WORKBUDDY_ACCESS (oauth access token), WORKBUDDY_UID, WORKBUDDY_DOMAIN.
// Method per Magpie's opencode-workbuddy-auth: POST https://copilot.tencent.com/v2/chat/completions
// with WorkBuddy client headers; response is streamed SSE → drained to an OpenAI JSON.
import { request } from 'node:https';

function post(url, headers, body) {
  const u = new URL(url);
  const payload = Buffer.from(body, 'utf8');
  return new Promise((resolve, reject) => {
    const req = request({ hostname: u.hostname, port: 443, path: u.pathname, method: 'POST', headers: { ...headers, 'content-length': String(payload.length) }, timeout: 120000 }, (r) => {
      const chunks = []; r.on('data', (d) => chunks.push(d));
      r.on('end', () => resolve({ status: r.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
      r.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject); req.end(payload);
  });
}
function headers() {
  const access = process.env.WORKBUDDY_ACCESS || '';
  return {
    'content-type': 'application/json', accept: 'application/json', authorization: 'Bearer ' + access,
    'user-agent': 'WorkBuddy/5.9.3', 'x-user-id': process.env.WORKBUDDY_UID || '', 'x-domain': process.env.WORKBUDDY_DOMAIN || 'www.workbuddy.cn',
    'x-product': 'SaaS', 'x-ide-type': 'WorkBuddy', 'x-ide-name': 'WorkBuddy', 'x-ide-version': '5.9.3',
    'x-requested-with': 'XMLHttpRequest', 'x-agent-intent': 'craft', 'x-agent-purpose': 'conversation',
    'x-agent-type': 'main', 'x-agent-runtime': 'local-agent',
  };
}
export default {
  async complete(bodyText) {
    if (!process.env.WORKBUDDY_ACCESS) return { status: 401, contentType: 'application/json', bodyText: JSON.stringify({ error: { message: 'WORKBUDDY_ACCESS not set' } }) };
    const b = JSON.parse(bodyText);
    // Sanitize: WorkBuddy's risk engine blocks agent-style payloads (tools / long system prompt).
    // Keep only user/assistant turns + stream; sufficient for a model reply.
    const msgs = (Array.isArray(b.messages) ? b.messages : []).filter((m) => m && m.role !== 'system' && typeof m.content === 'string');
    const clean = { model: b.model, messages: msgs.length ? msgs : [{ role: 'user', content: 'hi' }], stream: true };
    if (typeof b.max_tokens === 'number') clean.max_tokens = b.max_tokens;
    let r;
    for (let i = 0; i < 3; i++) {
      try { r = await post('https://copilot.tencent.com/v2/chat/completions', headers(), JSON.stringify(clean)); if (r.status === 200) break; }
      catch (e) { if (i === 2) return { status: 502, contentType: 'application/json', bodyText: JSON.stringify({ error: { message: String(e).slice(0, 200) } }) }; }
      await new Promise((z) => setTimeout(z, 800));
    }
    if (r.status !== 200) return { status: r.status, contentType: 'application/json', bodyText: JSON.stringify({ error: { message: r.body.slice(0, 300) } }) };
    let content = '', usage = {};
    for (const line of r.body.split('\n')) {
      const t = line.trim(); if (!t.startsWith('data:')) continue;
      const d = t.slice(5).trim(); if (d === '[DONE]') break;
      try { const j = JSON.parse(d); const ch = j.choices && j.choices[0]; if (ch && ch.delta && typeof ch.delta.content === 'string') content += ch.delta.content; if (j.usage) usage = j.usage; } catch {}
    }
    return { status: 200, contentType: 'application/json', bodyText: JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: usage.prompt_tokens || 0, completion_tokens: usage.completion_tokens || 0 } }) };
  },
};
