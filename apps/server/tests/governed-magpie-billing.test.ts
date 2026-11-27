import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { planGovernedMagpieTargets } from '../src/magpie-governed-route.ts';
import type { MagpieUnifiedCatalog } from '../src/magpie-unified-targets.ts';
import {
  GovernedToolTurnKernel, parseGovernedChatTurn, runGovernedMemoryTool
} from '../src/governed-tool-turns.ts';
import { readOpenAiIssuedKeyDailyCost } from '../src/official-cost-evidence.ts';
import { IdentityRegistry } from '../src/identity-registry.ts';
import { TenantBudgetLedger } from '../src/tenant-budget.ts';

test('Magpie subscription and dynamic group are discovered but never silently run using BYOA', () => {
  const now = Date.UTC(2026, 10, 13, 14, 0);
  const catalog: MagpieUnifiedCatalog = {
    source: 'magpie-native-routing', checkedAt: new Date(now).toISOString(),
    dispatchEnabled: false, managesCredentialsInMagpie: true, targets: [
      { targetId: 'codex/gpt-6', kind: 'agent-backed',
        label: 'Codex subscription', providerId: 'codex', ready: true, members: 1 },
      { targetId: 'group/team', kind: 'route-group',
        label: 'Dynamic group', providerId: null, ready: true, members: 3 },
      { targetId: 'deepseek/deepseek-flash', kind: 'llm',
        label: 'Independent API', providerId: 'deepseek', ready: true, members: 1 },
      { targetId: 'openai/gpt-6-luna', kind: 'llm',
        label: 'Other verified model', providerId: 'openai', ready: true, members: 1 }
    ]
  };
  const account = {
    credentialId: randomUUID(), provider: 'deepseek' as const,
    modelId: 'deepseek-flash', expiresAt: new Date(now + 60000).toISOString()
  };
  const plan = planGovernedMagpieTargets(catalog, [account], { nowMs: now });
  assert.equal(plan.selected?.targetId, 'deepseek/deepseek-flash');
  assert.equal(plan.selected?.credentialId, account.credentialId);
  assert.equal(plan.paidDispatchPermitted, false);
  assert.equal(plan.nativeMagpieFallbackDisabled, true);
  assert.equal(plan.candidates[0].eligibility,
    'subscription_agent_requires_native_isolation_and_entitlement');
  assert.equal(plan.candidates[1].eligibility,
    'native_group_requires_final_account_receipt');
  assert.equal(plan.candidates[3].eligibility, 'model_and_tenant_account_not_bound');
  assert.equal(planGovernedMagpieTargets(catalog, [account, {
    ...account, credentialId: randomUUID()
  }], { nowMs: now }).selected, null,
  'two candidate billing owners for the same model fail closed');
  assert.equal(planGovernedMagpieTargets(catalog, [{
    ...account, expiresAt: new Date(now - 1).toISOString()
  }], { nowMs: now }).selected, null);
  assert.throws(() => planGovernedMagpieTargets(catalog, [account], {
    nowMs: now + 121000
  }), /catalog_missing_or_stale/);
  assert.throws(() => planGovernedMagpieTargets({
    ...catalog, targets: [...catalog.targets, catalog.targets[2]]
  }, [account], { nowMs: now }), /target_invalid/);
});

