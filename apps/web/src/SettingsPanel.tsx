import { useEffect, useState } from 'react';
import type { GitAccountView, GitProvider, SessionView } from '@daming/contracts';
import type { ThemePreference } from './theme.ts';
import { ThemeSegments } from './ThemeSegments.tsx';

export function SettingsPanel({
  session,
  onNavigate,
  themePreference,
  onThemeChange
}: {
  session: SessionView;
  onNavigate: (page: string) => void;
  themePreference: ThemePreference;
  onThemeChange: (next: ThemePreference) => void;
}) {
  const bridge = window.daming;
  const [closeBehavior, setCloseBehavior] = useState<'tray' | 'quit' | null>(null);
  const [accounts, setAccounts] = useState<GitAccountView[]>([]);
  const [gitProvider, setGitProvider] = useState<GitProvider>('github');
  const [gitToken, setGitToken] = useState('');
  const [gitBusy, setGitBusy] = useState(false);
  const [gitNote, setGitNote] = useState('');

  useEffect(() => {
    let alive = true;
    fetch('/api/git-account', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : { accounts: [] }))
      .then((d: { accounts?: GitAccountView[] }) => { if (alive) setAccounts(d.accounts ?? []); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const saveGit = async () => {
    setGitBusy(true); setGitNote('');
    try {
      const res = await fetch('/api/git-account', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-daming-csrf': session.csrfToken },
        body: JSON.stringify({ provider: gitProvider, token: gitToken })
      });
      const data = await res.json().catch(() => ({})) as { account?: GitAccountView; reason?: string };
      if (!res.ok || !data.account) {
        const reason = String(data.reason ?? res.status);
        setGitNote('保存失败：' + (reason === 'token_rejected' ? '令牌被平台拒绝（无效或权限不足）' : reason === 'invalid_token_format' ? '令牌格式不对（GitHub 应为 github_pat_… 或 ghp_…，Gitee 为 32–64 位十六进制）' : reason));
        return;
      }
      const acc = data.account;
      setAccounts((prev) => [...prev.filter((a) => a.provider !== acc.provider), acc]);
      setGitToken('');
      setGitNote(acc.verified ? `已验证：${acc.provider} 账号 ${acc.username || '(未知)'}` : `已保存，但未能在线验证（${acc.note ?? '网络不可达'}）；推送时会再尝试。`);
    } catch (error) { setGitNote(error instanceof Error ? error.message : '保存失败'); }
    finally { setGitBusy(false); }
  };

  const clearGit = async (provider: GitProvider) => {
    setGitBusy(true);
    try {
      await fetch(`/api/git-account?provider=${provider}`, { method: 'DELETE', credentials: 'same-origin', headers: { 'x-daming-csrf': session.csrfToken } });
      setAccounts((prev) => prev.filter((a) => a.provider !== provider));
      setGitNote('已清除该平台身份。');
    } finally { setGitBusy(false); }
  };

  useEffect(() => {
    let alive = true;
    bridge?.getCloseBehavior?.().then((res) => { if (alive) setCloseBehavior(res.behavior); }).catch(() => {});
    return () => { alive = false; };
  }, [bridge]);

  const chooseClose = (next: 'tray' | 'quit') => {
    setCloseBehavior(next);
    void bridge?.setCloseBehavior?.(next);
  };

  return (
    <section className="page-stack settings-page" aria-label="设置">
      <header className="page-head"><div><h2>设置</h2></div></header>

      <div className="settings-group">
        <div className="settings-group-title">外观</div>
        <div className="settings-list">
          <div className="settings-row settings-row--static">
            <span>
              <strong>主题</strong>
              <em>白天是暖纸浅色，暗夜是深墨；跟随系统会随时段自动切换。</em>
            </span>
            <ThemeSegments preference={themePreference} onChange={onThemeChange} />
          </div>
        </div>
      </div>

      {bridge && closeBehavior && (
        <div className="settings-group">
          <div className="settings-group-title">窗口</div>
          <div className="settings-list">
            <div className="settings-row settings-row--static">
              <span>
                <strong>关闭窗口时</strong>
                <em>最小化到托盘：窗口关闭后仍在后台运行，点托盘图标可恢复；直接退出：彻底关闭大铭。</em>
              </span>
              <div className="seg" role="radiogroup" aria-label="关闭窗口时">
                <button
                  type="button"
                  role="radio"
                  aria-checked={closeBehavior === 'tray'}
                  className={closeBehavior === 'tray' ? 'on' : ''}
                  onClick={() => chooseClose('tray')}
                >
                  最小化到托盘
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={closeBehavior === 'quit'}
                  className={closeBehavior === 'quit' ? 'on' : ''}
                  onClick={() => chooseClose('quit')}
                >
                  直接退出
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="settings-group">
        <div className="settings-group-title">Git 身份（一次验证，全平台项目通用）</div>
        <div className="settings-list">
          <div className="settings-row settings-row--static" style={{ alignItems: 'flex-start' }}>
            <span>
              <strong>平台身份</strong>
              <em>粘贴一次访问令牌并验证，之后所有项目推送同一平台自动复用，无需每个项目再填。令牌仅存本机。</em>
            </span>
            <div className="seg" role="radiogroup" aria-label="Git 平台">
              <button type="button" role="radio" aria-checked={gitProvider === 'github'} className={gitProvider === 'github' ? 'on' : ''} onClick={() => { setGitProvider('github'); setGitNote(''); }}>GitHub</button>
              <button type="button" role="radio" aria-checked={gitProvider === 'gitee'} className={gitProvider === 'gitee' ? 'on' : ''} onClick={() => { setGitProvider('gitee'); setGitNote(''); }}>Gitee</button>
            </div>
          </div>
          <div className="settings-row settings-row--static" style={{ gap: 8 }}>
            <input
              type="password"
              value={gitToken}
              onChange={(e) => setGitToken(e.target.value)}
              placeholder={gitProvider === 'github' ? 'GitHub 令牌（repo 权限，ghp_/github_pat_ 或 40 位）' : 'Gitee 私人令牌'}
              style={{ flex: '1 1 320px' }}
            />
            <button type="button" className="primary-btn" disabled={gitBusy || !gitToken.trim()} onClick={() => void saveGit()}>验证并保存</button>
          </div>
          {accounts.map((acc) => (
            <div key={acc.provider} className="settings-row settings-row--static">
              <span>
                <strong>{acc.provider === 'github' ? 'GitHub' : 'Gitee'}：{acc.verified ? `已连接 ${acc.username || ''}` : '已保存（未在线验证）'}</strong>
                <em>{acc.verified ? `验证于 ${acc.verifiedAt ?? ''}` : (acc.note ? `原因：${acc.note}` : '尚未验证')}</em>
              </span>
              <button type="button" className="ghost-btn" disabled={gitBusy} onClick={() => void clearGit(acc.provider)}>清除</button>
            </div>
          ))}
          {gitNote && <p className="hint" role="status">{gitNote}</p>}
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group-title">前往</div>
        <div className="settings-list">
          <button type="button" className="settings-row" onClick={() => onNavigate('notifications')}>
            <span><strong>通知与远程</strong><em>飞书 / 企业微信 / 微信 / QQ / Webhook</em></span><span aria-hidden="true">›</span>
          </button>
          <button type="button" className="settings-row" onClick={() => onNavigate('providers')}>
            <span><strong>供应商</strong><em>Codex / WorkBuddy / API Key / Ollama</em></span><span aria-hidden="true">›</span>
          </button>
          <button type="button" className="settings-row" onClick={() => onNavigate('agents')}>
            <span><strong>Agent</strong><em>DSH / Codex / Claude Code 与模型绑定</em></span><span aria-hidden="true">›</span>
          </button>
          <button type="button" className="settings-row" onClick={() => onNavigate('platform')}>
            <span><strong>平台状态</strong><em>网关与额度</em></span><span aria-hidden="true">›</span>
          </button>
        </div>
      </div>

      <div className="settings-about">
        <strong>大铭 Daming</strong>
        <span>本机优先 · 单一 Engine 写入 · 本机用户 {session.identity?.username ?? 'local'}</span>
      </div>
    </section>
  );
}
