'use strict';
// Daming desktop shell entry (Electron main process).
//
// Responsibility split (S12.1): Electron owns ONLY the window and the supervised Host process
// lifecycle. The managed Host is the single writer of task/approval/cost/audit state. This file
// never touches the task store, ledger or engine.
//
// Window behaviour: closing the window does NOT quit. It hides to the system tray (WeChat-style)
// so the managed Host keeps running in the background. A real quit only happens from the tray
// menu "退出大铭", the OS quit path, or when the Host dies unexpectedly.
const { app, BrowserWindow, dialog, shell, session, Tray, Menu, nativeImage, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join, resolve, isAbsolute } = require('node:path');
const { randomBytes } = require('node:crypto');

const APP_DIR = 'Daming';
const HOST_READY_PREFIX = 'DAMING_HOST_READY ';
const DEFAULT_PORT = 3210;
// Desktop is a single-machine, single fixed-user product: one OS account = one board owner,
// auto-signed-in, with no administrator setup or login screen.
const SINGLE_USER = true;

// Process-wide UI state. `isQuitting` is the single source of truth: while false, a window close
// request is turned into "hide to tray"; only a real quit flips it true and lets the window die.
let mainWindow = null;
let tray = null;
let isQuitting = false;
// "以后都不提醒": persisted in desktop-settings.json so it survives restarts.
let trayTipDismissed = false;
let trayTipPrompting = false;
// Close-button behaviour: 'tray' = hide to the system tray (WeChat-style), 'quit' = exit the app.
let closeBehavior = 'tray';

function dataDir() {
  const base = process.env.LOCALAPPDATA || join(process.env.USERPROFILE || '.', 'AppData', 'Local');
  return resolve(join(base, APP_DIR));
}

function readSettings(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function writeSettings(file, settings) {
  try { writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 }); }
  catch { /* best effort: a read-only profile still runs with defaults */ }
}

function resolveHostLaunch() {
  const packaged = app.isPackaged;
  const resources = process.resourcesPath;
  const repoRoot = resolve(__dirname, '..', '..', '..');
  const hostEntry = packaged
    ? join(resources, 'host', 'host.mjs')
    : join(repoRoot, 'apps', 'desktop', 'host', 'main.mjs');
  // Packaged builds ship a Node 24 runtime so node:sqlite is always available; dev uses system node.
  const bundledNode = join(resources, 'host', process.platform === 'win32' ? 'node.exe' : 'node');
  const nodeExecutable = packaged && existsSync(bundledNode) ? bundledNode : (process.env.DAMING_NODE || 'node');
  const webRoot = packaged
    ? join(resources, 'host', 'web')
    : join(repoRoot, 'apps', 'web', 'dist');
  if (!isAbsolute(nodeExecutable) && !/^[a-zA-Z]:[\\/]/.test(nodeExecutable)) {
    // 'node' resolves through PATH; that is fine for development only.
  }
  return { nodeExecutable, hostEntry, webRoot };
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, shell: false });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch { /* already gone */ }
}

// If a previous run crashed and left a lock whose owner process is dead, clear it so the app can
// restart. A live owner is never touched (the Host lock stays fail-closed).
function clearStaleLock(lockFile) {
  try {
    if (!existsSync(lockFile)) return;
    const raw = JSON.parse(readFileSync(lockFile, 'utf8'));
    const pid = raw && Number.isInteger(raw.pid) ? raw.pid : 0;
    if (pid > 0) {
      try { process.kill(pid, 0); return; } // owner alive
      catch { /* dead: fall through and remove */ }
    }
    require('node:fs').unlinkSync(lockFile);
  } catch { /* unreadable/held: leave it */ }
}

