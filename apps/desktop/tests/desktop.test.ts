import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_DESKTOP_SETTINGS,
  DESKTOP_INSTALLER,
  HOST_READY_PREFIX,
  HostSupervisor,
  MAGPIE_SILENT_INSTALL_ALLOWED,
  SilentMagpieInstallError,
  assertInstallerConfig,
  assertUserInitiatedMagpie,
  buildBootstrapUrl,
  buildHostSpawnPlan,
  buildProcessTreeKill,
  decideMagpieStart,
  mergeSettings,
  parseHostOutputLine,
  planUpgrade,
  renderElectronBuilderYml,
  resolveDesktopPaths,
  validateInstallerConfig,
} from '../src/index.ts';
import type { HostChild, HostSpawnPlan, SupervisorDeps } from '../src/index.ts';

const WINDIR = 'C:\\Users\\tester\\AppData\\Local';

test('desktop paths resolve per-user data roots on each platform', () => {
  const win = resolveDesktopPaths({ platform: 'win32', env: { LOCALAPPDATA: WINDIR, USERPROFILE: 'C:\\Users\\tester' } });
  assert.equal(win.dataDir.toLowerCase().endsWith('\\daming'), true);
  assert.equal(win.settingsFile, win.dataDir + '\\desktop-settings.json');
  assert.equal(win.historyDir, win.dataDir + '\\history');
  const mac = resolveDesktopPaths({ platform: 'darwin', env: { HOME: '/Users/tester' } });
  assert.equal(mac.dataDir.replaceAll('\\', '/').endsWith('/Library/Application Support/Daming'), true);
  const linux = resolveDesktopPaths({ platform: 'linux', env: { XDG_DATA_HOME: '/home/tester/.data' } });
  assert.equal(linux.dataDir.replaceAll('\\', '/').endsWith('/home/tester/.data/Daming'), true);
});

test('settings merge preserves unknown keys and rejects bad primitives', () => {
  const merged = mergeSettings({ hostPort: 3999, startMagpie: true, schemaVersion: 2, keepMe: { a: 1 }, hostPort2: 5 });
  assert.equal(merged.hostPort, 3999);
  assert.equal(merged.startMagpie, true);
  assert.equal(merged.schemaVersion, 2);
  assert.deepEqual(merged.extra, { keepMe: { a: 1 }, hostPort2: 5 });
  const fallback = mergeSettings({ hostPort: 'x', startMagpie: 'yes' });
  assert.equal(fallback.hostPort, DEFAULT_DESKTOP_SETTINGS.hostPort);
  assert.equal(fallback.startMagpie, false);
});

test('magpie is off by default and settings keep it off across upgrade', () => {
  const paths = resolveDesktopPaths({ platform: 'win32', env: { LOCALAPPDATA: WINDIR } });
  const plan = planUpgrade({ fromVersion: '1.0.0', toVersion: '1.1.0', settings: {}, paths, cacheDirs: ['C:\\cache\\v1'] });
  assert.equal(plan.settings.startMagpie, false);
  assert.equal(plan.firstRun, true);
  assert.equal(plan.settings.firstRunVersion, '1.1.0');
});

test('upgrade preserves history/settings and only clears disposable cache on version change', () => {
  const paths = resolveDesktopPaths({ platform: 'win32', env: { LOCALAPPDATA: WINDIR } });
  const sameVersion = planUpgrade({ fromVersion: '1.0.0', toVersion: '1.0.0', settings: { firstRunVersion: '1.0.0' }, paths, cacheDirs: ['C:\\cache\\v1'] });
  assert.deepEqual(sameVersion.remove, []);
  assert.equal(sameVersion.versionChanged, false);
  assert.ok(sameVersion.preserve.includes(paths.historyDir));
  const changed = planUpgrade({ fromVersion: '1.0.0', toVersion: '1.1.0', settings: { firstRunVersion: '1.0.0' }, paths, cacheDirs: ['C:\\cache\\v1'] });
  assert.deepEqual(changed.remove, ['C:\\cache\\v1']);
  assert.ok(changed.preserve.includes(paths.historyDir));
  assert.equal(changed.firstRun, false);
});

