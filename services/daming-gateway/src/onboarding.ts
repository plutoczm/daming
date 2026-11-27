import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * M6 — Agent 接入（“打开接入”）: render/write each agent's config so it points at
 * the Daming gateway (OpenAI/Anthropic compatible). Writes ONLY under a target dir;
 * never touches the user's real ~/.codex / ~/.claude / DSH profile.
 */
export type AgentId = 'dsh' | 'codex' | 'claude';
export interface AgentEndpoint {
  readonly openaiBaseUrl: string;   // e.g. http://127.0.0.1:XXXX   (OpenAI: <base>/v1/...)
  readonly anthropicBaseUrl: string;// Anthropic /v1/messages base
  readonly apiKey?: string;
  readonly model: string;
}
export interface AgentConfigFile {
  readonly agent: AgentId;
  readonly path: string;
  readonly format: 'toml' | 'env';
  readonly content: string;
}

function keyOf(ep: AgentEndpoint): string { return ep.apiKey ?? 'daming'; }

export function renderAgentConfig(agent: AgentId, ep: AgentEndpoint): AgentConfigFile {
  if (agent === 'codex') {
    const content = [
      '# Codex -> Daming gateway (generated; review before use)',
      'model_provider = "daming"',
      'model = ' + JSON.stringify(ep.model),
      '',
      '[model_providers.daming]',
      'name = "Daming gateway"',
      'base_url = ' + JSON.stringify(ep.openaiBaseUrl.replace(/\/+$/, '') + '/v1'),
      'wire_api = "responses"',
      'env_key = "DAMING_GATEWAY_KEY"',
      'request_max_retries = 0',
      'stream_max_retries = 0',
      'supports_websockets = false',
      '',
    ].join('\n');
    return { agent, path: 'codex.config.toml', format: 'toml', content };
  }
  if (agent === 'claude') {
    const content = [
      '# Claude Code -> Daming gateway (generated)',
      'ANTHROPIC_BASE_URL=' + ep.anthropicBaseUrl,
      'ANTHROPIC_API_KEY=' + keyOf(ep),
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
      'DISABLE_TELEMETRY=1',
      '',
    ].join('\n');
    return { agent, path: 'claude.env', format: 'env', content };
  }
  const content = [
    '# DeepSeek Harness -> Daming gateway (OpenAI-completions provider; generated)',
    'DAMING_GATEWAY_OPENAI_BASE_URL=' + ep.openaiBaseUrl.replace(/\/+$/, '') + '/v1',
    'DAMING_GATEWAY_KEY=' + keyOf(ep),
    'DSH_DEFAULT_MODEL=' + ep.model,
    '',
  ].join('\n');
  return { agent, path: 'dsh.env', format: 'env', content };
}

/** Write the agent config(s) under `dir` (created if needed). Returns the file paths. */
export function writeAgentConfigs(agents: readonly AgentId[], ep: AgentEndpoint, dir: string): AgentConfigFile[] {
  const base = resolve(dir);
  mkdirSync(base, { recursive: true });
  const out: AgentConfigFile[] = [];
  for (const agent of agents) {
    const file = renderAgentConfig(agent, ep);
    const full = join(base, file.path);
    if (!resolve(full).startsWith(base)) throw new Error('agent_config_escapes_dir');
    writeFileSync(full, file.content, { mode: 0o600 });
    out.push(file);
  }
  return out;
}