class ManagedHost {
  constructor(opts) { this.opts = opts; this.child = null; this.url = ''; this.pid = 0; this.stopping = false; this.exitPromise = Promise.resolve(); this._resolveExit = null; }
  start() {
    return new Promise((resolveStart, rejectStart) => {
      const { nodeExecutable, hostEntry, webRoot } = this.opts.launch;
      const args = [hostEntry, '--data-dir', this.opts.dataDir, '--port', String(this.opts.port), '--web-root', webRoot];
      if (SINGLE_USER) args.push('--single-user');
      if (this.opts.token) args.push('--token', this.opts.token);
      const env = {};
      for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'PATH', 'PATHEXT', 'ComSpec', 'NODE_EXTRA_CA_CERTS', 'DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY_FILE']) {
        if (process.env[key]) env[key] = process.env[key];
      }
      let settled = false;
      const child = spawn(nodeExecutable, args, { cwd: this.opts.dataDir, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      this.pid = child.pid || 0;
      this.exitPromise = new Promise((res) => { this._resolveExit = res; });
      let buffer = '';
      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith(HOST_READY_PREFIX)) {
            try {
              const info = JSON.parse(line.slice(HOST_READY_PREFIX.length));
              if (info && typeof info.url === 'string') {
                this.url = info.url;
                if (!settled) { settled = true; resolveStart(this.url); }
              }
            } catch { /* ignore malformed line */ }
          }
        }
      });
      child.stderr.on('data', (chunk) => process.stderr.write('[host] ' + chunk.toString()));
      child.once('error', (error) => { if (!settled) { settled = true; rejectStart(error); } });
      child.once('exit', (code, signal) => {
        this.child = null;
        if (this._resolveExit) { this._resolveExit(); this._resolveExit = null; }
        if (this.stopping) return;
        if (!settled) { settled = true; rejectStart(new Error('host_exited_' + (code || signal))); return; }
        dialog.showErrorBox('Daming Host 已停止', '受管 Host 进程意外退出（code=' + code + '）。请重新启动 Daming。');
        quitApp();
      });
    });
  }
  async stop() {
    this.stopping = true;
    const child = this.child;
    if (!child) { this.pid = 0; return; }
    // Ask the Host to close gracefully so it releases its exclusive directory lock.
    try { child.stdin.write('shutdown\n'); child.stdin.end(); } catch { /* pipe gone */ }
    const timedOut = await Promise.race([
      this.exitPromise.then(() => false),
      new Promise((res) => setTimeout(() => res(true), 5000)),
    ]);
    if (timedOut && this.pid) killTree(this.pid);
    this.child = null;
    this.pid = 0;
  }
}

// ---- Tray + window lifecycle -------------------------------------------------------------

// The native caption buttons must match the page theme, otherwise night mode
// shows a bright white button cluster on a dark title bar. These are the same
// canvas/ink tokens the web side uses (styles.css / theme.css --canvas/--ink).
const CAPTION_THEMES = {
  day: { color: '#f7f6f2', symbolColor: '#1a1916' },
  night: { color: '#131317', symbolColor: '#eceae4' }
};

function applyCaptionTheme(theme) {
  const palette = CAPTION_THEMES[theme] || CAPTION_THEMES.day;
  const windows = [mainWindow, ...BrowserWindow.getAllWindows()].filter(
    (win) => win && !win.isDestroyed()
  );
  for (const win of windows) {
    try {
      if (process.platform === 'darwin') {
        win.setBackgroundColor(palette.color);
      } else {
        win.setTitleBarOverlay({ ...palette, height: 56 });
        win.setBackgroundColor(palette.color);
      }
    } catch {
      // A window can be torn down mid-switch; the next one still applies.
    }
  }
  return palette;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

function hideToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();
}

