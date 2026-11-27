/**
 * 数据面：托管 Daming 网关进程（`scripts/daming-gateway-serve.mjs`）。
 * 用我们的 `host/platform/providers.json`（DAMING_GATEWAY_PROVIDERS_FILE）起网关，
 * 让新增供应商真正经网关转发。Host 只负责进程生命周期，不碰网关内部状态。
 *
 * 说明：脚本路径由 `DAMING_GATEWAY_SERVE_SCRIPT` 或默认 `scripts/daming-gateway-serve.mjs` 解析；
 * 打包版需随包提供该入口（当前源码/开发态可用）。
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

export type GatewayServeState = 'stopped' | 'starting' | 'running' | 'failed';
export interface GatewayServeStatus {
  readonly state: GatewayServeState;
  readonly port: number;
  readonly providersFile: string;
  readonly scriptPath: string;
  readonly reason: string;
}
export interface GatewayServeOptions {
  readonly scriptPath: string;
  readonly providersFile: string;
  readonly port: number;
  readonly nodeExec?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly readyTimeoutMs?: number;
}

export class GatewayServeManager {
  private child: ChildProcess | null = null;
  private state: GatewayServeState = 'stopped';
  private reason = '';
  private readonly opts: GatewayServeOptions;

  constructor(opts: GatewayServeOptions) { this.opts = opts; }

  status(): GatewayServeStatus {
    return { state: this.state, port: this.opts.port, providersFile: this.opts.providersFile, scriptPath: this.opts.scriptPath, reason: this.reason };
  }

  async start(): Promise<GatewayServeStatus> {
    if (this.state === 'running' || this.state === 'starting') return this.status();
    this.state = 'starting'; this.reason = '';
    const nodeExec = this.opts.nodeExec ?? process.execPath;
    const env: Record<string, string | undefined> = {
      ...process.env, ...(this.opts.env ?? {}),
      DAMING_GATEWAY_PROVIDERS_FILE: this.opts.providersFile,
      DAMING_GATEWAY_PORT: String(this.opts.port),
      // 默认对出站请求自动脱敏；DAMING_GATEWAY_MASK=0 可关闭。
      DAMING_GATEWAY_MASK: process.env.DAMING_GATEWAY_MASK ?? '1',
    };
    let child: ChildProcess;
    try {
      child = spawn(nodeExec, [this.opts.scriptPath], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      this.state = 'failed'; this.reason = error instanceof Error ? error.message : 'gateway_spawn_failed';
      throw error;
    }
    this.child = child;
    const ready = this.opts.readyTimeoutMs ?? 12000;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (ok: boolean, reason?: string) => {
        if (settled) return; settled = true; clearTimeout(timer);
        if (ok) { this.state = 'running'; resolve(); }
        else { this.state = 'failed'; this.reason = reason ?? this.reason; reject(new Error(this.reason)); }
      };
      const timer = setTimeout(() => finish(false, 'gateway_start_timeout'), ready);
      child.stdout?.on('data', (chunk) => { if (chunk.toString().includes('daming-gateway on')) finish(true); });
      child.stderr?.on('data', (chunk) => { const text = chunk.toString().trim(); if (text && text.length < 2000) this.reason = text; });
      child.once('error', (error) => finish(false, error instanceof Error ? error.message : 'gateway_spawn_error'));
      child.once('exit', (code) => { if (this.child === child) { this.child = null; if (this.state !== 'failed') this.state = 'stopped'; } finish(false, 'gateway_exited_' + code); });
    });
    return this.status();
  }

  async stop(): Promise<GatewayServeStatus> {
    const child = this.child;
    this.child = null;
    if (child) {
      try { child.kill(); } catch { /* already gone */ }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    this.state = 'stopped';
    return this.status();
  }

  async reload(): Promise<GatewayServeStatus> {
    await this.stop();
    return this.start();
  }
}
