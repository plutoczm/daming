// ZCode (GLM Coding Plan) provider plugin (self-contained). Anthropic-compatible wire.
// Env: ZCODE_KEY (coding-plan key), ZCODE_BASE (default https://api.z.ai/api/anthropic).
import { request } from 'node:https';

function post(base, headers, body) {
  const u = new URL(base + '/v1/messages');
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
export default {
  async complete(bodyText) {
    if (!process.env.ZCODE_KEY) return { status: 401, contentType: 'application/json', bodyText: JSON.stringify({ error: { message: 'ZCODE_KEY not set' } }) };
    const b = JSON.parse(bodyText);
    const msgs = (Array.isArray(b.messages) ? b.messages : []).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: typeof m.content === 'string' ? m.content : '' }));
    const body = { model: b.model || 'glm-5.3', max_tokens: b.max_tokens || 1024, messages: msgs.length ? msgs : [{ role: 'user', content: 'hi' }] };
    const r = await post((process.env.ZCODE_BASE || 'https://api.z.ai/api/anthropic').replace(/\/+$/, ''), { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', authorization: 'Bearer ' + process.env.ZCODE_KEY }, JSON.stringify(body));
    if (r.status !== 200) return { status: r.status, contentType: 'application/json', bodyText: JSON.stringify({ error: { message: r.body.slice(0, 300) } }) };
    let text = '', usage = {};
    try { const j = JSON.parse(r.body); text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(''); if (j.usage) usage = { prompt_tokens: j.usage.input_tokens || 0, completion_tokens: j.usage.output_tokens || 0 }; } catch {}
    return { status: 200, contentType: 'application/json', bodyText: JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage }) };
  },
};
