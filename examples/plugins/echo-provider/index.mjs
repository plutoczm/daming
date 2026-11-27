// Sample Daming provider plugin — echoes the last user message.
// Drop this directory under DAMING_PLUGINS_DIR and it becomes a model provider; no core change.
export default {
  async complete(bodyText) {
    let b = {};
    try { b = JSON.parse(bodyText); } catch { b = {}; }
    const msgs = Array.isArray(b.messages) ? b.messages : [];
    const last = [...msgs].reverse().find((m) => m && m.role === 'user');
    const text = last && typeof last.content === 'string' ? last.content : (typeof b.input === 'string' ? b.input : '');
    return {
      status: 200,
      contentType: 'application/json',
      bodyText: JSON.stringify({
        choices: [{ message: { content: 'ECHO:' + text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    };
  },
};