const completion = (reason: 'stop' | 'tool_calls', toolCalls?: unknown[], content: string | null = null) => ({
  object: 'chat.completion',
  choices: [{ finish_reason: reason, message: {
    role: 'assistant', content,
    ...(toolCalls === undefined ? {} : { tool_calls: toolCalls })
  } }],
  usage: { prompt_tokens: 13, completion_tokens: 9 }
});
const tool = (id: string, name: string, argumentsText: string) => ({
  id, type: 'function', function: { name, arguments: argumentsText }
});
test('bounded multi-turn protocol performs only two pure memory tools, blocks paid continuation', () => {
  const kernel = new GovernedToolTurnKernel();
  const tools = [tool('c1', 'count_characters', JSON.stringify({text:'你好'})),
    tool('c2','find_literal',JSON.stringify({text:'hello world',needle:'world'}))];
  const response = kernel.applyModelResult(completion('tool_calls', tools));
  assert.equal(response.state, 'awaiting_cash_reconciliation');
  assert.equal(response.turns, 1);
  assert.deepEqual(response.safeToolResults.map(x => JSON.parse(x.text)), [
    { characters: 2, utf8Bytes: 6 }, { found: true, position: 6 }
  ]);
  assert.equal(response.autoPaidContinuationPermitted, false);
  assert.equal(response.vendorInvoiceReconciled, false);
  assert.throws(() => kernel.applyModelResult(completion('stop', undefined, 'later')),
    /agent_turn_not_authorized/);
  // A simulator can validate multiple turns, but no live Host API exposes
  // this test-only transition or treats mock replay as an invoice.
  kernel.advanceSyntheticOfflineTest();
  const after = kernel.applyModelResult(completion('tool_calls', [
    tool('c3','find_literal',JSON.stringify({text:'ABC',needle:'D'}))
  ]));
  assert.equal(after.turns,2);
  assert.equal(JSON.parse(after.safeToolResults[0].text).found,false);
  kernel.advanceSyntheticOfflineTest();
  const last = kernel.applyModelResult(completion('stop', undefined, 'Completed offline demo'));
  assert.equal(last.state,'completed_cash_unknown');
  assert.equal(last.turns,3);
  assert.equal(last.lastContent,'Completed offline demo');
  assert.throws(() => kernel.advanceSyntheticOfflineTest(), /agent_test_advance_denied/);
  assert.throws(() => parseGovernedChatTurn(completion('tool_calls', [
    tool('bad','run_shell',JSON.stringify({command:'rm -rf /'}))
  ])), /tool_contract_invalid/);
  assert.throws(() => parseGovernedChatTurn(completion('tool_calls', [
    tool('bad','count_characters',JSON.stringify({text:'x',path:'C:/Users'}))
  ])), /tool_arguments_untrusted/);
  assert.throws(() => parseGovernedChatTurn(completion('tool_calls', [
    tool('same','count_characters',JSON.stringify({text:'x'})),
    tool('same','count_characters',JSON.stringify({text:'y'}))
  ])), /tool_id_reused/);
  assert.throws(() => runGovernedMemoryTool({
    callId:'bad', name:'count_characters',
    input:{ text:'a'.repeat(3000) }
  }), /tool_execution_invalid/);
});

test('official OpenAI costs are project AND issued API-key scoped, complete day; never invoice', async () => {
  const now = Date.UTC(2026, 10, 13, 16);
  const start = Math.floor(now / 86400000) * 86400 - 86400;
  let called = 0;
  const read = async (host: string, path: string, adminKey: string): Promise<unknown> => {
    assert.equal(host,'api.openai.com');
    assert.equal(adminKey,'sk-official-admin-local-stub-2026');
    called++;
    if (called === 1) return {object:'organization.project',id:'proj_daming2026'};
    const url = new URL('https://api.openai.com'+path);
    assert.equal(url.pathname,'/v1/organization/costs');
    assert.deepEqual(url.searchParams.getAll('project_ids[]'), ['proj_daming2026']);
    assert.deepEqual(url.searchParams.getAll('api_key_ids[]'), ['key_daming2026']);
    assert.deepEqual(url.searchParams.getAll('group_by[]'), ['project_id','api_key_id']);
    assert.equal(url.searchParams.get('start_time'),String(start));
    return { object:'page',has_more:false,next_page:null,data:[{
      object:'bucket',start_time:start,end_time:start+86400,
      results:[{
        object:'organization.costs.result',
        project_id:'proj_daming2026',api_key_id:'key_daming2026',
        line_item:'chat.completions',amount:{currency:'usd',value:0.00715}
      }]
    }]};
  };
  const evidence = await readOpenAiIssuedKeyDailyCost({
    projectId:'proj_daming2026',keyId:'key_daming2026',
    adminKey:'sk-official-admin-local-stub-2026',nowMs:now
  }, read);
  assert.equal(called,2);
  assert.equal(evidence.totalMicroUsd,7150);
  assert.equal(evidence.issuedKeyProjectBindingChecked,true);
  assert.equal(evidence.invoiceAuthenticated,false);
  assert.equal(evidence.settledSingleRequest,false);
  assert.equal(evidence.strictPerRequestCashCapVerified,false);
  assert.equal(evidence.automaticallyReleasesUnknownHold,false);
  await assert.rejects(readOpenAiIssuedKeyDailyCost({
    projectId:'proj_daming2026',keyId:'key_daming2026',
    adminKey:'sk-official-admin-local-stub-2026',nowMs:now
  }, async (_,path) => path.includes('/costs')
    ? { object:'page',has_more:false,next_page:null,data:[{
      object:'bucket',start_time:start,end_time:start+86400,
      results:[{object:'organization.costs.result',
        project_id:'proj_daming2026',api_key_id:'key_UNRELATED',
        amount:{currency:'usd',value:2}}]
    }] } : {object:'organization.project',id:'proj_daming2026'}),
    /official_cost_scope_or_amount_invalid/);
  await assert.rejects(readOpenAiIssuedKeyDailyCost({
    projectId:'proj_daming2026',keyId:'key_daming2026',
    adminKey:'sk-official-admin-local-stub-2026',nowMs:now
  }, async (_,path) => path.includes('/costs')
    ? {object:'page',has_more:true,next_page:'next',data:[]}
    : {object:'organization.project',id:'proj_daming2026'}),
    /official_cost_page_incomplete/);
});

