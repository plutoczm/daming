/**
 * UI v4 acceptance: disposable Host + real Chromium over CDP.
 *
 * - identity mode (owner + MFA) so providers/agents/crew routes are reachable;
 *   the password/TOTP live only in this process and in a temp data dir.
 * - No provider, gateway or model calls: suppliers point at 127.0.0.1:1 and the
 *   crew plan is never dispatched to a real Agent.
 * - Crew dispatch receipts are seeded by writing the Host's own JSON store while
 *   the Host is stopped, so the page must rebuild the tree from persistence.
 *
 * Usage: node scripts/ui-v4-verify.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { startBoardHost } from '../apps/server/src/http.ts';
import { totpCode } from '../apps/server/src/totp.ts';
import { projectMagpieUnifiedTargets } from '../apps/server/src/magpie-unified-targets.ts';

for (const name of Object.keys(process.env)) {
  if (/^(DEEPSEEK_|DAMING_CODEX_|DAMING_DSH_|DAMING_LULU_|LULU_|DAMING_MAGPIE_)/.test(name)) delete process.env[name];
}

const chrome = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find(existsSync);
if (!chrome) throw new Error('Chromium browser missing');

const BOOT = 'ui-v4-bootstrap-2026';
const USER = 'ui-v4-owner';
const PASSWORD = 'ui-v4-owner-passphrase-2026';
const TENANT = 'UI v4 Tenant';
const SHOOT = '.cache/ui-v4';
mkdirSync(SHOOT, { recursive: true });

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function waitFor(fn, timeoutMs = 15000, label = 'condition') {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    try {
      const value = await fn();
      if (value) return value;
      last = value;
    } catch (cause) { last = cause?.message ?? cause; }
    await sleep(120);
  }
  throw new Error('timeout waiting for ' + label + (last ? ': ' + String(last) : ''));
}

const status = (value) => value.from ?? value.to ?? value.yes ?? value.detail ?? typeof value;

const magpieMock = {
  async ensure() { return { configured: false, running: false, enabled: false, version: 'fixture', checkedAt: new Date().toISOString() }; },
  async status() { return { configured: false, running: false, enabled: false, version: 'fixture', checkedAt: new Date().toISOString() }; },
  async unifiedTargets() {
    return projectMagpieUnifiedTargets({
      models: [
        { id: 'deepseek/deepseek-v4-pro', sub: false },
        { id: 'codex/gpt-6.1-sol', sub: true },
        { id: 'deepseek/deepseek-v4.1-flash', sub: false }
      ],
      groups: []
    });
  },
  async read(alias) { return { alias, count: 0, items: [], labels: [], checkedAt: new Date().toISOString() }; },
  async post() { throw new Error('ui_v4_test_disallows_external_writes'); },
  stop() {}
};

const result = {
  schema: 'daming.ui-redesign.v4',
  generatedAt: new Date().toISOString(),
  environment: { chrome, webRoot: 'apps/web/dist', dataDir: 'temporary', identityMode: true, mfa: true },
  checks: {},
  screenshots: [],
  console: { errors: [], warnings: [] },
  network: { badResponses: [] },
  notes: [
    '供应商指向 127.0.0.1:1（不可达），全程零真实模型/网关调用。',
    '编队派发回执在 Host 停止期间写入 host/crew-plans.json，用于验证页面从持久化恢复父子任务树。'
  ]
};

let host;
let child;
let ws;
let failure;

const dir = mkdtempSync(join(tmpdir(), 'daming-ui-v4-'));
let auth;
let mfaSecret = '';

async function call(path, method = 'GET', body, session = auth) {
  const base = host.url.replace(/\/$/, '');
  const url = base + (path.startsWith('/') ? path : '/' + path);
  const response = await fetch(url, {
    method,
    headers: {
      ...(session ? { cookie: session.cookie } : {}),
      ...(method !== 'GET' ? {
        origin: new URL(host.url).origin, 'content-type': 'application/json',
        ...(session ? { 'x-daming-csrf': session.csrf } : {})
      } : {})
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    redirect: 'manual'
  });
  let data = {};
  try { data = await response.json(); } catch { /* empty */ }
  return { status: response.status, data, cookie: response.headers.getSetCookie()[0]?.split(';')[0] ?? '' };
}

