import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { CodexProtocolAdapter } from '@daming/workers';
import type { CodexCorrelation, CodexProtocolEvent, CodexTrackedMethod } from '@daming/workers';
import type { NativeHandshake } from './native-session.ts';
import { isProtocolRecord } from './native-session.ts';

const pinnedVersion = '0.169.0';

export const codexHandshake: NativeHandshake = {
  protocol: 'app-server',
  entrypoint: '/bin/sh',
  args: ['-ec', 'mkdir -p "$CODEX_HOME"; exec /opt/daming/node_modules/.bin/codex app-server --listen stdio://'],
  input: JSON.stringify({ id: 1, method: 'initialize', params: {
    clientInfo: { name: 'daming', version: '1' }, capabilities: { experimentalApi: true },
  } }),
  matches: ({ id, result }) => id === 1 && isProtocolRecord(result) &&
    result.platformOs === 'linux' && typeof result.userAgent === 'string' && /\b0\.169\.0\b/.test(result.userAgent),
};

export interface NativeCodexTurnResult {
  readonly threadId: string;
  readonly turnId: string;
  readonly status: 'completed' | 'interrupted' | 'failed';
  readonly output: string;
  readonly events: readonly CodexProtocolEvent[];
}

/** One ephemeral turn on an already initialized, pinned App Server pipe. */
export function runNativeCodexTurn(
  child: ChildProcessWithoutNullStreams, context: CodexCorrelation,
  model: string, text: string, relay: { baseUrl: string; token: string }, authorize: () => void,
  readWorkspace?: (path: string) => Promise<string>,
): Promise<NativeCodexTurnResult> {
  if (!/^[a-z0-9][a-z0-9._:/-]{0,159}$/i.test(model) || model.includes('..') || model.includes('://') ||
      typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 16_384 ||
      !/^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/v1$/.test(relay.baseUrl) || !/^[A-Za-z0-9_-]{43}$/.test(relay.token)) {
    return Promise.reject(new Error('Invalid native Codex turn input'));
  }
  const protocol = new CodexProtocolAdapter({ version: pinnedVersion, context, allowWorkspaceRead: !!readWorkspace });
  return new Promise((resolve, reject) => {
    let stopped = false;
    let threadId: string | undefined;
    let seen = 0;
    const messages = new Map<string, string>();
    const events: CodexProtocolEvent[] = [];
    const calls = new Set<string>();
    const replies = new Set<string | number>();
    let toolPending = false;
    const expiry = setTimeout(() => finish(new Error('Native Codex turn timed out')), 60_000);

    function finish(error?: Error, result?: NativeCodexTurnResult) {
      if (stopped) return;
      stopped = true;
      clearTimeout(expiry);
      child.stdout.off('data', receive);
      child.off('close', closed);
      child.stdin.off('error', closed);
      child.stdout.resume();
      if (error) reject(error);
      else resolve(result!);
    }
    function closed() { finish(new Error('Native Codex turn transport closed')); }
    function write(frame: object) {
      authorize();
      child.stdin.write(JSON.stringify(frame) + '\n', error => { if (error) closed(); });
    }
    function request(id: number, method: CodexTrackedMethod, params: object) {
      protocol.expectResponse({ id, method, ...(threadId ? { threadId } : {}) });
      write({ id, method, params });
    }
    async function workspaceRead(event: CodexProtocolEvent) {
      let text: string;
      let success = false;
      try {
        authorize();
        text = await readWorkspace!(event.workspaceFile!);
        success = true;
      } catch {
        text = 'The requested project file is unavailable.';
      }
      if (!stopped) {
        toolPending = false;
        write({ id: event.requestId, result: { success, contentItems: [{ type: 'inputText', text }] } });
      }
    }
    function accept(event: CodexProtocolEvent) {
      if (event.kind === 'rpc_error' || event.kind === 'request_blocked' || event.kind === 'transport_closed') {
        throw new Error('Native Codex request denied');
      }
      if (event.kind === 'workspace_read_requested') {
        const { workspaceFile: _privatePath, ...observed } = event;
        events.push(observed);
      } else events.push(event);
      if (events.length > 512) throw new Error('Native Codex event limit');
      if (event.kind === 'thread_bound') {
        threadId = event.threadId!;
        request(3, 'turn/start', { threadId, input: [{ type: 'text', text }] });
      }
      if (event.kind === 'workspace_read_requested') {
        if (!readWorkspace || toolPending || calls.has(event.callId!) || replies.has(event.requestId!)) {
          throw new Error('Native Codex workspace call denied');
        }
        toolPending = true;
        calls.add(event.callId!);
        replies.add(event.requestId!);
        void workspaceRead(event).catch(error => finish(error instanceof Error ? error : new Error('Native Codex workspace reply fenced')));
      }
      if (event.kind === 'message_completed') messages.set(event.itemId!, event.text!);
      if (event.kind === 'turn_completed') {
        if (toolPending) throw new Error('Native Codex turn reached terminal with a pending tool');
        authorize();
        finish(undefined, { threadId: threadId!, turnId: event.turnId!, status: event.status!,
          output: [...messages.values()].join('\n'), events });
      }
    }
    function receive(chunk: Buffer) {
      try {
        seen += chunk.length;
        if (seen > 2 * 1024 * 1024) throw new Error('Native Codex output limit');
        for (const event of protocol.push(chunk)) {
          accept(event);
          if (stopped) break;
        }
      } catch { finish(new Error('Native Codex App Server protocol failed')); }
    }

    child.stdout.on('data', receive);
    child.once('close', closed);
    child.stdin.on('error', closed);
    try {
      write({ method: 'initialized' });
      request(2, 'thread/start', {
        model, modelProvider: 'daming', cwd: '/work', ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never',
        ...(readWorkspace ? { dynamicTools: [{
          type: 'function', name: 'project_read_file', description: 'Read an approved text file from this project workspace.',
          inputSchema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'], additionalProperties: false },
        }] } : {}),
        config: {
          model_providers: { daming: {
            name: 'Daming private Responses', base_url: relay.baseUrl, wire_api: 'responses',
            requires_openai_auth: false, http_headers: { Authorization: 'Bearer ' + relay.token },
            request_max_retries: 0, stream_max_retries: 0, supports_websockets: false,
          } },
          features: { enable_request_compression: false, shell_tool: false, apps: false, multi_agent: false },
          web_search: 'disabled',
        },
      });
    } catch (error) { finish(error instanceof Error ? error : new Error('Native Codex turn setup failed')); }
  });
}