test('official admin cost observation persists under issued key and never releases unknown funds', async () => {
  const dir=mkdtempSync(join(tmpdir(),'daming-official-evidence-'));
  const stamp=Date.UTC(2026,10,13,14);
  let clock=stamp;
  const options={protectMaster:(v:string)=>'x:'+v,
    unprotectMaster:(v:string)=>v.slice(2),clock:()=>clock};
  const identity = new IdentityRegistry(dir,options);
  const ledger = new TenantBudgetLedger(dir,()=>clock);
  try {
    const root=await identity.setup({username:'evidenceowner',
      password:'test-password-official-cost-evidence',
      tenantName:'Evidence tenant'});
    const a=root.session.identity;
    const other=identity.createTenant(a,'Second tenant');
    const b=identity.switchTenant(a,other.tenantId,
      'daming_identity='+root.cookie).session.identity;
    const req=randomUUID();
    identity.beginOpenAiKeyIssuance(a,{
      requestId:req,projectId:'proj_daming2026',serviceAccountId:'svc_acct_daming2026',
      modelId:'gpt-6-luna'
    });
    const issued=identity.completeOpenAiKeyIssuance(a,req,{
      keyId:'key_daming2026',secret:'sk-service-issue-fixture-only',
      projectId:'proj_daming2026',serviceAccountId:'svc_acct_daming2026',
      issuedAtMs:stamp,expiresAtMs:stamp+3600000,
      officialProjectIssuanceVerified:true,
      vendorBillingOwnerVerified:false,invoiceReconciled:false,
      guaranteedCashCap:false,paidDispatchPermitted:false
    });
    assert.throws(()=>identity.trustedIssuedOpenAiCostScope(b,issued.credentialId),
      /openai_issued_key_not_found/);
    ledger.configure(a,{currency:'USD',perRequestMinor:100,perUtcDayMinor:100});
    const hold = ledger.preparePaid(a,{
      requestId:randomUUID(),credentialId:issued.credentialId,provider:'openai',
      modelId:'gpt-6-luna',currency:'USD',reservedMinor:80,
      payloadDigest:'a'.repeat(128)
    });
    const evidence={
      source:'openai_admin_daily_costs_api' as const,
      utcDay:'2026-11-12',totalMicroUsd:7150,
      issuedKeyProjectBindingChecked:true as const,
      officialAggregateObserved:true as const,
      invoiceAuthenticated:false as const,
      strictPerRequestCashCapVerified:false as const,
      automaticallyReleasesUnknownHold:false as const
    };
    const result=identity.recordOfficialIssuedKeyDailyCost(
      a,issued.credentialId,evidence);
    assert.equal(result.singleRequestSettled,false);
    assert.equal(result.cashHoldReleased,false);
    assert.equal(identity.listOfficialIssuedKeyCostObservations(a).length,1);
    assert.deepEqual(identity.listOfficialIssuedKeyCostObservations(b),[]);
    assert.equal(ledger.listPaid(a)[0].status,'prepared');
    assert.equal(ledger.policy(a,'USD')?.holdsAndSettledTodayMinor,80);
    assert.throws(()=>identity.recordOfficialIssuedKeyDailyCost(
      b,issued.credentialId,evidence),/openai_issued_key_not_found/);
  } finally {
    ledger.close();identity.close();
    rmSync(dir,{recursive:true,force:true,maxRetries:8,retryDelay:60});
  }
});