test('host spawn plan is an argument array with shell disabled and a filtered env', () => {
  const plan = buildHostSpawnPlan({
    nodeExecutable: 'C:\\node\\node.exe',
    hostEntry: 'C:\\app\\host\\main.mjs',
    dataDir: 'C:\\Users\\tester\\AppData\\Local\\Daming',
    port: 3211,
    webRoot: 'C:\\app\\host\\web',
    sourceEnv: { PATH: 'C:\\Windows', LOCALAPPDATA: WINDIR, DAMING_SECRET: 'leak', AWS_SECRET_ACCESS_KEY: 'leak' },
    extraEnv: { DAMING_GATEWAY_PORT: '3460' },
  });
  assert.equal(plan.shell, false);
  assert.equal(plan.windowsHide, true);
  assert.deepEqual(plan.args, ['C:\\app\\host\\main.mjs', '--data-dir', 'C:\\Users\\tester\\AppData\\Local\\Daming', '--port', '3211', '--web-root', 'C:\\app\\host\\web']);
  assert.equal(plan.env.PATH, 'C:\\Windows');
  assert.equal(plan.env.DAMING_SECRET, undefined);
  assert.equal(plan.env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(plan.env.DAMING_GATEWAY_PORT, '3460');
  assert.throws(() => buildHostSpawnPlan({ nodeExecutable: 'node', hostEntry: 'C:\\h', dataDir: 'C:\\d', port: 3210, webRoot: 'C:\\w' }), /absolute/);
  assert.throws(() => buildHostSpawnPlan({ nodeExecutable: 'C:\\node.exe', hostEntry: 'C:\\h', dataDir: 'C:\\d', port: 70000, webRoot: 'C:\\w' }), /port/);
});

test('ready handshake only accepts loopback http urls', () => {
  const ready = parseHostOutputLine(HOST_READY_PREFIX + JSON.stringify({ url: 'http://127.0.0.1:3210' }));
  assert.deepEqual(ready, { kind: 'ready', url: 'http://127.0.0.1:3210' });
  const localhost = parseHostOutputLine(HOST_READY_PREFIX + JSON.stringify({ url: 'http://localhost:3210' }));
  assert.equal(localhost.kind, 'ready');
  const evil = parseHostOutputLine(HOST_READY_PREFIX + JSON.stringify({ url: 'https://evil.example.com/' }));
  assert.equal(evil.kind, 'log');
  const compat = parseHostOutputLine('First-time bootstrap URL: http://127.0.0.1:3210/?token=abc');
  assert.equal(compat.kind, 'ready');
});

test('first-run bootstrap URL never produces a double-slash path', () => {
  assert.equal(buildBootstrapUrl('http://127.0.0.1:3210/', 'abc123', false), 'http://127.0.0.1:3210/?token=abc123');
  assert.equal(buildBootstrapUrl('http://127.0.0.1:3210', 'abc123', false), 'http://127.0.0.1:3210/?token=abc123');
  assert.equal(buildBootstrapUrl('http://127.0.0.1:3210/', 'a b', false), 'http://127.0.0.1:3210/?token=a%20b');
  assert.equal(buildBootstrapUrl('http://127.0.0.1:3210/', 'abc123', true), 'http://127.0.0.1:3210/');
});

test('process tree kill uses taskkill on Windows and an argument array elsewhere', () => {
  assert.deepEqual(buildProcessTreeKill(4242, 'win32'), { command: 'taskkill', args: ['/pid', '4242', '/T', '/F'] });
  assert.deepEqual(buildProcessTreeKill(4242, 'linux'), { command: 'kill', args: ['-TERM', '4242'] });
  assert.throws(() => buildProcessTreeKill(0, 'win32'), /positive integer/);
});

function fakeChild(): { child: HostChild; emitData: (text: string) => void; emitExit: (code: number | null) => void; emitError: () => void } {
  const dataCbs: Array<(chunk: Buffer | string) => void> = [];
  const exitCbs: Array<(code: number | null, signal: string | null) => void> = [];
  const errorCbs: Array<(error: Error) => void> = [];
  const child: HostChild = {
    pid: 9001,
    stdout: { on: (_event, cb) => { dataCbs.push(cb); } },
    stderr: { on: () => undefined },
    once: (event, cb) => {
      if (event === 'exit') exitCbs.push(cb as (code: number | null, signal: string | null) => void);
      else errorCbs.push(cb as (error: Error) => void);
    },
  };
  return {
    child,
    emitData: (text) => { for (const cb of dataCbs) cb(Buffer.from(text)); },
    emitExit: (code) => { for (const cb of exitCbs) cb(code, null); },
    emitError: () => { for (const cb of errorCbs) cb(new Error('boom')); },
  };
}

function supervisorHarness() {
  const spawned: HostSpawnPlan[] = [];
  const killed: number[] = [];
  let last: ReturnType<typeof fakeChild> | undefined;
  const deps: SupervisorDeps = {
    spawn: (plan) => { spawned.push(plan); last = fakeChild(); return last.child; },
    killTree: (pid) => { killed.push(pid); },
  };
  return { deps, spawned, killed, get last() { if (!last) throw new Error('not spawned'); return last; } };
}

const plan = buildHostSpawnPlan({ nodeExecutable: 'C:\\node.exe', hostEntry: 'C:\\h\\main.mjs', dataDir: 'C:\\d', port: 3210, webRoot: 'C:\\w' });

test('supervisor reaches ready on handshake and never double-spawns', () => {
  const h = supervisorHarness();
  const sup = new HostSupervisor(h.deps);
  assert.equal(sup.start(plan).state, 'starting');
  sup.start(plan); // no-op
  assert.equal(h.spawned.length, 1);
  h.last.emitData(HOST_READY_PREFIX + JSON.stringify({ url: 'http://127.0.0.1:3210' }) + '\n');
  const snap = sup.snapshot();
  assert.equal(snap.state, 'ready');
  assert.equal(snap.url, 'http://127.0.0.1:3210');
});

test('supervisor splits partial stdout lines and reports host exit as failure', () => {
  const exitHarness = supervisorHarness();
  const exitSup = new HostSupervisor(exitHarness.deps);
  exitSup.start(plan);
  exitHarness.last.emitExit(1);
  assert.equal(exitSup.snapshot().state, 'failed');
  assert.equal(exitSup.snapshot().reason, 'host_exited_1');

  const splitHarness = supervisorHarness();
  const splitSup = new HostSupervisor(splitHarness.deps);
  splitSup.start(plan);
  const line = HOST_READY_PREFIX + JSON.stringify({ url: 'http://127.0.0.1:3210' });
  splitHarness.last.emitData(line.slice(0, 10));
  assert.equal(splitSup.snapshot().state, 'starting');
  splitHarness.last.emitData(line.slice(10) + '\n');
  assert.equal(splitSup.snapshot().state, 'ready');
});

test('stop reaps the whole process tree exactly once', () => {
  const h = supervisorHarness();
  const sup = new HostSupervisor(h.deps);
  sup.start(plan);
  h.last.emitData(HOST_READY_PREFIX + JSON.stringify({ url: 'http://127.0.0.1:3210' }) + '\n');
  assert.equal(sup.stop().state, 'stopped');
  assert.deepEqual(h.killed, [9001]);
  sup.stop();
  assert.deepEqual(h.killed, [9001]);
});

test('optional Magpie never starts silently', () => {
  assert.equal(MAGPIE_SILENT_INSTALL_ALLOWED, false);
  assert.deepEqual(decideMagpieStart({ userEnabled: false, installed: true }), { start: false, reason: 'disabled_by_default' });
  assert.deepEqual(decideMagpieStart({ userEnabled: true, installed: false }), { start: false, reason: 'not_installed' });
  assert.deepEqual(decideMagpieStart({ userEnabled: true, installed: true }), { start: true, reason: 'user_enabled' });
  assert.throws(() => assertUserInitiatedMagpie({ userEnabled: false }), SilentMagpieInstallError);
  assert.doesNotThrow(() => assertUserInitiatedMagpie({ userEnabled: true }));
});

test('installer config honours S12 invariants', () => {
  assert.deepEqual(validateInstallerConfig(DESKTOP_INSTALLER), []);
  assert.doesNotThrow(() => assertInstallerConfig(DESKTOP_INSTALLER));
  const broken = {
    ...DESKTOP_INSTALLER,
    artifactName: 'Daming.exe',
    nsis: { ...DESKTOP_INSTALLER.nsis, deleteAppDataOnUninstall: true, oneClick: true },
    win: { target: [{ target: 'zip', arch: ['x64'] }], artifactName: 'Daming.exe' },
  };
  const issues = validateInstallerConfig(broken);
  assert.ok(issues.some((i) => i.includes('deleteAppDataOnUninstall')));
  assert.ok(issues.some((i) => i.includes('oneClick')));
  assert.ok(issues.some((i) => i.includes('nsis')));
});

test('desktop shell hides to the tray on close instead of quitting (WeChat-style)', () => {
  const mainPath = fileURLToPath(new URL('../electron/main.cjs', import.meta.url));
  const main = readFileSync(mainPath, 'utf8');
  // A real tray icon is created and its menu can restore or quit the app explicitly.
  assert.match(main, /new Tray\(/);
  assert.match(main, /label: '打开主界面'/);
  assert.match(main, /'退出大铭'/);
  // The window close button is intercepted and turned into "hide to tray", never a silent quit.
  assert.match(main, /win\.on\('close',/);
  assert.match(main, /event\.preventDefault\(\)/);
  assert.match(main, /hideToTray\(\)/);
  // window-all-closed must NOT unconditionally quit; it only falls back when there is no tray.
  assert.doesNotMatch(main, /window-all-closed', \(\) => \{ void shutdown\(\); \}/);
  assert.match(main, /if \(!tray\) void shutdown\(\)/);
  // Every size the shell references must ship beside main.cjs.
  for (const size of [16, 32, 64, 256]) {
    const icon = fileURLToPath(new URL('../electron/assets/tray-' + size + '.png', import.meta.url));
    assert.ok(readFileSync(icon).length > 0, 'missing tray-' + size + '.png');
  }
});

test('desktop is one fixed local user per machine and never shows an admin/login screen', () => {
  const mainPath = fileURLToPath(new URL('../electron/main.cjs', import.meta.url));
  const hostPath = fileURLToPath(new URL('../host/main.mjs', import.meta.url));
  const main = readFileSync(mainPath, 'utf8');
  const host = readFileSync(hostPath, 'utf8');
  // The shell always launches the Host in single-user mode and always exchanges the per-launch
  // token, so the fixed local owner is auto-signed-in on every start.
  assert.match(main, /const SINGLE_USER = true/);
  assert.match(main, /args\.push\('--single-user'\)/);
  assert.match(main, /SINGLE_USER \|\| !initialized/);
  assert.match(host, /--single-user/);
  assert.match(host, /singleUser: true/);
});

test('electron-builder.yml on disk matches the validated manifest', () => {
  const ymlPath = fileURLToPath(new URL('../electron-builder.yml', import.meta.url));
  const onDisk = readFileSync(ymlPath, 'utf8');
  assert.equal(onDisk, renderElectronBuilderYml(DESKTOP_INSTALLER));
});
