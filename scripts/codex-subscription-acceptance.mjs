/** Explicit one-turn Host diagnostic. Never enabled by Web, Worker or AutoLoop. */
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { existsSync, readdirSync, mkdirSync, writeFileSync, rmSync, mkdtempSync, statSync } from 'node:fs';
import { Engine } from '../packages/core/src/index.ts';
import { SqliteStore } from '../packages/store-sqlite/src/index.ts';
import { acquireHostLock } from '../apps/server/src/host-lock.ts';
import { chooseMagpieProfile } from '../apps/server/src/magpie-profile.ts';
import { createMagpieHost } from '../apps/server/src/magpie-host.ts';
import { runCodexMagpieTurn } from '../apps/server/src/codex-magpie.ts';
import { CodexSubscriptionAcceptance, CODEX_SUBSCRIPTION_ACCEPTANCE_TASK, CODEX_SUBSCRIPTION_ACCEPTANCE_PROMPT } from '../apps/server/src/codex-subscription-acceptance.ts';

assert.deepEqual(process.argv.slice(2).sort(), ['--approved-cny=5','--send'], 'Explicit --send --approved-cny=5 required; no automatic startup dispatch');
const base = resolve(process.env.DAMING_DATA_DIR ?? join(process.env.LOCALAPPDATA,'Daming'));
const cliRoot = join(process.env.LOCALAPPDATA,'OpenAI','Codex','bin');
const cli = existsSync(cliRoot) ? readdirSync(cliRoot).map(d => join(cliRoot,d,'codex.exe')).find(existsSync) : undefined;
assert.ok(cli, 'installed desktop Codex CLI missing');
let store, host, workspace, legacyBudgetBefore, legacyBudgetCaptured = false;
const personalFiles = ['auth.json','config.toml'].map(name => join(process.env.USERPROFILE,'.codex',name));
const personalState = () => personalFiles.map(path => {
  try { const s = statSync(path); return { size:s.size, mtimeMs:s.mtimeMs }; }
  catch (error) { if(error.code==='ENOENT')return null; throw error; }
});
const personalBefore = personalState();
const lock = await acquireHostLock(base);
const proof = { observedAt:new Date().toISOString(), taskId:CODEX_SUBSCRIPTION_ACCEPTANCE_TASK,
  authorizedMaximumAdditionalCnyMinor:500, automaticRetry:false, productionAutoDispatchEnabled:false,
  personalAgentConfigurationModified:false, previousUnknownHoldModified:false };
try {
  mkdirSync(join(lock.base,'host'),{recursive:true});
  store = new SqliteStore(join(lock.base,'host','tasks.sqlite'));
  legacyBudgetBefore = JSON.stringify(store.governanceGet('budgets','deepseek-live-2026-11-07'));
  legacyBudgetCaptured = true;
  const engine = new Engine(store);
  assert.equal(engine.getTask(CODEX_SUBSCRIPTION_ACCEPTANCE_TASK), undefined, 'fixed acceptance already exists; no replay/new envelope');
  const profile = chooseMagpieProfile(lock.base);
  host = createMagpieHost({dataDir:profile.dataDir,profile:profile.profile});
  const status = await host.ensure();
  assert.equal(status.configured,true,status.reason);
  assert.equal(await host.scopeCapability(),true,'running formal binary lacks task scope');
  const binding = await host.codexSubscriptionBinding('gpt-6.1-sol');
  const scope = await host.probePinnedScope(binding);
  proof.scope = scope;
  assert.equal(scope.verified,true,'native subscription read-only scope not proved');
  proof.model = 'codex/' + binding.modelId;
  const workRoot = join(lock.base,'codex-subscription-acceptance');
  mkdirSync(workRoot,{recursive:true});
  workspace = mkdtempSync(join(workRoot,'run-'));
  const acceptance = new CodexSubscriptionAcceptance(store,engine,binding,frozenBinding => runCodexMagpieTurn(host,frozenBinding,{
    executable:cli,cwd:workspace,prompt:CODEX_SUBSCRIPTION_ACCEPTANCE_PROMPT,timeoutMs:45000
  }));
  acceptance.prepare();
  const started = performance.now();
  proof.result = await acceptance.authorizeAndRun(500);
  proof.elapsedMs = Math.round(performance.now()-started);
  proof.effect = store.getEffect(CODEX_SUBSCRIPTION_ACCEPTANCE_TASK+'-single-send')?.status;
  proof.ledgerAudit = store.listGovernanceAudit(CODEX_SUBSCRIPTION_ACCEPTANCE_TASK).map(e=>({type:e.type,...(e.amountMinor !== undefined ? {amountMinor:e.amountMinor} : {})}));
  proof.textAcceptancePassed = proof.result.modelStatus === 'completed' && proof.result.output.trim() === 'OK';
  proof.cashReconciled = false;
  if (!proof.textAcceptancePassed) process.exitCode = 1;
} catch (error) {
  proof.error = error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : 'subscription_acceptance_preconditions_or_execution_failed';
  process.exitCode = 1;
} finally {
  const failedCleanup = code => { (proof.cleanupFailures ??= []).push(code); process.exitCode = 1; };
  try { host?.stop(); } catch { failedCleanup('owned_backend_stop_failed'); }
  if(store) {
    try {
      proof.previousUnknownHoldModified = legacyBudgetCaptured
        ? legacyBudgetBefore !== JSON.stringify(store.governanceGet('budgets','deepseek-live-2026-11-07')) : null;
    } catch { proof.previousUnknownHoldModified = null; failedCleanup('legacy_budget_comparison_unavailable'); }
    try { store.close(); } catch { failedCleanup('store_close_failed'); }
  }
  try { proof.personalAgentConfigurationModified = JSON.stringify(personalBefore) !== JSON.stringify(personalState()); }
  catch {
    proof.personalAgentConfigurationModified = null;
    proof.personalConfigComparisonUnavailable = true;
    failedCleanup('personal_config_comparison_unavailable');
  }
  if(workspace)try { rmSync(workspace,{recursive:true,force:true,maxRetries:8,retryDelay:100}); }catch{proof.workspaceCleanupPending=true;}
  try { await lock.close(); } catch { failedCleanup('host_lock_close_failed'); }
  writeFileSync('.cache/verification/codex-subscription-live-2026-11-16.json',JSON.stringify(proof,null,2)+'\n');
  console.log(JSON.stringify(proof,null,2));
}

