// Codex (ChatGPT subscription) provider plugin — uses Daming's own codex-relay service.
// The WebSocket relay protocol is ported into services/codex-relay (typechecked + tested).
// Token/account from env CODEX_ACCESS / CODEX_ACCOUNT_ID (fallback: ~/.config/magpie/logins.json).
import { readFileSync } from 'node:fs';
import { codexWsTurn } from '../../../services/codex-relay/src/index.ts';

function creds() {
  let token = process.env.CODEX_ACCESS, acct = process.env.CODEX_ACCOUNT_ID;
  if (!token) {
    try {
      const j = JSON.parse(readFileSync((process.env.USERPROFILE || '') + '/.config/magpie/logins.json', 'utf8'));
      const cx = (j || []).find((r) => r.agent === 'codex');
      token = cx?.auth?.tokens?.access_token; acct = cx?.auth?.tokens?.account_id;
    } catch { /* ignore */ }
  }
  return { token, acct };
}
export default {
  async complete(bodyText) {
    const b = JSON.parse(bodyText);
    const msgs = Array.isArray(b.messages) ? b.messages : [];
    const last = [...msgs].reverse().find((m) => m && m.role === 'user');
    const prompt = last && typeof last.content === 'string' ? last.content : (typeof b.input === 'string' ? b.input : 'hi');
    const model = b.model || 'gpt-6.2-sol';
    const { token, acct } = creds();
    if (!token) return { status: 401, contentType: 'application/json', bodyText: JSON.stringify({ error: { message: 'codex token missing' } }) };
    const r = await codexWsTurn({ model, prompt, token, accountId: acct });
    if (r.error) return { status: 502, contentType: 'application/json', bodyText: JSON.stringify({ error: { message: r.error } }) };
    return { status: 200, contentType: 'application/json', bodyText: JSON.stringify({ choices: [{ message: { content: r.text }, finish_reason: 'stop' }], usage: r.usage }) };
  },
};