// First time the user clicks the window close (X), explain that closing hides to
// the tray instead of quitting, and offer a "以后都不提醒" checkbox. Once ticked we
// persist it and never show the reminder again, including after a restart.
function trayTipSettingsPath() {
  return join(dataDir(), 'desktop-settings.json');
}
function saveTrayTipDismissed() {
  try {
    const file = trayTipSettingsPath();
    const settings = readSettings(file);
    settings.trayTipDismissed = true;
    writeSettings(file, settings);
  } catch { /* best effort */ }
}
function saveCloseBehavior() {
  try {
    const file = trayTipSettingsPath();
    const settings = readSettings(file);
    settings.closeBehavior = closeBehavior;
    writeSettings(file, settings);
  } catch { /* best effort */ }
}
async function promptTrayTipOnce() {
  if (trayTipDismissed || trayTipPrompting) return;
  trayTipPrompting = true;
  try {
    const result = await dialog.showMessageBox(mainWindow ?? undefined, {
      type: 'info',
      title: '大铭仍在后台运行',
      message: '大铭已最小化到系统托盘',
      detail: '关闭窗口不会退出大铭，任务板仍会在后台继续运行。需要时点击托盘图标即可恢复。',
      buttons: ['知道了'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      checkboxLabel: '以后都不提醒',
      checkboxChecked: false,
    });
    if (result.checkboxChecked) {
      trayTipDismissed = true;
      saveTrayTipDismissed();
    }
  } catch { /* notifications/dialogs may be suppressed; behaviour is unchanged */ }
  finally { trayTipPrompting = false; }
}

function toggleWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isVisible() && !mainWindow.isMinimized()) hideToTray();
  else showMainWindow();
}

function loadTrayImage(size) {
  const file = join(__dirname, 'assets', 'tray-' + size + '.png');
  try {
    const image = nativeImage.createFromPath(file);
    return image.isEmpty() ? undefined : image;
  } catch { return undefined; }
}

function createTray(win) {
  if (tray) return tray;
  // Use a crisp 32/48px asset (Windows downsamples cleanly and renders the
  // rounded corners smoothly; a 16px source upscaled to the 24/28px notification
  // cell looks blocky and square). Fall back progressively.
  const image = loadTrayImage(32) || loadTrayImage(48) || loadTrayImage(64) || loadTrayImage(16) || loadTrayImage(256);
  if (!image) return null; // no icon -> stay fail-safe and let the close fall through to quit
  try {
    tray = new Tray(image);
  } catch {
    tray = null;
    return null;
  }
  tray.setToolTip('大铭任务板');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开主界面', click: () => showMainWindow() },
    { label: '隐藏到托盘', click: () => hideToTray() },
    { type: 'separator' },
    { label: '退出大铭', click: () => quitApp() },
  ]));
  tray.on('click', () => toggleWindow());
  tray.on('double-click', () => showMainWindow());
  return tray;
}

function quitApp() {
  isQuitting = true;
  app.quit();
}

function menuSend(action, payload) {
  const target = BrowserWindow.getFocusedWindow() || mainWindow;
  if (target && !target.isDestroyed()) target.webContents.send('daming:menu', { action, ...(payload ?? {}) });
}

function createExtraWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const child = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: '#f6f5f1',
    title: 'Daming',
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 16, y: 18 } }
      : { titleBarOverlay: { color: '#f6f5f1', symbolColor: '#1a1916', height: 56 } }),
    icon: loadTrayImage(256),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, 'preload.cjs'),
    },
  });
  const url = mainWindow.webContents.getURL();
  if (url) void child.loadURL(url);
  child.webContents.setWindowOpenHandler(({ url: openUrl }) => { void shell.openExternal(openUrl); return { action: 'deny' }; });
}

