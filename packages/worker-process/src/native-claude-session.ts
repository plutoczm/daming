import type { NativeHandshake } from './native-session.ts';

const initialize = `
import { query } from '/opt/daming/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
import { mkdirSync } from 'node:fs';
import { once } from 'node:events';
const input = process.stdin;
const end = once(input, 'end');
const [ready] = await once(input, 'data');
if (ready.toString() !== 'initialize\\n') process.exit(2);
mkdirSync(process.env.HOME, { recursive: true });
const wait = Promise.withResolvers();
async function* noPrompt() { await wait.promise; }
const session = query({
  prompt: noPrompt(),
  options: {
    cwd: process.cwd(), persistSession: false, settingSources: [],
    pathToClaudeCodeExecutable: '/opt/daming/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude',
  },
});
try {
  const response = await session.initializationResult();
  console.log(JSON.stringify({ id: 1, version: response.claude_code_version }));
  await end;
} finally {
  session.close();
  wait.resolve();
}
`;

export const claudeHandshake: NativeHandshake = {
  protocol: 'agent-sdk',
  entrypoint: '/usr/local/bin/node',
  args: ['--input-type=module', '-e', initialize],
  input: 'initialize',
  matches: value => value?.id === 1 && value?.version === '2.1.326',
};

export interface NativeClaudeTurnResult {
  readonly sessionId: string;
  readonly status: 'completed' | 'failed';
  readonly output: string;
}

/** Fixed program for the already isolated Claude container. Config arrives on stdin. */
export const nativeClaudeTurnProgram = `
import { query } from '/opt/daming/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
let raw = '';
for await (const chunk of process.stdin) {
  raw += chunk;
  if (Buffer.byteLength(raw) > 32 * 1024) process.exit(2);
}
const { baseUrl, token, model, prompt, maximumOutputTokens } = JSON.parse(raw);
const session = query({
  prompt,
  options: {
    cwd: '/work', persistSession: false, settingSources: [], model, tools: [],
    permissionMode: 'dontAsk', maxTurns: 1,
    env: {
      ...process.env,
      SHELL: '/bin/sh',
      ANTHROPIC_BASE_URL: new URL(baseUrl).origin,
      ANTHROPIC_API_KEY: token,
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maximumOutputTokens),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1',
    },
    pathToClaudeCodeExecutable: '/opt/daming/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude',
  },
});
let sessionId, terminal;
try {
  for await (const message of session) {
    if (message.type === 'system' && message.subtype === 'init') sessionId = message.session_id;
    if (message.type !== 'result') continue;
    if (!sessionId || message.session_id !== sessionId || terminal) throw new Error('Claude result identity mismatch');
    terminal = message.subtype === 'success' && !message.is_error && typeof message.result === 'string'
      ? { sessionId, status: 'completed', output: message.result }
      : { sessionId, status: 'failed', output: '' };
  }
} catch {
  process.exitCode = 2;
} finally { session.close(); }
if (!terminal) process.exit(2);
console.log(JSON.stringify(terminal));
`;

/**
 * Tool-enabled turn (S10 real write/command). Runs Bash/Write/Edit/Read INSIDE
 * the already-isolated container (network none, read-only rootfs, /work tmpfs rw).
 * `permissionMode: 'bypassPermissions'` auto-approves the built-in tools; maxTurns
 * bounds the loop. The produced /work artifacts are read back by the Host via
 * captureWorkspace, not trusted from model text.
 */
export const nativeClaudeToolTurnProgram = `
import { query } from '/opt/daming/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
let raw = '';
for await (const chunk of process.stdin) {
  raw += chunk;
  if (Buffer.byteLength(raw) > 32 * 1024) process.exit(2);
}
const { baseUrl, token, model, prompt, maximumOutputTokens } = JSON.parse(raw);
const session = query({
  prompt,
  options: {
    cwd: '/work', persistSession: false, settingSources: [], model,
    tools: ['Bash', 'Write', 'Edit', 'Read'],
    allowedTools: ['Bash', 'Write', 'Edit', 'Read'],
    permissionMode: 'bypassPermissions', maxTurns: 8,
    env: {
      ...process.env,
      SHELL: '/bin/bash',
      ANTHROPIC_BASE_URL: new URL(baseUrl).origin,
      ANTHROPIC_API_KEY: token,
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maximumOutputTokens),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1',
    },
    pathToClaudeCodeExecutable: '/opt/daming/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude',
  },
});
let sessionId, terminal;
try {
  for await (const message of session) {
    if (message.type === 'system' && message.subtype === 'init') sessionId = message.session_id;
    if (message.type !== 'result') continue;
    if (!sessionId || message.session_id !== sessionId || terminal) throw new Error('Claude result identity mismatch');
    terminal = message.subtype === 'success' && !message.is_error && typeof message.result === 'string'
      ? { sessionId, status: 'completed', output: message.result }
      : { sessionId, status: 'failed', output: '' };
  }
} catch {
  process.exitCode = 2;
} finally { session.close(); }
if (!terminal) process.exit(2);
console.log(JSON.stringify(terminal));
`;
