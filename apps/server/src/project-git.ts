/**
 * 项目工作台 · B 阶段（验证门 + Git 提交/推送，就地执行）。
 *
 * 设计取向（个人自用）：
 *   - 不做隔离副本：直接在工作目录里跑验证门与提交（用户明确要求「不用准备隔离副本」）。
 *     工作目录优先用项目登记的源码目录；没有则用 daming 自己的项目目录 projects/<id>。
 *   - 验证门由 Agent 执行：本模块负责「确定性执行」，跑项目自己的 package.json 脚本
 *     （lint / typecheck / test / test:unit / test:integration / e2e …），返回逐项结果。
 *     不使用 shell:true；npm/pnpm 通过 node 直接加载其 CLI JS 运行。
 *   - Git：在工作目录里 init/add/commit；推送时优先 gh CLI（已安装且已登录），否则明确报告缺凭据。
 *     绝不伪造推送成功。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { providerForHost, type GitProvider } from './git-account.ts';

const PROJECT_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const GATE_ORDER = ['lint', 'typecheck', 'test', 'test:unit', 'test:integration', 'e2e', 'test:e2e'];

export class ProjectGitError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export interface RunResult {
  readonly script: string;
  readonly command: string;
  readonly ok: boolean;
  readonly code: number | null;
  readonly signal: string | null;
  readonly ms: number;
  readonly outputTail: string;
}

export interface VerifyView {
  readonly workspaceDir: string;
  readonly ranAt: string;
  readonly passed: boolean;
  readonly results: readonly RunResult[];
  readonly note?: string;
}

export interface GitStatusView {
  readonly workspaceDir: string;
  readonly isRepo: boolean;
  readonly branch: string | null;
  readonly remoteUrl: string | null;
  readonly configuredRemote?: string | null;
  readonly dirty: boolean;
  readonly lastCommit: string | null;
}

export interface CommitView {
  readonly committed: boolean;
  readonly hash?: string;
  readonly message?: string;
  readonly reason?: string;
}

export interface PushView {
  readonly ok: boolean;
  readonly created?: boolean;
  readonly remoteUrl?: string;
  readonly outputTail?: string;
  readonly reason?: string;
  readonly hint?: string;
}

interface WorkDirMeta {
  workingDir: string;
  sourceDir?: string;
  updatedAt: string;
  fileCount?: number;
}

function nodeDir(): string { return dirname(process.execPath); }

function firstExisting(paths: string[]): string | null {
  for (const path of paths) { if (existsSync(path)) return path; }
  return null;
}

function npmCli(): string | null {
  const candidates = [
    join(nodeDir(), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir(), 'node_modules', 'npm', 'lib', 'cli.js'),
    'D:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
    'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'
  ];
  if (process.env.ProgramFiles) candidates.push(join(process.env.ProgramFiles, 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  return firstExisting(candidates);
}

function corepackJs(): string | null {
  return firstExisting([
    join(nodeDir(), 'node_modules', 'corepack', 'dist', 'corepack.js'),
    join(nodeDir(), 'node_modules', 'corepack', 'dist', 'lib', 'corepack.js'),
    'D:\\nodejs\\node_modules\\corepack\\dist\\corepack.js'
  ]);
}

function ghBinary(): string {
  return firstExisting([
    'D:\\Daming\\tools\\gh\\bin\\gh.exe',
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'gh', 'bin', 'gh.exe')
  ]) ?? 'gh';
}

function run(bin: string, args: string[], cwd: string, timeoutMs: number): Promise<{ command: string; ok: boolean; code: number | null; signal: string | null; ms: number; stdout: string; stderr: string; outputTail: string }> {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    let out = '';
    let err = '';
    const cap = (text: string, chunk: Buffer): string => {
      const next = text + chunk.toString('utf8');
      return next.length > 8000 ? next.slice(next.length - 8000) : next;
    };
    let child;
    try {
      child = spawn(bin, args, { cwd, shell: false, windowsHide: true });
    } catch (error) {
      resolvePromise({ command: [bin, ...args].join(' '), ok: false, code: null, signal: null, ms: 0, stdout: '', stderr: '', outputTail: 'spawn_failed: ' + (error instanceof Error ? error.message : String(error)) });
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => { out = cap(out, chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { err = cap(err, chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolvePromise({ command: [bin, ...args].join(' '), ok: false, code: null, signal: null, ms: Date.now() - started, stdout: out, stderr: err, outputTail: 'spawn_error: ' + error.message });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const tail = (out + (err ? '\n' + err : '')).trim();
      resolvePromise({ command: [bin, ...args].join(' '), ok: code === 0, code: code ?? null, signal: signal ?? null, ms: Date.now() - started, stdout: out, stderr: err, outputTail: tail.length > 4000 ? tail.slice(tail.length - 4000) : tail });
    });
  });
}

function runCapture(bin: string, args: string[], cwd: string, timeoutMs = 60000): Promise<{ ok: boolean; code: number | null; stdout: string; output: string }> {
  return run(bin, args, cwd, timeoutMs).then((result) => ({ ok: result.ok, code: result.code, stdout: result.stdout, output: result.outputTail }));
}

export class ProjectGit {
  private readonly rootDir: string;
  private readonly accounts?: { tokenFor(provider: GitProvider): string };
  constructor(rootDir: string, accounts?: { tokenFor(provider: GitProvider): string }) {
    this.rootDir = rootDir;
    this.accounts = accounts;
  }

  private projectDir(projectId: string): string {
    if (!PROJECT_ID.test(projectId)) throw new ProjectGitError(400, 'invalid_project_id');
    return join(this.rootDir, projectId);
  }

  private metaPath(projectId: string): string { return join(this.projectDir(projectId), '.daming', 'workdir.json'); }

  readMeta(projectId: string): WorkDirMeta | null {
    const path = this.metaPath(projectId);
    if (!existsSync(path)) return null;
    try { return JSON.parse(readFileSync(path, 'utf8')) as WorkDirMeta; } catch { return null; }
  }

  /** 当前工作目录：登记的源码目录，否则 daming 自己的项目目录。 */
  workDir(projectId: string): string {
    const meta = this.readMeta(projectId);
    if (meta?.workingDir) return meta.workingDir;
    return this.projectDir(projectId);
  }

  private remotePath(projectId: string): string { return join(this.projectDir(projectId), '.daming', 'remote.json'); }

  /** 读取项目保存的上传仓库地址（没有则空串）。 */
  getRemoteUrl(projectId: string): string {
    const path = this.remotePath(projectId);
    if (!existsSync(path)) return '';
    try { const parsed = JSON.parse(readFileSync(path, 'utf8')) as { repoUrl?: string }; return typeof parsed.repoUrl === 'string' ? parsed.repoUrl : ''; } catch { return ''; }
  }

  /** 保存/清除项目的上传仓库地址；若工作目录已是 git 仓库，同步 origin。 */
  async setRemoteUrl(projectId: string, repoUrl?: string): Promise<{ repoUrl: string }> {
    const clean = (repoUrl ?? '').trim().replace(/\/+$/, '');
    if (clean && !/^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/i.test(clean)) {
      throw new ProjectGitError(400, 'bad_repo_url');
    }
    const dir = this.projectDir(projectId);
    mkdirSync(join(dir, '.daming'), { recursive: true });
    if (clean) writeFileSync(this.remotePath(projectId), JSON.stringify({ repoUrl: clean, updatedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
    else { try { rmSync(this.remotePath(projectId)); } catch { /* ignore */ } }
    const work = this.workDir(projectId);
    if (clean && existsSync(join(work, '.git'))) {
      await runCapture('git', ['remote', 'remove', 'origin'], work);
      await runCapture('git', ['remote', 'add', 'origin', clean], work);
    }
    return { repoUrl: clean };
  }

  /** 设定工作目录（就地执行，不复制）。 */
  setWorkDir(projectId: string, sourceDir?: string): { workspaceDir: string; fileCount: number } {
    const base = this.projectDir(projectId);
    mkdirSync(base, { recursive: true });
    let workingDir = base;
    if (sourceDir && sourceDir.trim()) {
      const src = resolve(sourceDir.trim());
      if (!existsSync(src) || !statSync(src).isDirectory()) throw new ProjectGitError(400, 'work_dir_not_found');
      workingDir = src;
    }
    mkdirSync(workingDir, { recursive: true });
    const meta: WorkDirMeta = { workingDir, sourceDir: sourceDir?.trim() || undefined, updatedAt: new Date().toISOString(), fileCount: this.countFiles(workingDir) };
    mkdirSync(dirname(this.metaPath(projectId)), { recursive: true });
    writeFileSync(this.metaPath(projectId), JSON.stringify(meta, null, 2) + '\n', 'utf8');
    return { workspaceDir: workingDir, fileCount: meta.fileCount ?? 0 };
  }

  private countFiles(dir: string, depth = 0): number {
    if (depth > 40 || !existsSync(dir)) return 0;
    let count = 0;
    for (const entry of readdirSafe(dir)) {
      if (entry === '.git' || entry === 'node_modules') continue;
      const full = join(dir, entry);
      try {
        const info = statSync(full);
        if (info.isDirectory()) count += this.countFiles(full, depth + 1);
        else if (info.isFile()) count += 1;
      } catch { /* ignore */ }
    }
    return count;
  }

  /** 读取 package.json，按 GATE_ORDER 选出存在的验证脚本。 */
  detectGates(dir: string): { scripts: string[]; missing: string[] } {
    const pkgPath = join(dir, 'package.json');
    if (!existsSync(pkgPath)) return { scripts: [], missing: GATE_ORDER };
    let pkg: { scripts?: Record<string, string> } = {};
    try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> }; } catch { return { scripts: [], missing: GATE_ORDER }; }
    const have = pkg.scripts ?? {};
    const scripts = GATE_ORDER.filter((name) => typeof have[name] === 'string');
    const missing = GATE_ORDER.filter((name) => typeof have[name] !== 'string');
    return { scripts, missing };
  }

  private runner(dir: string): { bin: string; prefix: string[]; label: string } | null {
    if (existsSync(join(dir, 'pnpm-lock.yaml'))) {
      const cp = corepackJs();
      if (cp) return { bin: process.execPath, prefix: [cp, 'pnpm'], label: 'corepack pnpm' };
    }
    const npm = npmCli();
    if (npm) return { bin: process.execPath, prefix: [npm], label: 'npm' };
    return null;
  }

  /** 运行验证门（Agent 的确定性执行）。 */
  async verify(projectId: string, timeoutMs = 180000): Promise<VerifyView> {
    const dir = this.workDir(projectId);
    if (!existsSync(dir)) throw new ProjectGitError(409, 'work_dir_not_set');
    const { scripts } = this.detectGates(dir);
    const runner = this.runner(dir);
    const ranAt = new Date().toISOString();
    if (!runner) return { workspaceDir: dir, ranAt, passed: false, results: [], note: 'no_package_manager_cli' };
    if (!scripts.length) return { workspaceDir: dir, ranAt, passed: false, results: [], note: 'no_verifiable_scripts' };
    const results: RunResult[] = [];
    for (const script of scripts) {
      const result = await run(runner.bin, [...runner.prefix, 'run', script], dir, timeoutMs);
      results.push({ script, command: result.command, ok: result.ok, code: result.code, signal: result.signal, ms: result.ms, outputTail: result.outputTail });
      if (!result.ok) break;
    }
    const passed = results.length === scripts.length && results.every((row) => row.ok);
    const payload: VerifyView = { workspaceDir: dir, ranAt, passed, results };
    mkdirSync(dirname(this.metaPath(projectId)), { recursive: true });
    writeFileSync(join(this.projectDir(projectId), '.daming', 'verify.json'), JSON.stringify(payload, null, 2) + '\n', 'utf8');
    return payload;
  }

  async gitStatus(projectId: string): Promise<GitStatusView> {
    const dir = this.workDir(projectId);
    const isRepo = existsSync(join(dir, '.git'));
    const configuredRemote = this.getRemoteUrl(projectId) || null;
    if (!existsSync(dir) || !isRepo) return { workspaceDir: dir, isRepo: false, branch: null, remoteUrl: null, configuredRemote, dirty: false, lastCommit: null };
    const branchRun = await runCapture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], dir);
    const remoteRun = await runCapture('git', ['remote', 'get-url', 'origin'], dir);
    const statusRun = await runCapture('git', ['status', '--porcelain'], dir);
    const logRun = await runCapture('git', ['log', '-1', '--pretty=%h %s'], dir);
    return {
      workspaceDir: dir,
      isRepo: true,
      branch: branchRun.ok ? branchRun.stdout.trim() : null,
      remoteUrl: remoteRun.ok ? remoteRun.stdout.trim() : null,
      configuredRemote,
      dirty: statusRun.ok && statusRun.stdout.trim().length > 0,
      lastCommit: logRun.ok ? logRun.stdout.trim() : null
    };
  }

  private async ensureIdentity(dir: string): Promise<void> {
    const name = (await runCapture('git', ['config', 'user.name'], dir)).stdout.trim();
    const email = (await runCapture('git', ['config', 'user.email'], dir)).stdout.trim();
    if (!name) await runCapture('git', ['config', 'user.name', 'daming'], dir);
    if (!email) await runCapture('git', ['config', 'user.email', 'daming@local'], dir);
  }

  async commit(projectId: string, message?: string): Promise<CommitView> {
    const dir = this.workDir(projectId);
    if (!existsSync(dir)) throw new ProjectGitError(409, 'work_dir_not_set');
    if (!existsSync(join(dir, '.git'))) {
      const init = await runCapture('git', ['init', '-b', 'main'], dir);
      if (!init.ok) return { committed: false, reason: 'git_init_failed: ' + init.output };
    }
    await this.ensureIdentity(dir);
    await runCapture('git', ['add', '-A'], dir);
    const status = await runCapture('git', ['status', '--porcelain'], dir);
    if (!status.stdout.trim()) return { committed: false, reason: 'nothing_to_commit' };
    const msg = (message && message.trim()) || 'daming: checkpoint';
    const result = await runCapture('git', ['commit', '-m', msg], dir);
    if (!result.ok) return { committed: false, reason: 'commit_failed: ' + result.output };
    const hash = (await runCapture('git', ['rev-parse', '--short', 'HEAD'], dir)).stdout.trim();
    return { committed: true, hash, message: msg };
  }

  async push(projectId: string, opts: { repoName?: string; visibility?: 'private' | 'public'; repoUrl?: string; token?: string } = {}): Promise<PushView> {
    const dir = this.workDir(projectId);
    if (!existsSync(join(dir, '.git'))) return { ok: false, reason: 'not_a_repo' };
    // 优先用本次传入的地址；否则用项目已保存的上传地址
    const incoming = (opts.repoUrl ?? '').trim();
    const cleanUrl = incoming || this.getRemoteUrl(projectId);
    if (incoming) { try { await this.setRemoteUrl(projectId, incoming); } catch { /* 地址非法会在下面校验返回 */ } }
    // 令牌：本次传入优先，否则复用平台已保存的 Git 身份（按仓库域名匹配 github/gitee）
    const hostMatch = /^(?:https?:\/\/|ssh:\/\/|git@)(?:[^@/]+@)?([^/:]+)/i.exec(cleanUrl);
    const provider = hostMatch ? providerForHost(hostMatch[1]) : null;
    const effectiveToken = (opts.token ?? '').trim() || (provider ? this.accounts?.tokenFor(provider) ?? '' : '');
    const mask = (text: string): string => (effectiveToken ? text.split(effectiveToken).join('***') : text);

    // 1) 用户已自建空仓库：给仓库地址，直接 git push（不需要 gh，兼容 GitHub/Gitee/GitLab 等）
    if (cleanUrl) {
      if (!/^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/i.test(cleanUrl)) {
        return { ok: false, reason: 'bad_repo_url', hint: '仓库地址需为 https://... 或 git@... 形式。' };
      }
      const bare = cleanUrl.replace(/\/+$/, '').replace(/\.git$/i, '');
      const baseUrl = bare + '.git';
      let pushUrl = baseUrl;
      if (effectiveToken && /^https?:\/\//i.test(baseUrl)) {
        // 仅本次推送临时带上 token，成功后远程仍存干净地址，token 不落盘
        pushUrl = baseUrl.replace(/^(https?:\/\/)/i, `$1x-access-token:${effectiveToken}@`);
      }
      const pushed = await runCapture('git', ['push', pushUrl, 'HEAD:refs/heads/main', '--force'], dir, 180000);
      if (!pushed.ok) {
        const authed = /Authentication failed|could not read Username|terminal prompts disabled|403/i.test(pushed.output);
        return {
          ok: false,
          reason: authed ? 'push_auth_required' : 'push_failed',
          outputTail: mask(pushed.output),
          hint: authed ? '仓库需要认证：在「仓库令牌」填 Personal Access Token（GitHub: repo 权限；Gitee: projects 权限），或先在本机 git 凭据里登录。' : '请确认仓库已在 GitHub/Gitee 建好且地址正确。'
        };
      }
      // 推送成功：把 origin 设为干净地址（不含 token）
      await runCapture('git', ['remote', 'remove', 'origin'], dir);
      await runCapture('git', ['remote', 'add', 'origin', baseUrl], dir);
      return { ok: true, remoteUrl: baseUrl, outputTail: mask(pushed.output) };
    }

    // 2) 已有 origin：直接推
    const remoteRun = await runCapture('git', ['remote', 'get-url', 'origin'], dir);
    const remote = remoteRun.ok ? remoteRun.stdout.trim() : '';
    if (remote) {
      const pushed = await runCapture('git', ['push', '-u', 'origin', 'HEAD'], dir, 180000);
      return pushed.ok ? { ok: true, remoteUrl: remote, outputTail: pushed.output } : { ok: false, reason: 'push_failed', outputTail: pushed.output };
    }

    // 3) 没地址也没 origin：尝试 gh 自动建仓
    const ghBin = ghBinary();
    const gh = await runCapture(ghBin, ['--version'], dir, 15000);
    if (!gh.ok) {
      return { ok: false, reason: 'gh_not_installed', hint: '可先在 GitHub/Gitee 自建空仓库，把仓库地址填进来直接推送；或安装 gh 并 `gh auth login`。' };
    }
    const name = (opts.repoName && opts.repoName.trim()) || projectId;
    const args = ['repo', 'create', name, opts.visibility === 'public' ? '--public' : '--private', '--source', dir, '--remote', 'origin', '--push'];
    const created = await runCapture(ghBin, args, dir, 180000);
    if (!created.ok) return { ok: false, reason: 'gh_create_failed', outputTail: mask(created.output), hint: '请确认 gh 已登录（gh auth status）。' };
    const urlRun = await runCapture('git', ['remote', 'get-url', 'origin'], dir);
    return { ok: true, created: true, remoteUrl: urlRun.ok ? urlRun.stdout.trim() : undefined, outputTail: mask(created.output) };
  }
}

function readdirSafe(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}
