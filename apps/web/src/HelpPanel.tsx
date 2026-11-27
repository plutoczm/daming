export function HelpPanel() {
  return (
    <section className="page-stack help-page" aria-label="帮助">
      <header className="page-head"><div><h2>帮助</h2></div></header>
      <div className="help-grid">
        <article className="help-card">
          <h3>常用快捷键</h3>
          <div className="help-row"><span>搜索与跳转</span><kbd>Ctrl K</kbd></div>
          <div className="help-row"><span>新建窗口</span><kbd>Ctrl N</kbd></div>
          <div className="help-row"><span>新聊天（编队）</span><kbd>Ctrl T</kbd></div>
          <div className="help-row"><span>新项目</span><kbd>Ctrl Shift N</kbd></div>
          <div className="help-row"><span>打开文件夹</span><kbd>Ctrl O</kbd></div>
          <div className="help-row"><span>关闭窗口（隐藏到托盘）</span><kbd>Ctrl W</kbd></div>
        </article>
        <article className="help-card">
          <h3>三步开始</h3>
          <ol className="help-steps">
            <li>在「供应商」接入账号或 API Key。</li>
            <li>在「Agent」把 Agent 绑到供应商模型。</li>
            <li>在「编队」写目标，自动分派并派发。</li>
          </ol>
        </article>
        <article className="help-card">
          <h3>远程与通知</h3>
          <p>在「通知」连接飞书 / 企业微信 / 微信 / QQ，生成远程链接；手机打开链接即可审批。</p>
        </article>
      </div>
    </section>
  );
}
