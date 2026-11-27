// Kiro (AWS CodeWhisperer) provider plugin (experimental).
// Env: KIRO_ACCESS, KIRO_PROFILE_ARN, KIRO_REGION (default us-east-1), KIRO_TOKEN_TYPE (e.g. EXTERNAL_IDP).
// Bearer + tokentype, POST https://codewhisperer.<region>.amazonaws.com/generateAssistantResponse,
// x-amz-target: AmazonCodeWhispererStreamingService.GenerateAssistantResponse, Accept: application/vnd.amazon.eventstream.
// Minimal event-stream parser: scan frames' JSON payloads for content chunks.
import { request } from 'node:https';

function post(region, headers, body) {
  const payload = Buffer.from(body, 'utf8');
  return new Promise((resolve, reject) => {
    const req = request({ hostname: 'codewhisperer.' + region + '.amazonaws.com', port: 443, path: '/generateAssistantResponse', method: 'POST', headers: { ...headers, 'content-length': String(payload.length) }, timeout: 120000 }, (r) => {
      const chunks = []; r.on('data', (d) => chunks.push(d));
      r.on('end', () => resolve({ status: r.statusCode || 0, buf: Buffer.concat(chunks) }));
      r.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject); req.end(payload);
  });
}
// Pull printable JSON objects out of an AWS event-stream buffer ('{"...":...}' payloads).
function extractEventText(buf) {
  const s = buf.toString('latin1');
  let out = '';
  const re = /\{[^{}]*"content"[^{}]*\}/g;
  let m;
  while ((m = re.exec(s)) !== null) { try { const j = JSON.parse(m[0]); if (typeof j.content === 'string') out += j.content; } catch {} }
  if (!out) {
    // fallback: any JSON with assistantResponseEvent content anywhere
    const re2 = /"content"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    while ((m = re2.exec(s)) !== null) { try { out += JSON.parse('"' + m[1] + '"'); } catch {} }
  }
  return out;
}
export default {
  async complete(bodyText) {
    const token = process.env.KIRO_ACCESS; if (!token) return { status: 401, contentType: 'application/json', bodyText: JSON.stringify({ error: { message: 'KIRO_ACCESS not set' } }) };
    const b = JSON.parse(bodyText);
    const msgs = Array.isArray(b.messages) ? b.messages : [];
    const last = [...msgs].reverse().find((m) => m && m.role === 'user');
    const prompt = last && typeof last.content === 'string' ? last.content : 'hi';
    const region = process.env.KIRO_REGION || 'us-east-1';
    const body = {
      conversationState: { chatTrigger: { triggerType: 'MANUAL' }, currentMessage: { userInputMessage: { content: prompt, modelId: b.model || 'claude-sonnet-4.5', origin: 'AI_EDITOR' } }, history: [] },
      ...(process.env.KIRO_PROFILE_ARN ? { profileArn: process.env.KIRO_PROFILE_ARN } : {}),
    };
    const headers = {
      'content-type': 'application/x-amz-json-1.0', accept: 'application/vnd.amazon.eventstream',
      authorization: 'Bearer ' + token, 'x-amz-target': 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse',
      ...(process.env.KIRO_TOKEN_TYPE ? { tokentype: process.env.KIRO_TOKEN_TYPE } : {}),
    };
    const r = await post(region, headers, JSON.stringify(body));
    if (r.status !== 200) return { status: r.status, contentType: 'application/json', bodyText: JSON.stringify({ error: { message: r.buf.toString('utf8').slice(0, 300) } }) };
    const text = extractEventText(r.buf);
    return { status: 200, contentType: 'application/json', bodyText: JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0 } }) };
  },
};
