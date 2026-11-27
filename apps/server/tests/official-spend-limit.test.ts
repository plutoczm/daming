import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readOpenAiSpendLimitState } from '../src/official-spend-limit.ts';
import { IdentityRegistry } from '../src/identity-registry.ts';
import { TenantBudgetLedger } from '../src/tenant-budget.ts';

const admin = 'sk-only-mock-admin-limit-2026';
const projectId = 'proj_daming_limit2026';
const serviceId = 'svc_acct_daming_limit2026';
const keyId = 'key_daming_limit2026';
const response = (scope: 'project' | 'organization', status: 'enforcing' | 'inactive', cents: number) => ({
  object: scope + '.spend_limit',
  threshold_amount: cents, currency: 'USD', interval: 'month',
  enforcement: { status }
});

test('read-only official project and organization spend limits uses exact verified paths', async () => {
  const paths: string[] = [];
  const evidence = await readOpenAiSpendLimitState({
    projectId, adminKey: admin, nowMs: Date.UTC(2026,10,13)
  }, async (host,path,key) => {
    assert.equal(host, 'api.openai.com');
    assert.equal(key, admin);
    paths.push(path);
    return path.endsWith('/projects/'+projectId+'/spend_limit')
      ? response('project','enforcing',1000)
      : response('organization','enforcing',5000);
  });
  assert.deepEqual(paths, [
    '/v1/organization/projects/'+projectId+'/spend_limit',
    '/v1/organization/spend_limit'
  ]);
  assert.equal(evidence.project.thresholdMinor,1000);
  assert.equal(evidence.organization.thresholdMinor,5000);
  assert.equal(evidence.effectiveMonthlyThresholdMinor,1000);
  assert.equal(evidence.providerMonthlyEnforcementVerified,true);
  assert.equal(evidence.limitMayOvershoot,true);
  assert.equal(evidence.precisePerRequestCashCapVerified,false);
  assert.equal(evidence.enablesAutomaticPaidDispatch,false);
  assert.equal(evidence.vendorInvoiceAuthenticated,false);
  assert.equal('adminKey' in evidence,false);
  assert.equal(JSON.stringify(evidence).includes(admin),false);
});

test('inactive or invalid official limits never masquerade as enforced caps', async () => {
  const allInactive=await readOpenAiSpendLimitState({
    projectId, adminKey:admin
  },async (_,path)=>path.includes('/projects/')
    ? response('project','inactive',1000)
    : response('organization','inactive',5000));
  assert.equal(allInactive.providerMonthlyEnforcementVerified,false);
  assert.equal(allInactive.effectiveMonthlyThresholdMinor,null);
  const orgOnly=await readOpenAiSpendLimitState({
    projectId,adminKey:admin
  },async (_,path)=>path.includes('/projects/')
    ? response('project','inactive',1000)
    : response('organization','enforcing',2000));
  assert.equal(orgOnly.effectiveMonthlyThresholdMinor,2000);
  await assert.rejects(readOpenAiSpendLimitState({
    projectId,adminKey:admin
  },async (_,path)=>path.includes('/projects/')
    ? { ...response('project','enforcing',1000), enforcement:{ status:'monitoring' } }
    : response('organization','enforcing',5000)),
    /official_spend_limit_response_invalid/);
  await assert.rejects(readOpenAiSpendLimitState({
    projectId,adminKey:admin
  },async (_,path)=>path.includes('/projects/')
    ? response('project','enforcing',0)
    : response('organization','enforcing',5000)),
    /official_spend_limit_response_invalid/);
  await assert.rejects(readOpenAiSpendLimitState({
    projectId:'http://attacker.invalid',adminKey:admin
  },async ()=>{throw new Error('must never be called');}),
    /official_spend_limit_query_invalid/);
});

test('monthly spend limit observation belongs to issued tenant key and cannot release cash',async () => {
  const dir=mkdtempSync(join(tmpdir(),'daming-official-limits-'));
  const now=Date.UTC(2026,10,13,10);
  const store=new IdentityRegistry(dir,{
    protectMaster:(v:string)=>'fixture:'+v,
    unprotectMaster:(v:string)=>v.slice(8),clock:()=>now
  });
  const ledger=new TenantBudgetLedger(dir,()=>now);
  try {
    const opened=await store.setup({ username:'spendowner',
      password:'long-private-passphrase-for-test',
      tenantName:'Tenant P'});
    const owner=opened.session.identity;
    const created=store.createTenant(owner,'Tenant Q');
    const foreign=store.switchTenant(owner,created.tenantId,
      'daming_identity='+opened.cookie).session.identity;
    const requestId=randomUUID();
    store.beginOpenAiKeyIssuance(owner,{
      requestId,projectId,serviceAccountId:serviceId,modelId:'gpt-fixture'
    });
    const issued=store.completeOpenAiKeyIssuance(owner,requestId,{
      keyId,secret:'sk-service-issued-private-fixture',
      projectId,serviceAccountId:serviceId,
      issuedAtMs:now,expiresAtMs:now+3600000,
      officialProjectIssuanceVerified:true,
      vendorBillingOwnerVerified:false,invoiceReconciled:false,
      guaranteedCashCap:false,paidDispatchPermitted:false
    });
    ledger.configure(owner,{currency:'USD',perRequestMinor:50,perUtcDayMinor:80});
    ledger.preparePaid(owner,{
      requestId:randomUUID(),credentialId:issued.credentialId,
      provider:'openai',modelId:'gpt-fixture',currency:'USD',
      reservedMinor:40,payloadDigest:'a'.repeat(128)
    });
    const evidence=await readOpenAiSpendLimitState({
      projectId,adminKey:admin,nowMs:now
    },async (_,path)=>path.includes('/projects/')
      ? response('project','enforcing',2000)
      : response('organization','inactive',5000));
    const entry=store.recordOfficialOpenAiSpendLimit(owner,issued.credentialId,evidence);
    assert.equal(entry.monthlyProviderLimitObserved,true);
    assert.equal(entry.strictCashCapVerified,false);
    assert.equal(entry.automaticDispatchEnabled,false);
    const list=store.listOfficialOpenAiSpendLimits(owner);
    assert.equal(list.length,1);
    assert.equal(list[0].project.enforcementStatus,'enforcing');
    assert.equal(list[0].automaticDispatchEnabled,false);
    assert.deepEqual(store.listOfficialOpenAiSpendLimits(foreign),[]);
    assert.throws(()=>store.recordOfficialOpenAiSpendLimit(foreign,
      issued.credentialId,evidence),/openai_issued_key_not_found/);
    assert.equal(ledger.listPaid(owner)[0].status,'prepared');
    assert.equal(ledger.policy(owner,'USD')?.holdsAndSettledTodayMinor,40);
  }finally{
    store.close();ledger.close();
    rmSync(dir,{recursive:true,force:true,maxRetries:8,retryDelay:80});
  }
});
