import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type NotificationChannelId = 'feishu' | 'wecom' | 'wechat' | 'qq' | 'webhook';
export type NotificationEvent =
  | 'task.created' | 'task.approval' | 'task.review' | 'task.blocked'
  | 'task.completed' | 'task.failed' | 'autoloop.card'
  | 'portfolio.lifeline' | 'portfolio.digest';

export const ALL_EVENTS: readonly NotificationEvent[] = [
  'task.created', 'task.approval', 'task.review', 'task.blocked',
  'task.completed', 'task.failed', 'autoloop.card', 'portfolio.lifeline', 'portfolio.digest'
];

interface ChannelState {
  enabled: boolean;
  endpoint: string;
  secret: string;
  events: NotificationEvent[];
}

interface HubFile {
  channels: Record<NotificationChannelId, ChannelState>;
  publicBaseUrl: string;
  remoteToken: string;
  recent: { at: string; event: string; text: string; results: Record<string, string> }[];
}

const EMPTY: ChannelState = { enabled: false, endpoint: '', secret: '', events: [...ALL_EVENTS] };

function defaults(): HubFile {
  return {
    channels: {
      feishu: { ...EMPTY }, wecom: { ...EMPTY }, wechat: { ...EMPTY }, qq: { ...EMPTY }, webhook: { ...EMPTY }
    },
    publicBaseUrl: '',
    remoteToken: '',
    recent: []
  };
}

function mask(value: string): string {
  if (!value) return '';
  if (value.length <= 12) return '••••';
  return value.slice(0, 8) + '••••' + value.slice(-4);
}

/**
 * Local notification hub: outbound Feishu / WeCom / WeChat / QQ / generic webhook messages,
 * a long-lived remote-login token for phone access through a user-provided tunnel, and a small
 * recent-activity ring. Secrets never leave the Host to the browser.
 */
export class NotificationHub {
  private readonly file: string;
  private state: HubFile;
  private readonly onSend?: (channel: NotificationChannelId, text: string, endpoint: string, secret: string) => Promise<void>;

  constructor(dataDir: string, options: { onSend?: (channel: NotificationChannelId, text: string, endpoint: string, secret: string) => Promise<void> } = {}) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = join(dataDir, 'notification-hub.json');
    this.onSend = options.onSend;
    try { this.state = { ...defaults(), ...(JSON.parse(readFileSync(this.file, 'utf8')) as Partial<HubFile>) } as HubFile; }
    catch { this.state = defaults(); }
    if (!this.state.channels) this.state.channels = defaults().channels;
    if (!Array.isArray(this.state.recent)) this.state.recent = [];
  }
  private persist(): void {
    try { writeFileSync(this.file, JSON.stringify(this.state, null, 2) + '\n', { mode: 0o600 }); }
    catch { /* best effort; UI still works this session */ }
  }
  list() {
    return {
      channels: (Object.keys(this.state.channels) as NotificationChannelId[]).map((id) => {
        const channel = this.state.channels[id];
        return {
          id, enabled: channel.enabled, configured: !!channel.endpoint,
          endpointHint: mask(channel.endpoint), secretConfigured: !!channel.secret,
          events: channel.events
        };
      }),
      remote: {
        publicBaseUrl: this.state.publicBaseUrl,
        loginUrl: this.remoteLoginUrl(),
        hasToken: !!this.state.remoteToken
      },
      recent: this.state.recent.slice(-20).reverse()
    };
  }
  save(id: NotificationChannelId, input: { enabled?: unknown; endpoint?: unknown; secret?: unknown; events?: unknown }) {
    if (!this.state.channels[id]) throw new Error('notification_channel_invalid');
    const channel = this.state.channels[id];
    if (typeof input.enabled === 'boolean') channel.enabled = input.enabled;
    if (typeof input.endpoint === 'string') channel.endpoint = input.endpoint.trim();
    if (typeof input.secret === 'string') channel.secret = input.secret.trim();
    if (Array.isArray(input.events)) {
      channel.events = input.events.filter((event): event is NotificationEvent =>
        typeof event === 'string' && (ALL_EVENTS as readonly string[]).includes(event));
    }
    this.persist();
    return this.list();
  }
  setRemote(publicBaseUrl: unknown) {
    if (typeof publicBaseUrl === 'string') this.state.publicBaseUrl = publicBaseUrl.trim().replace(/\/+$/, '');
    this.persist();
    return this.list();
  }
  regenerateRemoteToken(): string {
    this.state.remoteToken = randomBytes(24).toString('base64url');
    this.persist();
    return this.remoteLoginUrl();
  }
  remoteLoginUrl(): string {
    if (!this.state.remoteToken) return '';
    const base = this.state.publicBaseUrl || 'http://127.0.0.1:3210';
    return base + '/api/remote/login?token=' + encodeURIComponent(this.state.remoteToken);
  }
  verifyRemoteToken(token: string): boolean {
    if (!this.state.remoteToken || typeof token !== 'string') return false;
    return createHash('sha256').update(this.state.remoteToken).digest('hex') ===
      createHash('sha256').update(token).digest('hex');
  }

  private async send(channel: NotificationChannelId, text: string): Promise<void> {
    const config = this.state.channels[channel];
    if (!config.enabled || !config.endpoint) throw new Error('notification_channel_not_configured');
    if (this.onSend) { await this.onSend(channel, text, config.endpoint, config.secret); return; }
    const body = channel === 'feishu' ? { msg_type: 'text', content: { text } }
      : channel === 'wecom' ? { msgtype: 'text', text: { content: text } }
      : channel === 'wechat' ? { title: '大铭任务板', desp: text }
      : channel === 'qq' ? { message: text }
      : { text, event: 'daming' };
    const response = await fetch(config.endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, ...(config.secret ? { secret: config.secret } : {}) }),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error('notification_send_failed_' + response.status);
  }
  async test(id: NotificationChannelId): Promise<void> {
    const link = this.remoteLoginUrl();
    await this.send(id, '【大铭】通知通道测试成功。' + (link ? '\n远程处理：' + link : ''));
  }
  async notify(event: NotificationEvent, text: string): Promise<void> {
    const link = this.remoteLoginUrl();
    const full = text + (link ? '\n远程处理：' + link : '');
    const results: Record<string, string> = {};
    for (const id of Object.keys(this.state.channels) as NotificationChannelId[]) {
      const channel = this.state.channels[id];
      if (!channel.enabled || !channel.endpoint || !channel.events.includes(event)) continue;
      try { await this.send(id, full); results[id] = 'sent'; }
      catch (error) { results[id] = error instanceof Error ? error.message : 'failed'; }
    }
    this.state.recent.push({ at: new Date().toISOString(), event, text, results });
    if (this.state.recent.length > 50) this.state.recent.splice(0, this.state.recent.length - 50);
    this.persist();
  }
}
