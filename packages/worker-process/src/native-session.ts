import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { dshHandshake } from './native-dsh-session.ts';
import { codexHandshake } from './native-codex-session.ts';
import { claudeHandshake } from './native-claude-session.ts';

export type NativeOfflineAgent = 'dsh' | 'codex' | 'claude';
export type NativeOfflineProtocol = 'acp' | 'app-server' | 'agent-sdk';
export interface NativeHandshake {
  readonly protocol: NativeOfflineProtocol;
  readonly entrypoint: string;
  readonly args: readonly string[];
  readonly input: string;
  matches(message: Record<string, unknown>): boolean;
}

const handshakes = { dsh: dshHandshake, codex: codexHandshake, claude: claudeHandshake } as const;

export function nativeOfflineHandshake(agent: NativeOfflineAgent): NativeHandshake {
  if (!Object.hasOwn(handshakes, agent)) throw new Error('Unsupported native agent runtime');
  return handshakes[agent];
}

const MAX_BYTES = 256 * 1024;

export function isProtocolRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function initializeNativeOffline(child: ChildProcessWithoutNullStreams, handshake: NativeHandshake): Promise<void> {
  child.stderr.resume();
  child.stdin.on('error', () => {});
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    let total = 0;
    const timer = setTimeout(() => finish(new Error('Native initialization timed out')), 12_000);
    function finish(error?: Error) {
      clearTimeout(timer);
      child.stdout.off('data', receive);
      child.off('close', closed);
      child.stdout.resume();
      if (error) reject(error);
      else resolve();
    }
    function closed() {
      finish(new Error('Native initialization transport closed'));
    }
    function receive(chunk: Buffer) {
      total += chunk.length;
      if (total > MAX_BYTES) return finish(new Error('Native initialization output exceeded its limit'));
      buffered = Buffer.concat([buffered, chunk]);
      let newline: number;
      while ((newline = buffered.indexOf(10)) !== -1) {
        const line = buffered.subarray(0, newline);
        buffered = buffered.subarray(newline + 1);
        let message: unknown;
        try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); }
        catch { continue; }
        if (!isProtocolRecord(message) || !Object.hasOwn(message, 'id')) continue;
        if (handshake.matches(message)) return finish();
        return finish(new Error('Native initialization returned an unexpected response'));
      }
    }
    child.once('error', closed);
    child.once('close', closed);
    child.stdout.on('data', receive);
    child.stdin.write(handshake.input + '\n');
  });
}
