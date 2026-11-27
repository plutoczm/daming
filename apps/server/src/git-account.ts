/**
 * 平台级 Git 身份（一次验证，全平台项目复用）。
 *
 * 个人自用取向：
 *   - 在设置里粘贴一次 GitHub / Gitee 访问令牌，在线校验后保存；
 *   - 之后所有项目推送同一平台时自动复用该令牌（无需每个项目重复填）；
 *   - 令牌只存在本机 `host/git-account.json`，文件权限 0600；接口只回传掩码信息。
 *   - 网络不可达时仍保存令牌，但标记 verified=false 并给出说明，绝不伪造“已验证”。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type GitProvider = 'github' | 'gitee';

export interface GitAccountView {
  readonly provider: GitProvider;
  readonly username: string;
  readonly hasToken: boolean;
  readonly verified: boolean;
  readonly verifiedAt: string | null;
  readonly note?: string;
}

interface GitAccountRecord {
  provider: GitProvider;
  username: string;
  token: string;
  verified: boolean;
  verifiedAt: string | null;
  note?: string;
}

const PROVIDERS: readonly GitProvider[] = ['github', 'gitee'];

export function normalizeProvider(value: unknown): GitProvider | null {
  return value === 'github' || value === 'gitee' ? value : null;
}

export function providerForHost(host: string): GitProvider | null {
  const lower = host.toLowerCase();
  if (lower.includes('github')) return 'github';
  if (lower.includes('gitee')) return 'gitee';
  return null;
}

async function verifyToken(provider: GitProvider, token: string): Promise<{ ok: boolean; username?: string; note?: string }> {
  const url = provider === 'github'
    ? 'https://api.github.com/user'
    : `https://gitee.com/api/v5/user?access_token=${encodeURIComponent(token)}`;
  const headers: Record<string, string> = { 'user-agent': 'daming', accept: 'application/json' };
  if (provider === 'github') headers.authorization = `Bearer ${token}`;
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (res.status === 401 || res.status === 403) return { ok: false, note: 'token_rejected' };
    if (!res.ok) return { ok: false, note: `http_${res.status}` };
    const data = (await res.json().catch(() => ({}))) as { login?: string; name?: string };
    const username = String(data.login ?? data.name ?? '');
    return { ok: true, username };
  } catch {
    return { ok: false, note: 'network_unreachable' };
  }
}

export interface CreatedRepoView {
  readonly provider: GitProvider;
  readonly fullName: string;
  readonly cloneUrl: string;
  readonly htmlUrl: string;
  readonly private: boolean;
}

export class GitAccountStore {
  private readonly path: string;

  constructor(rootDir: string) {
    this.path = join(rootDir, 'git-account.json');
  }

  private read(): Partial<Record<GitProvider, GitAccountRecord>> {
    if (!existsSync(this.path)) return {};
    try { return JSON.parse(readFileSync(this.path, 'utf8')) as Partial<Record<GitProvider, GitAccountRecord>>; } catch { return {}; }
  }

  private write(data: Partial<Record<GitProvider, GitAccountRecord>>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  }

  /** 供推送复用：返回该平台的令牌（没有则空串）。 */
  tokenFor(provider: GitProvider): string {
    return this.read()[provider]?.token ?? '';
  }

  list(): GitAccountView[] {
    const data = this.read();
    return PROVIDERS.filter((provider) => data[provider]).map((provider) => {
      const row = data[provider]!;
      return { provider, username: row.username, hasToken: Boolean(row.token), verified: row.verified, verifiedAt: row.verifiedAt, note: row.note };
    });
  }

  async save(provider: GitProvider, rawToken: string): Promise<GitAccountView> {
    const token = (rawToken ?? '').trim();
    if (!token) throw new Error('empty_token');
    const fmtOk = provider === 'github'
      ? /^(github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|[A-Fa-f0-9]{40})$/.test(token)
      : /^[A-Fa-f0-9]{32,64}$/.test(token);
    if (!fmtOk) throw new Error('invalid_token_format');
    const result = await verifyToken(provider, token);
    if (!result.ok && result.note === 'token_rejected') throw new Error('token_rejected');
    const record: GitAccountRecord = {
      provider,
      username: result.username ?? '',
      token,
      verified: result.ok,
      verifiedAt: result.ok ? new Date().toISOString() : null,
      note: result.note
    };
    const data = this.read();
    data[provider] = record;
    this.write(data);
    return { provider, username: record.username, hasToken: true, verified: record.verified, verifiedAt: record.verifiedAt, note: record.note };
  }

  /** 用已保存的平台令牌在当前账号下新建一个空仓库，返回可直推的 https 地址。 */
  async createRepo(provider: GitProvider, opts: { name: string; private?: boolean; description?: string }): Promise<CreatedRepoView> {
    const token = this.tokenFor(provider);
    if (!token) throw new Error('no_token');
    const name = (opts.name ?? '').trim();
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) throw new Error('invalid_repo_name');
    const isPrivate = opts.private !== false;
    const description = (opts.description ?? '').slice(0, 350);
    try {
      if (provider === 'github') {
        const res = await fetch('https://api.github.com/user/repos', {
          method: 'POST',
          headers: { 'user-agent': 'daming', accept: 'application/json', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ name, private: isPrivate, description, auto_init: false }),
          signal: AbortSignal.timeout(20000)
        });
        if (res.status === 401 || res.status === 403) throw new Error('token_no_create_permission');
        if (res.status === 422) throw new Error('repo_exists');
        if (!res.ok) throw new Error(`create_failed_${res.status}`);
        const d = (await res.json()) as { full_name?: string; clone_url?: string; html_url?: string; private?: boolean };
        return { provider, fullName: String(d.full_name ?? name), cloneUrl: String(d.clone_url ?? `https://github.com/${d.full_name ?? name}.git`), htmlUrl: String(d.html_url ?? ''), private: Boolean(d.private) };
      }
      const body = new URLSearchParams({ access_token: token, name, private: String(isPrivate), description });
      const res = await fetch('https://gitee.com/api/v5/user/repos', {
        method: 'POST',
        headers: { 'user-agent': 'daming', accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(20000)
      });
      if (res.status === 401 || res.status === 403) throw new Error('token_no_create_permission');
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        if (/already exists|已存在/i.test(txt)) throw new Error('repo_exists');
        throw new Error(`create_failed_${res.status}`);
      }
      const d = (await res.json()) as { full_name?: string; path?: string; html_url?: string; private?: boolean };
      const full = String(d.full_name ?? d.path ?? name);
      return { provider, fullName: full, cloneUrl: `https://gitee.com/${full}.git`, htmlUrl: String(d.html_url ?? `https://gitee.com/${full}`), private: Boolean(d.private) };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'create_failed';
      if (code === 'network_unreachable' || code.startsWith('create_failed') || code === 'token_no_create_permission' || code === 'repo_exists' || code === 'no_token' || code === 'invalid_repo_name') throw error;
      throw new Error('network_unreachable');
    }
  }

  clear(provider: GitProvider): void {    const data = this.read();
    delete data[provider];
    if (Object.keys(data).length > 0) this.write(data);
    else { try { rmSync(this.path); } catch { /* ignore */ } }
  }
}
