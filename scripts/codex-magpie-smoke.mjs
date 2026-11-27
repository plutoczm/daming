/** Actual CLI + owned Go binary, synthetic local provider ONLY. No real credentials. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { Engine } from '../packages/core/src/index.ts';
import { ProjectSpendLedger } from '../packages/governance/src/index.ts';
import { SqliteStore } from '../packages/store-sqlite/src/index.ts';
import { createMagpieHost } from '../apps/server/src/magpie-host.ts';
import { runCodexMagpieTurn } from '../apps/server/src/codex-magpie.ts';
import { ProjectControl } from '../apps/server/src/project-control.ts';
import { ProjectPaidEgress } from '../apps/server/src/trusted-paid-egress.ts';
import { openProjectMagpieResponsesRelay, qualifyNativeMessagesRequest, withGovernedProjectMagpieTurn } from '../apps/server/src/magpie-governed-route.ts';
import { ProjectRuntimeIsolation } from '../apps/server/src/project-runtime-isolation.ts';
import { ProjectWorkspace } from '../apps/server/src/project-workspace.ts';
import { dockerBinary, LOCAL_DOCKER_PIPE } from '../apps/server/src/tenant-docker-sandbox.ts';

function option(name) { return process.argv.find(a => a.startsWith('--' + name + '='))?.slice(name.length + 3); }
const projectBound = process.argv.includes('--project-bound');
const nativeContainer = process.argv.includes('--native-container');
const nativeAgentTurn = process.argv.includes('--native-agent-turn');
const nativeToolTurn = process.argv.includes('--native-tool-turn');
const nativeClaudeTurn = process.argv.includes('--native-claude-turn');
const stagedModel = nativeClaudeTurn ? 'claude-sonnet-4-6' : 'sample';
assert.ok(!nativeContainer || projectBound, 'The container probe requires project-bound mode');
assert.ok(!nativeAgentTurn || nativeContainer, 'The agent turn probe requires the native container');
assert.ok(!nativeToolTurn || nativeAgentTurn, 'The tool probe requires the native App Server turn');
assert.ok(!nativeClaudeTurn || nativeContainer && !nativeAgentTurn, 'The Claude turn requires its native container');
const install = join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin');
const cli = option('codex') ?? (existsSync(install) ? readdirSync(install).map(d => join(install,d,'codex.exe')).find(existsSync) : undefined);
const binary = resolve(option('magpie') ?? 'runtime/magpie/windows-x64/daming-magpie-codex-subscription-v2.exe');
if (!projectBound) assert.ok(cli && existsSync(cli), 'Codex executable required; pass --codex=<absolute exe>');
assert.ok(existsSync(binary), 'Scoped staged binary required; pass --magpie=<absolute exe>; do not replace the production binary');
const root = mkdtempSync(join(tmpdir(), 'daming codex magpie smoke '));
const report = { observedAt: new Date().toISOString(), scope: projectBound
  ? (nativeContainer ? 'real_docker_and_magpie_local_provider_only' : 'real_magpie_project_ledger_local_provider_only')
  : 'real_cli_and_magpie_synthetic_provider_only',
  realCredentialsUsed: false, paidModelCalls: 0, productionDispatchEnabled: false, cases: [] };
let host;
let stub;
let store;
let ledger;
let stopContainer;
const savedEnv = { ...process.env };
async function listen(server) {
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
  return server.address().port;
}
async function port() { const s = createServer(); const p = await listen(s); await new Promise(r => s.close(r)); return p; }
async function within(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out waiting for ' + label)), 8_000);
    })]);
  } finally { clearTimeout(timer); }
}
async function sendFromGuest(containerId, relay, body) {
  const program = `
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { baseUrl, token, body } = JSON.parse(input);
const response = await fetch(baseUrl + '/responses', {
  method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body,
  signal: AbortSignal.timeout(30000),
});
if (response.status !== 200) throw new Error('Container relay returned ' + response.status);
console.log(await response.text());
`;
  const operation = promisify(execFile)(dockerBinary(), ['--host', LOCAL_DOCKER_PIPE, 'exec', '--interactive',
    containerId, '/usr/local/bin/node', '--input-type=module', '-e', program],
  { timeout: 35000, windowsHide: true, encoding: 'utf8' });
  operation.child.stdin.on('error', () => {});
  operation.child.stdin.end(JSON.stringify({ baseUrl: relay.baseUrl, token: relay.token, body }), 'utf8');
  return (await operation).stdout;
}
try {
  // The disposable Magpie must not discover personal Agent sign-ins or plugins.
  for (const key of Object.keys(process.env)) {
    if (!['SYSTEMROOT','WINDIR','PATH','COMSPEC','PATHEXT','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS'].includes(key.toUpperCase())) delete process.env[key];
  }
  for (const name of ['USERPROFILE','HOME','APPDATA','LOCALAPPDATA','TEMP','TMP','CODEX_HOME']) {
    process.env[name] = join(root, 'private-' + name.toLowerCase());
    mkdirSync(process.env[name], { recursive: true });
  }
  if (!projectBound) report.codexVersion = execFileSync(cli, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
  let calls = 0, behavior = 'success';
  const toolFile = 'evidence.md', toolEvidence = 'verified-workspace-text';
  const pausedRequestArrived = Promise.withResolvers();
  const pausedUpstreamClosed = Promise.withResolvers();
  stub = createServer(async (req,res) => {
    console.error('SYNTHETIC_UPSTREAM', req.method, req.url);
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    assert.equal(data.model, stagedModel);
    assert.equal(data.stream, true);
    assert.equal(req.headers.authorization, 'Bearer synthetic-not-a-real-provider-key');
    calls++;
    if (projectBound) {
      report.heldAtUpstream = ledger.budget('project').heldMinor;
      (report.upstreamHeldAmounts ??= []).push(report.heldAtUpstream);
    }
    if (behavior === 'rate-limit') { res.writeHead(429, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"synthetic rate limit"}}'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null, usage) => res.write('data: ' + JSON.stringify({
      id: 'synthetic-chat', object: 'chat.completion.chunk', created: 1, model: stagedModel,
      choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {})
    }) + '\n\n');
    chunk(behavior === 'tool-first' ? { role: 'assistant' } : { role: 'assistant', content: 'MAGPIE_' });
    if (behavior === 'tool-first') {
      assert.ok(data.tools?.some(tool => tool.function?.name === 'project_read_file'));
      chunk({ tool_calls: [{ index: 0, id: 'call_daming_workspace', type: 'function',
        function: { name: 'project_read_file', arguments: JSON.stringify({ file: toolFile }) } }] });
      chunk({}, 'tool_calls', { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
      res.end('data: [DONE]\n\n');
      return;
    }
    if (behavior === 'tool-second') {
      assert.ok(data.messages.some(message => message.role === 'tool' &&
        JSON.stringify(message.content).includes(toolEvidence)));
      report.upstreamReceivedWorkspaceToolOutput = true;
    }
    if (behavior === 'drop') { res.destroy(); return; }
    if (behavior === 'pause') {
      res.once('close', pausedUpstreamClosed.resolve);
      pausedRequestArrived.resolve();
      return;
    }
    await new Promise(r => setTimeout(r, 80));
    if (res.destroyed) return;
    chunk({ content: 'CODEX_OK' });
    chunk({}, 'stop', { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
    res.end('data: [DONE]\n\n');
  });
  const upstreamPort = await listen(stub);
  const dataDir = join(root, 'magpie');
  const config = join(dataDir, 'config', 'magpie');
  const cwd = join(root, 'workspace');
  mkdirSync(config, { recursive: true }); mkdirSync(cwd, { recursive: true });
  writeFileSync(join(config,'providers.json'), JSON.stringify({ providers: [{
    id: 'stage', name: 'Synthetic offline provider', key: 'synthetic-not-a-real-provider-key',
    chat: 'http://127.0.0.1:' + upstreamPort + '/v1', models: [stagedModel]
  }] }));
  const gatewayPort = await port(); let adminPort = await port();
  while (gatewayPort === adminPort) adminPort = await port();
  host = createMagpieHost({ dataDir, binary, port: gatewayPort, adminPort });
  const status = await host.ensure();
  assert.equal(status.configured, true, status.reason);
  assert.equal(await host.scopeCapability(), true);
  const catalog = await host.routingCatalog();
  const candidate = catalog.candidates.find(c => c.providerId === 'stage' && c.modelId === stagedModel);
  assert.ok(candidate, 'synthetic fixed account missing');
  const binding = { instanceId: catalog.instanceId, providerId: candidate.providerId,
    modelId: candidate.modelId, accountRef: candidate.accountRef };
  if (projectBound) {
    store = new SqliteStore(join(root, 'project.sqlite'));
    const engine = new Engine(store, store);
    const at = () => new Date().toISOString();
    const control = new ProjectControl(engine, at);
    ledger = new ProjectSpendLedger(store, Date.now);
    engine.executeProject({ type: 'create_project', projectId: 'project', eventId: 'create', expectedRevision: 0,
      at: at(), ownerId: 'test-owner', goal: 'Observe the scoped Go route', documents: {
        spec: [{ id: 'scope', text: 'One local Responses request' }],
        plan: [{ id: 'send', text: 'Reserve before passing the request to Magpie' }],
        acceptance: [{ id: 'receipt', text: 'Terminal receipt and no replay' }]
      } });
    ledger.initializeBudget('project', 400);
    const egress = new ProjectPaidEgress(control, ledger);
    const body = JSON.stringify({ model: 'stage/sample', stream: true, input: 'Return the verification token.' });
    const intent = (sendId, epoch, attemptId = 'one', taskId = 'verify') => ({
      projectId: 'project', taskId, attemptId, epoch, sendId,
      provider: binding.providerId, accountRef: binding.accountRef, model: binding.modelId, protocol: 'responses_http',
      requestDigest: createHash('sha256').update(body).digest('hex'),
      quote: { source: 'fixed_tariff', maximumCashMinor: 200, basisRef: 'local-test-only',
        enforcementRef: 'scoped-test-binary', expiresMs: Date.now() + 60_000 }
    });
    const send = (sendId, epoch) => withGovernedProjectMagpieTurn(host, binding, egress, intent(sendId, epoch),
      async forward => (await forward(body, new AbortController().signal)).text());
    const assertFirst = first => {
      assert.match(first, /response\.completed/);
      assert.equal(calls, 1);
      assert.equal(report.heldAtUpstream, 200);
      assert.equal(store.getProjectSend('project', 'first')?.status, 'awaiting_cash');
    };
    if (nativeClaudeTurn) {
      const isolation = new ProjectRuntimeIsolation(control, {
        dsh: option('dsh-image'), codex: option('codex-image'), claude: option('claude-image'),
      });
      const lease = { projectId: 'project', taskId: 'verify', attemptId: 'one', epoch: 0, startId: 'claude-native' };
      const pause = () => isolation.pause(lease.projectId, { kind: 'manual', id: 'verify-stop' });
      stopContainer = pause;
      await isolation.open(lease, 'claude');
      const prompt = 'Reply with MAGPIE_CODEX_OK. Do not use tools.';
      const maximumOutputTokens = 256;
      const relay = await isolation.openMessagesRelay(lease, async (raw, signal, deliver) => {
        const body = qualifyNativeMessagesRequest(binding, raw, maximumOutputTokens);
        const request = JSON.parse(body);
        report.nativeClaudeMaximumOutputTokens = request.max_tokens;
        assert.ok(JSON.stringify(request.messages).includes(prompt));
        const approved = { ...intent('first', 0), protocol: 'messages_http', requestDigest: createHash('sha256').update(body).digest('hex') };
        await withGovernedProjectMagpieTurn(host, binding, egress, approved,
          async forward => deliver(await forward(body, signal)));
      });
      try {
        const result = await isolation.runClaudeTurn(lease, relay, stagedModel, prompt, { maximumOutputTokens });
        assert.equal(result.status, 'completed');
        assert.equal(result.output, 'MAGPIE_CODEX_OK');
        assert.equal(store.getProjectSend('project', 'first')?.status, 'awaiting_cash');
        assert.deepEqual(report.upstreamHeldAmounts, [200]);
        assert.equal(report.nativeClaudeMaximumOutputTokens, maximumOutputTokens);
        report.nativeClaudeAgentTurnCompleted = true;
      } finally { relay.close(); await relay.closed; }
      assert.equal((await pause()).status, 'stopped');
      await assert.rejects(isolation.openMessagesRelay(lease, async () => {}));
      assert.equal(calls, 1);
      stopContainer = undefined;
    } else if (nativeContainer) {
      const isolation = new ProjectRuntimeIsolation(control, {
        dsh: option('dsh-image'), codex: option('codex-image'), claude: option('claude-image'),
      });
      const lease = { projectId: 'project', taskId: nativeToolTurn ? 'e6df3148-6af9-4348-9d11-32448a8e32a2' : 'verify',
        attemptId: 'one', epoch: 0, startId: 'native' };
      const pause = () => isolation.pause(lease.projectId, { kind: 'manual', id: 'verify-stop' });
      stopContainer = pause;
      let input;
      if (nativeToolTurn) {
        writeFileSync(join(cwd, toolFile), toolEvidence, 'utf8');
        const workspace = new ProjectWorkspace(cwd, join(root, 'staged'));
        input = { workspace, files: workspace.import(lease.taskId, [toolFile]) };
      }
      const native = await isolation.open(lease, 'codex', input);
      const scratchContainers = [native.containerId];
      stopContainer = async () => {
        const barrier = await pause();
        if (barrier.status !== 'recovery_required') return;
        // The staged test owns this container and its local fixture. Preserve
        // the unresolved ledger receipt while removing its stopped scratch runtime.
        const docker = dockerBinary();
        const local = ['--host', LOCAL_DOCKER_PIPE];
        for (const id of scratchContainers) {
          const raw = execFileSync(docker, [...local, 'container', 'inspect', id], { encoding: 'utf8', timeout: 5000 });
          const [stopped] = JSON.parse(raw);
          assert.equal(stopped.Id, id);
          assert.equal(stopped.Image, option('codex-image'));
          assert.equal(stopped.Config.Labels['io.daming.runtime'], 'native-offline-v2');
          assert.equal(stopped.State.Status, 'exited');
          assert.equal(stopped.State.Pid, 0);
          execFileSync(docker, [...local, 'container', 'rm', id], { encoding: 'utf8', timeout: 5000 });
        }
      };
      const prompt = 'Reply with MAGPIE_CODEX_OK. Do not use tools.';
      const toolPrompt = 'Read evidence.md with project_read_file, then reply with MAGPIE_CODEX_OK.';
      const selectedPrompt = nativeToolTurn ? toolPrompt : prompt;
      // This quote is for the synthetic account configured in this script only.
      const stagedAgentRelay = (owner, sendId, limit = 1) =>
        isolation.openResponsesRelay(owner, async (raw, signal, deliver) => {
          const request = JSON.parse(raw);
          assert.equal(request.model, 'stage/sample');
          assert.equal(request.stream, true);
          assert.ok(JSON.stringify(request.input).includes(selectedPrompt));
          if (nativeToolTurn) {
            assert.ok(JSON.stringify(request.tools).includes('project_read_file'));
            behavior = calls === 0 ? 'tool-first' : 'tool-second';
          }
          const approved = { ...intent(nativeToolTurn ? sendId + '-' + (calls + 1) : sendId,
            owner.epoch, owner.attemptId, owner.taskId), requestDigest: createHash('sha256').update(raw).digest('hex') };
          await withGovernedProjectMagpieTurn(host, binding, egress, approved,
            async forward => deliver(await forward(raw, signal)));
        }, { requestLimit: limit });
      const relay = nativeAgentTurn
        ? await stagedAgentRelay(lease, 'first', nativeToolTurn ? 2 : 1)
        : await openProjectMagpieResponsesRelay(isolation, lease, host, binding, egress, intent('first', 0));
      try {
        if (nativeAgentTurn) {
          await assert.rejects(isolation.runCodexTurn(lease, { ...relay }, 'stage/sample', selectedPrompt), /active private relay/);
          const result = await isolation.runCodexTurn(lease, relay, 'stage/sample', selectedPrompt,
            nativeToolTurn ? { readFiles: [toolFile] } : undefined);
          assert.equal(result.status, 'completed');
          assert.equal(result.output, 'MAGPIE_CODEX_OK');
          if (nativeToolTurn) {
            assert.equal(calls, 2);
            assert.equal(report.upstreamReceivedWorkspaceToolOutput, true);
            assert.equal(report.heldAtUpstream, 400);
            assert.deepEqual(report.upstreamHeldAmounts, [200, 400]);
            const toolEvents = result.events.filter(event => event.kind === 'workspace_read_requested');
            assert.equal(toolEvents.length, 1);
            assert.equal('workspaceFile' in toolEvents[0], false);
            for (const id of ['first-1', 'first-2']) {
              assert.equal(store.getProjectSend('project', id)?.status, 'awaiting_cash');
            }
            await assert.rejects(sendFromGuest(native.containerId, relay, body), /returned 409/);
            assert.equal(calls, 2);
          } else {
            assert.equal(calls, 1);
            assert.equal(report.heldAtUpstream, 200);
            assert.equal(store.getProjectSend('project', 'first')?.status, 'awaiting_cash');
          }
          report.nativeAgentTurnCompleted = true;
        } else {
          assertFirst(await sendFromGuest(native.containerId, relay, body));
        }
      }
      finally { relay.close(); await relay.closed; }

      if (nativeToolTurn) {
        assert.equal((await pause()).status, 'stopped');
        stopContainer = undefined;
      } else {
        behavior = 'pause';
        const waitingLease = nativeAgentTurn ? { ...lease, attemptId: 'two', startId: 'second-native' } : lease;
        if (nativeAgentTurn) {
          const waitingNative = await isolation.open(waitingLease, 'codex');
          scratchContainers.push(waitingNative.containerId);
        }
        const waiting = nativeAgentTurn
          ? await stagedAgentRelay(waitingLease, 'in-flight')
          : await openProjectMagpieResponsesRelay(isolation, waitingLease, host, binding, egress, intent('in-flight', 0));
        const pending = nativeAgentTurn
          ? isolation.runCodexTurn(waitingLease, waiting, 'stage/sample', prompt).then(result => result.status !== 'completed', () => true)
          : sendFromGuest(native.containerId, waiting, body).then(() => false, () => true);
        await within(pausedRequestArrived.promise, 'the upstream request');
        assert.equal(report.heldAtUpstream, 400);
        assert.equal((await pause()).status, 'recovery_required');
        await within(pausedUpstreamClosed.promise, 'the upstream connection to close');
        await waiting.closed;
        assert.equal(await pending, true);
        if (nativeAgentTurn) report.nativeAgentTurnStopped = true;
        for (let i = 0; i < 50 && store.getProjectSend('project', 'in-flight')?.status === 'in_flight'; i++) {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(store.getProjectSend('project', 'in-flight')?.status, 'unknown');
        await assert.rejects(openProjectMagpieResponsesRelay(isolation, lease, host, binding, egress, intent('paused', 0)));
        assert.equal(calls, 2);
        report.upstreamClosedOnPause = true;
        report.pendingExecutionUnknown = true;
        await stopContainer();
        stopContainer = undefined;
      }
    } else {
      assertFirst(await send('first', 0));
      behavior = 'drop';
      await assert.rejects(send('interrupted', 0));
      assert.equal(calls, 2);
      assert.equal(report.heldAtUpstream, 400);
      assert.equal(store.getProjectSend('project', 'interrupted')?.status, 'unknown');
      await assert.rejects(send('paused', 1));
      assert.equal(calls, 2);
    }
    report.cases.push({ upstreamSends: calls, postPauseSends: 0, heldMinor: ledger.budget('project').heldMinor });
  }
  for (const mode of projectBound ? [] : ['success','rate-limit','drop']) {
    console.error('CODEX_MAGPIE_CASE', mode);
    behavior = mode; const before = calls; const started = performance.now();
    const result = await runCodexMagpieTurn(host, binding, { executable: cli, cwd,
      prompt: 'Reply with MAGPIE_CODEX_OK. Do not use tools.', timeoutMs: 30000 });
    console.error('CODEX_MAGPIE_RESULT', result.status, result.error ?? '', 'sends', calls - before);
    assert.equal(calls - before, 1, mode + ' must have exactly one upstream send');
    if (mode === 'success') {
      assert.equal(result.status, 'completed', JSON.stringify(result));
      assert.equal(result.output, 'MAGPIE_CODEX_OK');
      assert.equal(result.usage?.input_tokens, 7); assert.equal(result.usage?.output_tokens, 3);
    } else assert.notEqual(result.status, 'completed', mode + ' cannot be reported as completed');
    report.cases.push({ behavior: mode, upstreamSends: calls - before, status: result.status,
      elapsedMs: Math.round(performance.now()-started), ...(result.usage ? { syntheticUsage: result.usage } : {}) });
  }
  report.passed = true;
} finally {
  if (stopContainer) await stopContainer().catch(() => { report.containerCleanupPending = true; });
  store?.close();
  host?.stop();
  if (stub) { stub.closeAllConnections(); await new Promise(r => stub.close(r)); }
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  // Give the owned Windows process time to close its private SQLite handles.
  try { await rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 }); }
  catch { report.temporaryFilesCleanupPending = true; }
}
if (!projectBound) {
  mkdirSync('.cache/verification', { recursive: true });
  writeFileSync('.cache/verification/codex-magpie-2026-11-16.json', JSON.stringify(report,null,2)+'\n');
}
console.log(JSON.stringify(report,null,2));

