import { buildWorkBuddyHeaders, wbPost, WB_APP, WB_DEFAULT_ENDPOINT } from './workbuddy.ts';
import type { WorkBuddyAccount } from './workbuddy.ts';
import type { ProviderPlugin } from '../../daming-gateway/src/plugins.ts';

/**
 * WorkBuddy (subscription) as a Daming gateway ProviderPlugin — subscription-account
 * model supply, the way Magpie serves it: chat completions at <endpoint>/v2, streamed
 * only, with WorkBuddy client headers. complete() drains the SSE into an OpenAI JSON.
 */
export function workBuddyChatPlugin(o: { account: WorkBuddyAccount; models: readonly string[]; id?: string; endpoint?: string; app?: string }): ProviderPlugin {
  const endpoint = (o.endpoint ?? WB_DEFAULT_ENDPOINT).replace(/\/+$/, '');
  const app = o.app ?? WB_APP;
  return {
    id: o.id ?? 'workbuddy',
    models: o.models,
    async complete(bodyText: string) {
      const body = JSON.parse(bodyText) as Record<string, unknown>;
      const headers = buildWorkBuddyHeaders(o.account, app);
      headers['x-agent-type'] = 'main';
      headers['x-agent-runtime'] = 'local-agent';
      const r = await wbPost(endpoint + '/v2/chat/completions', headers, JSON.stringify({ ...body, stream: true }), 120000);
      if (r.status !== 200) return { status: r.status, contentType: 'application/json', bodyText: JSON.stringify({ error: { message: r.bodyText.slice(0, 300) } }) };
      let content = '';
      let usage: Record<string, number> = {};
      for (const line of r.bodyText.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const d = t.slice(5).trim();
        if (d === '[DONE]') break;
        try {
          const j = JSON.parse(d) as Record<string, unknown>;
          const ch = (Array.isArray(j.choices) ? j.choices[0] : undefined) as Record<string, unknown> | undefined;
          const delta = (ch?.delta ?? {}) as Record<string, unknown>;
          if (typeof delta.content === 'string') content += delta.content;
          if (j.usage && typeof j.usage === 'object') usage = j.usage as Record<string, number>;
        } catch { /* ignore keepalive/other frames */ }
      }
      return { status: 200, contentType: 'application/json', bodyText: JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: usage.prompt_tokens ?? 0, completion_tokens: usage.completion_tokens ?? 0 } }) };
    },
  };
}
