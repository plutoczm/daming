import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DOCKER_AGENT_ISOLATION_ARGS } from './tenant-docker-sandbox.ts';
import type { PaidModelResult, TrustedAgentRunner } from './trusted-paid-egress.ts';

export class TrustedAgentProcessError extends Error {
  readonly reason: string;
  constructor(reason: string) { super(reason); this.reason = reason; }
}
const DOCKER = 'D:\\Docker\\resources\\bin\\docker.exe';
const PIPE = 'npipe:////./pipe/dockerDesktopLinuxEngine';
// This fixed code has no socket access, no key, no URL and no command-exec API.
// The model intent only triggers an already-frozen Host-owned call.
const WORKER = [
  'import json,sys,os',
  'raw=sys.stdin.readline(9001)',
  'if not raw or len(raw)>9000: sys.exit(11)',
  'job=json.loads(raw)',
  'if not isinstance(job,dict) or set(job)!={"requestId","nonce","prompt"}: sys.exit(12)',
  'if not all(isinstance(job[k],str) for k in job): sys.exit(13)',
  'print(json.dumps({"type":"model_intent","requestId":job["requestId"],"nonce":job["nonce"]},separators=(",",":")),flush=True)',
  'answer=json.loads(sys.stdin.readline(90000))',
  'if not isinstance(answer,dict) or set(answer)!={"type","nonce","text"}: sys.exit(14)',
  'if answer["type"]!="model_reply" or answer["nonce"]!=job["nonce"] or not isinstance(answer["text"],str): sys.exit(15)',
  'print(json.dumps({"type":"final","nonce":job["nonce"],"text":answer["text"]},separators=(",",":")),flush=True)'
].join('\n');

export const runTrustedBrokerAgent: TrustedAgentRunner = async (intent, invokeBroker) => {
  if (process.platform !== 'win32' || !existsSync(DOCKER)) {
    throw new TrustedAgentProcessError('trusted_agent_docker_not_available');
  }
  if (!/^[a-f0-9-]{36}$/i.test(intent.requestId) ||
      typeof intent.prompt !== 'string' || intent.prompt.length > 2048 ||
      Buffer.byteLength(intent.prompt, 'utf8') > 8192) {
    throw new TrustedAgentProcessError('trusted_agent_intent_invalid');
  }
  const nonce = randomUUID(), name = 'daming-egress-' + randomUUID();
  const args = [...DOCKER_AGENT_ISOLATION_ARGS, '--name=' + name,
    '--entrypoint=/usr/local/bin/python3', 'python:3.12-slim',
    '-I', '-u', '-c', WORKER];
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(DOCKER, args, {
      shell: false, windowsHide: true, stdio: ['pipe','pipe','pipe']
    });
    let ended = false, count = 0, frame = 0, buffer = Buffer.alloc(0);
    let finalText: string | undefined;
    const reap = () => {
      const cleanup = spawn(DOCKER, [
        '--host', PIPE, 'rm', '--force', name
      ], { shell: false, windowsHide: true, stdio: 'ignore' });
      cleanup.on('error', () => {});
      cleanup.unref();
    };
    const stop = (error?: Error, result?: string) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      if (error) {
        child.kill(); reap(); reject(error);
      } else resolve(result!);
    };
    const timer = setTimeout(() => stop(new TrustedAgentProcessError('trusted_agent_timeout')), 45000);
    child.on('error', () => stop(new TrustedAgentProcessError('trusted_agent_launch_failed')));
    child.stderr.on('data', (data: Buffer) => {
      count += data.length;
      if (count > 4096) stop(new TrustedAgentProcessError('trusted_agent_stderr_limit'));
    });
    child.stdin.on('error', () => { /* close/timeout determines outcome */ });
    child.stdin.write(JSON.stringify({ requestId: intent.requestId, nonce, prompt: intent.prompt }) + '\n');
    child.stdout.on('data', (data: Buffer) => {
      if (ended) return;
      if (buffer.length + data.length > 80000) {
        stop(new TrustedAgentProcessError('trusted_agent_output_limit'));
        return;
      }
      buffer = Buffer.concat([buffer, data]);
      let end: number;
      while (!ended && (end = buffer.indexOf(10)) !== -1) {
        const line = buffer.subarray(0, end).toString('utf8');
        buffer = buffer.subarray(end + 1);
        let msg: unknown;
        try { msg = JSON.parse(line); } catch {
          stop(new TrustedAgentProcessError('trusted_agent_frame_invalid'));
          return;
        }
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
          stop(new TrustedAgentProcessError('trusted_agent_frame_invalid'));
          return;
        }
        const packet = msg as Record<string, unknown>;
        if (packet.nonce !== nonce) {
          stop(new TrustedAgentProcessError('trusted_agent_nonce_mismatch'));
          return;
        }
        if (frame === 0 && packet.type === 'model_intent' &&
            packet.requestId === intent.requestId && Object.keys(packet).length === 3) {
          frame++;
          void invokeBroker().then(reply => {
            if (ended) return;
            if (typeof reply.text !== 'string' || reply.text.length > 16000 ||
                Buffer.byteLength(reply.text, 'utf8') > 62000) {
              stop(new TrustedAgentProcessError('trusted_agent_reply_invalid'));
              return;
            }
            child.stdin.end(JSON.stringify({ type: 'model_reply', nonce, text: reply.text }) + '\n');
          }, error => stop(error instanceof Error ? error :
            new TrustedAgentProcessError('trusted_agent_broker_failed')));
          continue;
        }
        if (frame === 1 && packet.type === 'final' &&
            typeof packet.text === 'string' && Object.keys(packet).length === 3) {
          frame++;
          finalText = packet.text;
          continue;
        }
        stop(new TrustedAgentProcessError('trusted_agent_unexpected_frame'));
      }
    });
    child.once('close', code => {
      if (ended) return;
      if (code !== 0 || frame !== 2 || buffer.length !== 0 || finalText === undefined)
        stop(new TrustedAgentProcessError('trusted_agent_incomplete_result'));
      else stop(undefined, finalText);
    });
  });
};