function installApplicationMenu() {
  const navigate = (page) => () => menuSend('navigate', { page });
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '新建窗口', accelerator: 'CmdOrCtrl+N', click: () => createExtraWindow() },
        { label: '新聊天', accelerator: 'CmdOrCtrl+T', click: navigate('crew') },
        { label: '新项目', accelerator: 'CmdOrCtrl+Shift+N', click: navigate('projects') },
        { label: '打开文件夹…', accelerator: 'CmdOrCtrl+O', click: () => menuSend('open-folder') },
        { type: 'separator' },
        { label: '关闭窗口', accelerator: 'CmdOrCtrl+W', click: () => { const win = BrowserWindow.getFocusedWindow(); if (win) win.close(); } },
        { label: '退出大铭', accelerator: 'CmdOrCtrl+Q', click: () => quitApp() },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' },
        { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '总览', accelerator: 'CmdOrCtrl+1', click: navigate('overview') },
        { label: '任务', accelerator: 'CmdOrCtrl+2', click: navigate('tasks') },
        { label: '项目', accelerator: 'CmdOrCtrl+3', click: navigate('projects') },
        { label: '供应商', accelerator: 'CmdOrCtrl+4', click: navigate('providers') },
        { label: 'Agent', accelerator: 'CmdOrCtrl+5', click: navigate('agents') },
        { label: '编队', accelerator: 'CmdOrCtrl+6', click: navigate('crew') },
        { label: '通知', accelerator: 'CmdOrCtrl+7', click: navigate('notifications') },
        { label: '平台状态', accelerator: 'CmdOrCtrl+8', click: navigate('platform') },
        { type: 'separator' },
        { role: 'reload', label: '重新加载' }, { role: 'toggleDevTools', label: '开发者工具' },
        { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' }, { role: 'zoom', label: '缩放' },
        { label: '全部窗口', click: () => { for (const win of BrowserWindow.getAllWindows()) win.show(); } },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '帮助与快捷键', click: navigate('help') },
        { label: '设置', click: navigate('settings') },
        { type: 'separator' },
        { label: '关于大铭', click: () => { void dialog.showMessageBox(mainWindow ?? undefined, { type: 'info', title: '关于大铭', message: '大铭 Daming', detail: '本机优先的多 Agent 协作与治理平台\nElectron ' + process.versions.electron + ' · Node ' + process.versions.node }); } },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.setAppUserModelId('com.daming.desktop');

  app.on('second-instance', () => {
    // A second launch must reveal the window even when the first one is hidden in the tray.
    showMainWindow();
  });

  app.whenReady().then(async () => {
    // Native directory picker for the project intake page (renderer has no filesystem access).
    ipcMain.handle('daming:choose-directory', async (_event, options) => {
      const create = !!(options && options.create);
      const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
        title: create ? '选择或新建项目目录' : '选择项目目录',
        properties: create ? ['openDirectory', 'createDirectory'] : ['openDirectory'],
      });
      return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
    });
    // The caption buttons are native. Tell the page how wide they are so its top
    // bar reserves that corner instead of drawing under the buttons, and let the
    // page tell us which theme is showing so the buttons repaint to match.
    ipcMain.handle('daming:caption-inset', () => {
      if (process.platform === 'darwin') return { width: 0, height: 0, side: 'left' };
      if (!mainWindow || mainWindow.isDestroyed()) return { width: 138, height: 56, side: 'right' };
      if (mainWindow.isFullScreen()) return { width: 0, height: 0, side: 'right' };
      try {
        const { width, height } = mainWindow.getTitleBarOverlay();
        return {
          width: Number.isFinite(width) ? width : 138,
          height: Number.isFinite(height) ? height : 56,
          side: 'right'
        };
      } catch {
        return { width: 138, height: 56, side: 'right' };
      }
    });
    ipcMain.handle('daming:set-theme', (_event, theme) => {
      if (theme !== 'day' && theme !== 'night') return { ok: false, reason: 'unknown_theme' };
      const palette = applyCaptionTheme(theme);
      return { ok: true, ...palette };
    });
    ipcMain.handle('daming:get-close-behavior', () => ({ behavior: closeBehavior }));
    ipcMain.handle('daming:set-close-behavior', (_event, value) => {
      closeBehavior = value === 'quit' ? 'quit' : 'tray';
      saveCloseBehavior();
      return { ok: true, behavior: closeBehavior };
    });
    const dir = dataDir();
    mkdirSync(dir, { recursive: true });
    clearStaleLock(join(dir, '.daming-host-owner.lock'));
    const settingsFile = join(dir, 'desktop-settings.json');    const settings = readSettings(settingsFile);
    trayTipDismissed = settings.trayTipDismissed === true;
    closeBehavior = settings.closeBehavior === 'quit' ? 'quit' : 'tray';
    const port = Number.isSafeInteger(settings.hostPort) ? settings.hostPort : DEFAULT_PORT;
    const token = randomBytes(24).toString('base64url');

    const win = new BrowserWindow({
      width: 1280,
      height: 860,
      useContentSize: true,
      show: false,      backgroundColor: '#f6f5f1',
      title: 'Daming',
      titleBarStyle: 'hidden',
      // On Windows/Linux the caption buttons are drawn by the shell. The DOM
      // reports their exact box over IPC (preload -> window-shell), and the web
      // top bar reserves it, so the buttons never sit on unrelated UI. On macOS
      // the native traffic lights keep their own 78px strip instead.
      ...(process.platform === 'darwin'
        ? { trafficLightPosition: { x: 16, y: 18 } }
        : { titleBarOverlay: { color: '#f6f5f1', symbolColor: '#1a1916', height: 56 } }),
      icon: loadTrayImage(256),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: join(__dirname, 'preload.cjs'),
      },
    });
    mainWindow = win;
    // Open maximized so the app fills the screen edge-to-edge (like dsh / Magpie),
    // with the shell-drawn caption buttons overlaid by titleBarOverlay — no OS frame/border.
    win.once('ready-to-show', () => { win.maximize(); win.show(); });

    // Close-button behaviour is a user setting: hide to tray (default, WeChat-style) or quit.
    win.on('close', (event) => {
      if (isQuitting) return; // a real quit is allowed to destroy the window
      if (closeBehavior === 'quit') {
        event.preventDefault();
        quitApp();
        return;
      }
      if (tray) {
        event.preventDefault();
        // Show the one-time tray reminder first (if not dismissed), then hide.
        void promptTrayTipOnce().finally(() => hideToTray());
      }
      // If tray is unavailable (icon failed to load), fall through and quit normally below.
    });
    win.on('closed', () => { mainWindow = null; });

    win.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: 'deny' }; });
    win.webContents.on('did-fail-load', (_event, code, description, failedUrl) => {
      process.stderr.write('[window] did-fail-load ' + code + ' ' + description + ' ' + failedUrl + '\n');
    });
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      '<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;background:#f6f5f1;color:#1a1916;display:grid;place-items:center;height:100vh;margin:0"><p>Daming 正在启动受管 Host…</p></body>'
    ));

    createTray(win);
    installApplicationMenu();
    // 隐藏原生白色菜单栏（深色标题栏统一配色）；快捷键仍由 Menu 生效，Alt 可临时唤出。
    win.setAutoHideMenuBar(true);
    win.setMenuBarVisibility(false);

    const launch = resolveHostLaunch();
    const host = new ManagedHost({ launch, dataDir: dir, port, token });
    app._damingHost = host;

    try {
      const baseUrl = await host.start();
      // First run (or after reinstall with retained history): bootstrap once with the token.
      let initialized = false;
      try {
        const status = await fetch(new URL('/api/identity/status', baseUrl), { redirect: 'error' });
        if (status.ok) initialized = (await status.json()).initialized === true;
      } catch { /* fall back to token bootstrap */ }
      // baseUrl carries a trailing slash; build the bootstrap URL with URL() so we never emit a
      // double-slash path (which the Host rejects) on first run. In single-user mode every launch
      // exchanges the per-launch token for the fixed local owner's session (no login screen).
      const target = SINGLE_USER || !initialized
        ? new URL('/?token=' + encodeURIComponent(token), baseUrl).toString()
        : baseUrl;
      await win.loadURL(target);
    } catch (error) {
      dialog.showErrorBox('Daming 启动失败', String(error && error.message ? error.message : error));
      quitApp();
    }
  });

  app.on('window-all-closed', () => {
    // With a tray icon the window is hidden, not destroyed, so this rarely fires. If it does and
    // there is no tray to bring the app back, quit rather than leaving an invisible process.
    if (!tray) void shutdown();
  });

  let quitting = false;
  async function shutdown() {
    if (quitting) return;
    quitting = true;
    isQuitting = true;
    if (app._damingHost) await app._damingHost.stop();
    app.quit();
  }
  app.on('before-quit', (event) => {
    // Any quit path marks the process as really quitting so the close handler stops intercepting.
    isQuitting = true;
    if (app._damingHost && app._damingHost.child) {
      event.preventDefault();
      void shutdown();
    }
  });
}