async function completeTask(taskId) {
  await waitFor(async () => {
    const detail = await call(`/api/tasks/${taskId}`);
    return detail.status === 200 && detail.data.status === 'completed';
  }, 20000, 'local task completion');
}

try {
  // ── 1. disposable Host with persistent identity ───────────────────────────
  host = await startBoardHost({
    dataDir: dir, port: 0, webRoot: resolve('apps/web/dist'), bootstrapToken: BOOT, magpie: magpieMock
  });
  const boot = await fetch(host.url + '?token=' + BOOT, { redirect: 'manual' });
  const legacyCookie = boot.headers.getSetCookie()[0].split(';')[0];
  const legacy = await call('api/session', 'GET', undefined, { cookie: legacyCookie, csrf: '' });
  const setup = await call('api/identity/setup', 'POST',
    { username: USER, password: PASSWORD, tenantName: TENANT },
    { cookie: legacyCookie, csrf: String(legacy.data.csrfToken) });
  if (setup.status !== 200) throw new Error('identity setup failed: ' + JSON.stringify(setup.data));
  auth = { cookie: setup.cookie, csrf: String(setup.data.csrfToken) };
  const mfa = await call('api/identity/mfa/begin', 'POST', { password: PASSWORD });
  if (mfa.status !== 200) throw new Error('mfa begin failed: ' + JSON.stringify(mfa.data));
  mfaSecret = String(mfa.data.secret);
  const confirm = await call('api/identity/mfa/confirm', 'POST',
    { code: totpCode(mfaSecret, Math.floor(Date.now() / 30000)) });
  if (confirm.status !== 200) throw new Error('mfa confirm failed: ' + JSON.stringify(confirm.data));
  result.checks.identityReady = true;

  // ── 2. seed real persisted records (no external calls) ────────────────────
  const provider = await call('api/platform/providers', 'POST', {
    id: 'ui-v4-demo', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', models: ['demo-model']
  });
  result.checks.providerSeeded = provider.status === 201;
  const agent = await call('api/platform/agents', 'POST', {
    agentId: 'ui-v4-researcher', name: '调研 Agent', runtime: 'dsh', providerId: 'ui-v4-demo', modelId: 'demo-model'
  });
  result.checks.agentProfileSeeded = agent.status === 201;

  const created = [];
  for (const [title, goal] of [
    ['多 Agent 编队：接口实现', '实现多 Agent 协作接口并完成自测。'],
    ['多 Agent 编队：测试复核', '为协作接口补齐测试与独立复核。']
  ]) {
    const task = await call('api/tasks', 'POST', { title, goal, mode: 'local', limitMinor: 200 });
    if (task.status !== 202 && task.status !== 201) throw new Error('task create failed: ' + JSON.stringify(task.data));
    const approved = await call(`/api/tasks/${task.data.taskId}/approve`, 'POST');
    if (approved.status !== 200) throw new Error('approve failed: ' + JSON.stringify(approved.data));
    created.push(task.data.taskId);
  }
  for (const taskId of created) await completeTask(taskId);
  result.checks.localTasksCompleted = created.length;
  // One task stays in "awaiting approval" so the graph can show a queued/pending path
  // (and the inbox is not empty) without running anything.
  const waiting = await call('api/tasks', 'POST', {
    title: '多 Agent 编队：等待审批的交付', goal: '等待人工审批后再执行的子目标。', mode: 'local', limitMinor: 200
  });
  result.checks.waitingTaskSeeded = waiting.status === 202 || waiting.status === 201;

  // Attributed model usage: a fixture task (fixture-dsh worker → dsh Harness) with a
  // task-scoped binding and one gateway row that carries X-Daming-Task-Id attribution.
  const fixtureTask = await call('api/tasks', 'POST', {
    title: '归属验收：fixture 执行图', goal: '验证按任务归属的模型用量', mode: 'fixture'
  });
  const fixtureTaskId = String(fixtureTask.data.taskId);
  await call(`/api/tasks/${fixtureTaskId}/approve`, 'POST');
  await completeTask(fixtureTaskId);
  const bind = await call('api/model-binding/bind', 'POST', {
    agent: 'dsh', modelId: 'deepseek/deepseek-v4-pro', scope: { kind: 'task', taskId: fixtureTaskId }
  });
  result.checks.attributionBinding = bind.status === 201;
  const attributedRow = await call('api/gateway/requests', 'POST', {
    requestId: 'ui-v4-attributed-' + fixtureTaskId, at: new Date().toISOString(), agent: 'dsh',
    providerId: 'deepseek', modelId: 'deepseek/deepseek-v4-pro', status: 'ok', latencyMs: 800,
    inputTokens: 1200, outputTokens: 80, costMinor: 5, maskedCount: 0, taskId: fixtureTaskId
  });
  result.checks.attributedRequest = attributedRow.status === 201 && attributedRow.data.attribution === 'task';
  const unattributedRow = await call('api/gateway/requests', 'POST', {
    requestId: 'ui-v4-unattributed', at: new Date().toISOString(), agent: 'dsh',
    providerId: 'deepseek', modelId: 'deepseek/deepseek-v4-pro', status: 'ok', latencyMs: 700,
    inputTokens: 999, outputTokens: 99, maskedCount: 0
  });
  result.checks.unattributedStaysUnattributed = unattributedRow.status === 201 && unattributedRow.data.attribution === 'unattributed';
  const attributedGraph = await call(`/api/tasks/${fixtureTaskId}/execution-graph`);
  const attributedNodes = attributedGraph.data.nodes ?? [];
  const modelUsageNode = attributedNodes.find((node) => node.kind === 'model' && node.tokens);
  result.checks.attributedTokens = modelUsageNode?.tokens ?? null;
  result.checks.attributedCoverage = attributedGraph.data.coverage?.usage ?? null;
  result.checks.attributedModelNode = !!modelUsageNode;
  // Two fixture-dsh steps share one model: per-step usage would be a guess, so the
  // total lives on the model node and the agent cards stay "未接入".
  result.checks.sharedModelStaysHonest = attributedNodes
    .filter((node) => node.kind === 'agent' && node.modelId === 'deepseek/deepseek-v4-pro')
    .every((node) => node.tokens === null);

  const plan = await call('api/crew/plan', 'POST', {
    title: '交付多 Agent 协作功能',
    goal: '完成需求梳理\n实现核心功能\n测试与复核交付',
    planner: 'main-agent'
  });
  if (plan.status !== 201) throw new Error('crew plan failed: ' + JSON.stringify(plan.data));
  const planId = plan.data.plan.planId;
  const assignments = plan.data.plan.assignments;
  result.checks.crewPlanReady = assignments.filter((item) => item.ready).length;

  // ── 3. seed dispatch receipts while the Host is stopped ───────────────────
  await host.close();
  host = undefined;
  const planFile = join(dir, 'host', 'crew-plans.json');
  const plans = JSON.parse(readFileSync(planFile, 'utf8'));
  const target = plans.find((item) => item.planId === planId);
  const at = new Date(Date.now() - 5 * 60_000).toISOString();
  target.dispatchedAt = at;
  target.dispatches = assignments.slice(0, created.length).map((assignment, index) => ({
    assignmentId: assignment.id, taskId: created[index], agent: assignment.agent,
    modelId: assignment.modelId, mode: assignment.mode, bound: true, at
  }));
  target.skipped = assignments.slice(created.length).map((assignment) => ({
    assignmentId: assignment.id, reason: 'needs_provider_model', at
  }));
  writeFileSync(planFile, JSON.stringify(plans, null, 2) + '\n');

  // ── 4. restart (identity now required) and sign in through the API ────────
  host = await startBoardHost({ dataDir: dir, port: 0, webRoot: resolve('apps/web/dist'), magpie: magpieMock });
  // The enrollment code belongs to an already-used TOTP window; wait for a fresh one
  // (replay protection rejects the same window twice).
  const currentWindow = Math.floor(Date.now() / 30000);
  let code = totpCode(mfaSecret, currentWindow);
  let login = await call('api/identity/login', 'POST',
    { username: USER, password: PASSWORD, mfaCode: code }, null);
  if (login.status !== 200) {
    await sleep(30000 - (Date.now() % 30000) + 900);
    code = totpCode(mfaSecret, Math.floor(Date.now() / 30000));
    login = await call('api/identity/login', 'POST',
      { username: USER, password: PASSWORD, mfaCode: code }, null);
  }
  if (login.status !== 200) throw new Error('identity login failed: ' + JSON.stringify(login.data));
  auth = { cookie: login.cookie, csrf: String(login.data.csrfToken) };
  result.checks.reloginAfterRestart = true;

  // ── 5. Chromium + CDP ─────────────────────────────────────────────────────
  const profileDir = join(dir, 'chrome-profile');
  child = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking',
    '--remote-debugging-port=0', '--remote-allow-origins=*',
    '--user-data-dir=' + profileDir, '--window-size=1440,900', 'about:blank'
  ], { windowsHide: true, stdio: 'ignore' });
  let browserPort;
  await waitFor(() => {
    const file = join(profileDir, 'DevToolsActivePort');
    if (!existsSync(file)) return false;
    const number = Number(readFileSync(file, 'utf8').split(/\r?\n/)[0]);
    if (!Number.isInteger(number) || number < 1024) return false;
    browserPort = number;
    return true;
  }, 20000, 'DevToolsActivePort');
  const pageTarget = await waitFor(async () => {
    const response = await fetch('http://127.0.0.1:' + browserPort + '/json/list');
    if (!response.ok) return false;
    const pages = await response.json();
    return pages.find((page) => page.type === 'page' && page.webSocketDebuggerUrl);
  }, 15000, 'page target');
  ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((done, reject) => {
    ws.addEventListener('open', done, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  const requestCounts = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (typeof message.id === 'number') {
      const pair = pending.get(message.id);
      if (!pair) return;
      pending.delete(message.id);
      if (message.error) pair.reject(new Error(message.error.message));
      else pair.resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      result.console.errors.push('exception: ' + (message.params.exceptionDetails?.text ?? 'unknown'));
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      result.console.errors.push('console.error: ' + (message.params.args ?? []).map((arg) => arg.value ?? arg.description ?? '').join(' ').slice(0, 300));
    }
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      const entry = message.params.entry;
      const text = entry.text ?? '';
      if (!/favicon/i.test(text) && !/favicon/i.test(entry.url ?? '')) result.console.errors.push('log: ' + text.slice(0, 300));
    }
    if (message.method === 'Network.responseReceived') {
      const response = message.params.response;
      if (response.status >= 400 && !/favicon/i.test(response.url)) {
        result.network.badResponses.push(response.status + ' ' + response.url.replace(String(host?.url ?? ''), '/'));
      }
    }
    if (message.method === 'Network.requestWillBeSent') {
      try {
        const url = new URL(message.params.request.url);
        if (url.origin !== new URL(host.url).origin) {
          if (!/^(chrome|devtools|data|about):/.test(url.protocol)) result.console.warnings.push('external request: ' + url.origin);
          return;
        }
        if (url.pathname.startsWith('/api/')) requestCounts.set(url.pathname, (requestCounts.get(url.pathname) ?? 0) + 1);
      } catch { /* internal */ }
    }
  });
  const cdp = (method, params = {}) => new Promise((resolveCall, rejectCall) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      rejectCall(new Error('CDP timeout: ' + method));
    }, 20000);
    pending.set(id, {
      resolve(value) { clearTimeout(timer); resolveCall(value); },
      reject(error) { clearTimeout(timer); rejectCall(error); }
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const response = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error('evaluation failed: ' + response.exceptionDetails.text);
    return response.result?.value;
  };
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Network.enable');
  await cdp('Log.enable');

  const [cookieName, ...cookieRest] = login.cookie.split('=');
  await cdp('Network.setCookie', {
    name: cookieName, value: cookieRest.join('='), url: host.url, httpOnly: true, sameSite: 'Lax'
  });
  await cdp('Page.navigate', { url: host.url });
  await waitFor(async () => await evaluate("!!document.querySelector('#main-content') && document.body.innerText.includes('大铭')"), 20000, 'app shell');
  await waitFor(async () => await evaluate("document.body.innerText.includes('实时同步')"), 12000, 'live SSE');

  const viewports = [
    { id: 'desktop', width: 1440, height: 900, mobile: false },
    { id: 'small-desktop', width: 1024, height: 768, mobile: false },
    { id: 'mobile', width: 390, height: 844, mobile: true }
  ];
  const setViewport = async (viewport) => {
    await cdp('Emulation.setDeviceMetricsOverride', {
      width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile
    });
  };
  const shoot = async (name) => {
    const shot = await cdp('Page.captureScreenshot', { format: 'png' });
    const path = `${SHOOT}/${name}.png`;
    writeFileSync(path, Buffer.from(shot.data, 'base64'));
    result.screenshots.push(path);
  };
  const goto = async (hash) => {
    await evaluate(`window.location.hash = ${JSON.stringify('#' + hash)}; true`);
    await sleep(700);
  };
  const overflow = async () => evaluate(
    'document.documentElement.scrollWidth - document.documentElement.clientWidth'
  );

  // ── 6. desktop pages ──────────────────────────────────────────────────────
  result.checks.landmarks = await evaluate(
    "document.querySelectorAll('main').length === 1 && !!document.querySelector('main#main-content') && !!document.querySelector('aside.app-rail nav')"
  );
  result.checks.skipLink = await evaluate("!!document.querySelector('a.skip-link[href=\"#main-content\"]')");
  await shoot('desktop-overview');

  await goto('tasks');
  await waitFor(async () => await evaluate("document.querySelectorAll('.board-card').length > 0"), 12000, 'board cards');
  await shoot('desktop-tasks');
  await evaluate(`(() => {
    const card = [...document.querySelectorAll('.board-card')].find((item) => item.textContent.includes('接口实现'))
      ?? document.querySelector('.board-card');
    card.focus();
    card.click();
    return true;
  })()`);
  await waitFor(async () => await evaluate("!!document.querySelector('.task-drawer .exec-graph')"), 15000, 'execution graph');
  await waitFor(async () => await evaluate("document.querySelectorAll('.exec-stage .exec-node').length >= 4"), 12000, 'graph nodes');
  result.checks.executionGraphNodes = await evaluate("document.querySelectorAll('.exec-stage .exec-node').length");
  result.checks.executionGraphStates = await evaluate(
    "JSON.stringify([...new Set([...document.querySelectorAll('.exec-stage .exec-node')].map(n => (n.className.match(/exec-node--state-(\\w+)/) || [])[1]))])"
  );
  result.checks.executionGraphCoverage = await evaluate(
    "document.querySelector('.exec-coverage')?.innerText.replace(/\\s+/g, ' ').trim()"
  );
  result.checks.executionGraphTimeline = await evaluate("document.querySelectorAll('.exec-event').length");
  result.checks.executionGraphHonestGaps = await evaluate(
    "document.querySelector('.exec-graph')?.innerText.includes('未接入')"
  );
  await evaluate("document.querySelector('.exec-graph').scrollIntoView({ block: 'start' }); true");
  await sleep(400);
  await shoot('desktop-execution-graph');
  // Focus management: Esc closes the dialog and focus returns to the card.
  result.checks.dialogFocus = await evaluate("document.activeElement?.classList.contains('drawer-close') || document.activeElement?.closest('.task-drawer') !== null");
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await waitFor(async () => await evaluate("!document.querySelector('.task-drawer')"), 6000, 'drawer closed by Esc');
  result.checks.escapeClosesDialog = true;
  result.checks.focusReturnedToBoard = await evaluate(
    "document.activeElement?.classList.contains('board-card') && !!document.activeElement?.closest('main#main-content')"
  );

  // A task that is still awaiting approval must read as queued/pending, not "done".
  await evaluate(`(() => {
    const card = [...document.querySelectorAll('.board-card')].find((item) => item.textContent.includes('等待审批'));
    if (!card) return false;
    card.focus();
    card.click();
    return true;
  })()`);
  await waitFor(async () => await evaluate("!!document.querySelector('.exec-graph')"), 12000, 'waiting graph');
  await waitFor(async () => await evaluate("document.querySelector('.exec-graph')?.innerText.includes('等待')"), 8000, 'pending nodes');
  result.checks.executionGraphWaitingStates = await evaluate(
    "JSON.stringify([...new Set([...document.querySelectorAll('.exec-stage .exec-node')].map(n => (n.className.match(/exec-node--state-(\\w+)/) || [])[1]))])"
  );
  await evaluate("document.querySelector('.exec-graph').scrollIntoView({ block: 'start' }); true");
  await sleep(400);
  await shoot('desktop-execution-graph-waiting');
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await waitFor(async () => await evaluate("!document.querySelector('.task-drawer')"), 6000, 'waiting drawer closed');

  // Attributed usage must be visible in the graph and must not leak from other tasks.
  await evaluate(`(() => {
    const card = [...document.querySelectorAll('.board-card')].find((item) => item.textContent.includes('归属验收'));
    if (!card) return false;
    card.focus();
    card.click();
    return true;
  })()`);
  await waitFor(async () => await evaluate("!!document.querySelector('.exec-node--model')"), 12000, 'model node');
  result.checks.browserAttributedCoverage = await evaluate(
    "document.querySelector('.exec-coverage')?.innerText.includes('模型请求 已持久化')"
  );
  result.checks.browserAttributedTokens = await evaluate(
    "[...document.querySelectorAll('.exec-stage .exec-node')].some((node) => node.innerText.includes('token 输入 1200'))"
  );
  result.checks.browserAttributionScope = await evaluate(
    "[...document.querySelectorAll('.exec-stage .exec-node')].some((node) => node.className.includes('exec-node--model') && node.innerText.includes('按任务归属合计'))"
  );
  result.checks.browserUnattributedExcluded = await evaluate(
    "[...document.querySelectorAll('.exec-stage .exec-node')].every((node) => !node.innerText.includes('999'))"
  );
  await evaluate("document.querySelector('.exec-graph').scrollIntoView({ block: 'start' }); true");
  await sleep(400);
  await shoot('desktop-execution-graph-attributed');
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await waitFor(async () => await evaluate("!document.querySelector('.task-drawer')"), 6000, 'attributed drawer closed');

  await goto('crew');
  await waitFor(async () => await evaluate("document.querySelectorAll('.crew-child').length >= 2"), 15000, 'crew children');
  result.checks.crewChildren = await evaluate("document.querySelectorAll('.crew-child').length");
  result.checks.crewProgress = await evaluate(
    "document.querySelector('.crew-kpis')?.innerText.replace(/\\s+/g, ' ').trim().slice(0, 200)"
  );
  result.checks.crewPersistedTree = await evaluate(
    "document.querySelector('.crew-plan')?.innerText.includes('派发回执') && document.querySelector('.crew-plan')?.innerText.includes('交付')"
  );
  await shoot('desktop-crew');

  await goto('providers');
  await waitFor(async () => await evaluate("document.querySelector('.provider-grid')?.innerText.includes('ui-v4-demo')"), 15000, 'provider card');
  await shoot('desktop-providers');

  await goto('gateway');
  await waitFor(async () => await evaluate("!!document.querySelector('#gateway')"), 8000, 'gateway page');
  await shoot('desktop-gateway');

  // ── 7. responsive checks ──────────────────────────────────────────────────
  for (const viewport of viewports) {
    await setViewport(viewport);
    await goto('overview');
    await sleep(500);
    const overviewOverflow = await overflow();
    await shoot(`${viewport.id}-overview`);
    await goto('crew');
    await sleep(700);
    const crewOverflow = await overflow();
    await shoot(`${viewport.id}-crew`);
    result.checks[`overflow:${viewport.id}`] = { overview: overviewOverflow, crew: crewOverflow };
  }

  // Command palette must stay reachable on phones.
  await setViewport(viewports[2]);
  result.checks.mobileCommandButtonVisible = await evaluate(
    "(() => { const b = document.querySelector('.topbar-meta .cmd-btn'); if (!b) return false; const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()"
  );
  await setViewport(viewports[0]);

  // ── 8. live invalidation really refetches a visible page ──────────────────
  await goto('providers');
  await sleep(600);
  const beforeProviders = requestCounts.get('/api/model-binding') ?? 0;
  const providerWrite = await call('api/platform/providers', 'POST', {
    id: 'ui-v4-live', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', models: ['live-model']
  });
  if (providerWrite.status !== 201) throw new Error('live provider write failed: ' + JSON.stringify(providerWrite.data));
  await waitFor(async () => await evaluate("document.body.innerText.includes('ui-v4-live')"), 12000, 'provider appeared via SSE');
  result.checks.sseInvalidatesProviders = (requestCounts.get('/api/model-binding') ?? 0) > beforeProviders;
  result.checks.providerNoReload = true;

  // ── 9. SSE failure falls back to polling ──────────────────────────────────
  await cdp('Network.setBlockedURLs', { urls: ['*api/events*'] });
  await cdp('Page.reload');
  await waitFor(async () => await evaluate("document.body.innerText.includes('轮询兜底')"), 15000, 'fallback status');
  const fallbackDom = await waitFor(async () => {
    const state = await evaluate(`({
      hash: location.hash,
      stack: document.querySelectorAll('.page-stack').length,
      kpis: document.querySelectorAll('.kpi').length,
      text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 160)
    })`);
    return state?.stack ? state : false;
  }, 12000, 'page rendered under fallback');
  result.checks.sseFallbackDom = fallbackDom;
  result.checks.sseFallback = true;
  await cdp('Network.setBlockedURLs', { urls: [] });
  await cdp('Page.reload');
  await waitFor(async () => await evaluate("document.body.innerText.includes('实时同步')"), 15000, 'live restored');
  result.checks.sseReconnect = true;

  // ── 10. reduced motion ────────────────────────────────────────────────────
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await cdp('Page.reload');
  await waitFor(async () => await evaluate("!!document.querySelector('#main-content')"), 15000, 'shell under reduced motion');
  result.checks.reducedMotionMedia = await evaluate("window.matchMedia('(prefers-reduced-motion: reduce)').matches");
  await goto('tasks');
  await waitFor(async () => await evaluate("document.querySelectorAll('.board-card').length > 0"), 12000, 'board under reduced motion');
  await evaluate("document.querySelectorAll('.board-card')[0].click(); true");
  await waitFor(async () => await evaluate("!!document.querySelector('.exec-graph')"), 12000, 'graph under reduced motion');
  await sleep(1200);
  result.checks.reducedMotionNoFlights = await evaluate("!document.querySelector('.exec-graph [data-light-layer] circle[data-flight-landing]')");
  await shoot('reduced-motion-graph');
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp('Emulation.setEmulatedMedia', { features: [] });

  // Palette keyboard path on desktop.
  await setViewport(viewports[0]);
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', modifiers: 2, windowsVirtualKeyCode: 75 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', modifiers: 2, windowsVirtualKeyCode: 75 });
  result.checks.paletteOpens = await waitFor(async () => await evaluate("!!document.querySelector('.palette')"), 5000, 'palette');
  result.checks.paletteFocusInside = await evaluate("document.activeElement?.closest('.palette') !== null");
  result.checks.paletteTrap = await evaluate(`(() => {
    const palette = document.querySelector('.palette');
    const focusables = [...palette.querySelectorAll('input,button')];
    focusables[focusables.length - 1].focus();
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.activeElement.dispatchEvent(event);
    return document.activeElement === document.querySelector('.palette input');
  })()`);
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await waitFor(async () => await evaluate("!document.querySelector('.palette')"), 5000, 'palette closed');
  result.checks.paletteEscape = true;

  result.checks.idleApiRequests = Object.fromEntries(requestCounts);
} catch (cause) {
  failure = cause;
  result.error = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
} finally {
  try { ws?.close(); } catch { /* cleanup */ }
  try { child?.kill(); } catch { /* cleanup */ }
  try { if (host) await host.close(); } catch { /* cleanup */ }
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 120 }); } catch { /* ephemeral profile */ }
  result.finishedAt = new Date().toISOString();
  result.screenshots = [...new Set(result.screenshots)];
  result.ok = !failure && result.console.errors.length === 0;
  mkdirSync('docs/verification', { recursive: true });
  writeFileSync('docs/verification/ui-redesign-v4.json', JSON.stringify(result, null, 2) + '\n');
  console.log('UI_V4_ACCEPTANCE=' + JSON.stringify({
    ok: result.ok, screenshots: result.screenshots.length,
    consoleErrors: result.console.errors.slice(0, 5), checks: Object.keys(result.checks).length,
    error: result.error?.split('\n')[0]
  }));
  if (failure) process.exitCode = 1;
}