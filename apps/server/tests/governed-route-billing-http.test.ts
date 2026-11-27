import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startBoardHost } from '../src/http.ts';
import { totpCode } from '../src/totp.ts';
import type { MagpieHost } from '../src/magpie-host.ts';

type Auth={cookie:string;csrf:string};
const ADMIN='sk-test-admin-no-network-2026';
const SECRET='sk-local-issued-project-key-2026';
const BYOA='sk-local-deepseek-test-key-2026';
const PROJECT='proj_daming2026';
const KEY='key_daming2026';
const SERVICE='svc_acct_daming2026';

async function call(host:Awaited<ReturnType<typeof startBoardHost>>,
  path:string,method='GET',body?:unknown,auth?:Auth) {
  const res=await fetch(host.url+path,{
    method,headers:{
      ...(auth?{cookie:auth.cookie}:{}),
      ...(method==='GET'?{}:{
        origin:new URL(host.url).origin,
        'content-type':'application/json',
        ...(auth?{'x-daming-csrf':auth.csrf}:{})
      })
    },
    ...(method==='GET'?{}:{body:JSON.stringify(body??{})}),
    redirect:'manual'
  });
  let data:Record<string,unknown>={};
  try {data=await res.json() as Record<string,unknown>;}catch{}
  return {status:res.status,data,
    cookie:res.headers.getSetCookie()[0]?.split(';')[0]??''};
}

test('HTTP Magpie route planning and issued-key official daily costs: scoped and no paid release',async t=>{
  const base=mkdtempSync(join(tmpdir(),'daming-agent-cost-http-'));
  const web=join(base,'web');mkdirSync(web);
  writeFileSync(join(web,'index.html'),'<title>Isolated test</title>');
  let catalogReads=0, officialReads=0, issuanceMutations=0, limitReads=0;
  const host=await startBoardHost({
    dataDir:join(base,'data'),webRoot:web,port:0,
    bootstrapToken:'offline-router-bootstrap-2026',
    magpie:{
      async ensure(){return {running:true,configured:true,enabled:true,
        version:'mock',checkedAt:new Date().toISOString()};},
      async status(){return {running:true,configured:true,enabled:true,
        version:'mock',checkedAt:new Date().toISOString()};},
      async unifiedTargets(){
        catalogReads++;
        return {
          source:'magpie-native-routing' as const,
          checkedAt:new Date().toISOString(),
          dispatchEnabled:false as const,managesCredentialsInMagpie:true as const,
          targets:[
            {targetId:'codex/gpt-6',kind:'agent-backed' as const,providerId:'codex',
              label:'Codex Subscription',members:1,ready:true as const},
            {targetId:'group/fast',kind:'route-group' as const,providerId:null,
              label:'Auto Group',members:3,ready:true as const},
            {targetId:'deepseek/deepseek-flash',kind:'llm' as const,providerId:'deepseek',
              label:'DeepSeek API',members:1,ready:true as const}
          ]
        };
      },
      async read(){throw new Error('no shared Magpie reads');},
      async post(){throw new Error('no shared Magpie writes');},
      stop(){}
    } as MagpieHost,
    identityProofTest:{
      verifyVendor:async (_,key,model)=>key===BYOA&&model==='deepseek-flash',
      matchMagpie:async()=>false
    },
    openAiKeyIssuanceTest:async (method,path,key,body)=>{
      assert.equal(key,ADMIN);
      if(method==='GET'&&path.endsWith('/'+PROJECT))
        return {object:'organization.project',id:PROJECT};
      if(method==='GET'&&path.endsWith('/'+SERVICE))
        return {object:'organization.project.service_account',
          id:SERVICE,role:'member'};
      if(method==='POST'&&path.endsWith('/api_keys')){
        issuanceMutations++;
        assert.equal(body?.expires_in_seconds,3600);
        return {object:'organization.project.service_account.api_key',
          id:KEY,value:SECRET,
          created_at:Math.floor(Date.now()/1000),
          expires_at:Math.floor(Date.now()/1000)+3600};
      }
      throw new Error('unexpected admin endpoint');
    },
    identityBillingReadTest:async (hostname,path,key)=>{
      assert.equal(hostname,'api.openai.com');
      assert.equal(key,ADMIN);
      if (path.endsWith('/spend_limit')) {
        limitReads++;
        const project = path.includes('/projects/');
        return { object:project?'project.spend_limit':'organization.spend_limit',
          threshold_amount:project?750:2000,currency:'USD',
          interval:'month',enforcement:{status:project?'enforcing':'inactive'} };
      }
      officialReads++;
      if(!path.includes('/costs'))return {object:'organization.project',id:PROJECT};
      const u=new URL('https://api.openai.com'+path);
      assert.equal(u.searchParams.get('project_ids[]'),PROJECT);
      assert.equal(u.searchParams.get('api_key_ids[]'),KEY);
      assert.deepEqual(u.searchParams.getAll('group_by[]'),['project_id','api_key_id']);
      const start=Number(u.searchParams.get('start_time'));
      return {object:'page',has_more:false,next_page:null,data:[{
        object:'bucket',start_time:start,end_time:start+86400,
        results:[{object:'organization.costs.result',project_id:PROJECT,
          api_key_id:KEY,line_item:'text_usage',
          amount:{currency:'usd',value:0.012345}}]
      }]};
    }
  });
  t.after(async()=>{
    await host.close();
    rmSync(base,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  });
  const opened=await fetch(host.url+'?token=offline-router-bootstrap-2026',
    {redirect:'manual'});
  const bootstrap=opened.headers.getSetCookie()[0].split(';')[0];
  const session=await call(host,'api/session','GET',undefined,{cookie:bootstrap,csrf:''});
  const setup=await call(host,'api/identity/setup','POST',{
    username:'ownerroute',password:'password-for-router-safety-2026',
    tenantName:'Tenant A'
  },{cookie:bootstrap,csrf:String(session.data.csrfToken)});
  assert.equal(setup.status,200);
  const owner:Auth={cookie:setup.cookie,csrf:String(setup.data.csrfToken)};
  assert.equal((await call(host,'api/identity/agent-runtime/governed-capabilities',
    'GET',undefined,owner)).status,403);
  const started=await call(host,'api/identity/mfa/begin','POST',{
    password:'password-for-router-safety-2026'
  },owner);
  assert.equal(started.status,200);
  const confirmed=await call(host,'api/identity/mfa/confirm','POST',{
    code:totpCode(String(started.data.secret),Math.floor(Date.now()/30000))
  },owner);
  assert.equal(confirmed.status,200);
  const status=await call(host,'api/identity/agent-runtime/governed-capabilities',
    'GET',undefined,owner);
  assert.equal(status.status,200);
  assert.equal(status.data.productionMultiturnPaidExecution,false);
  assert.equal(status.data.exactVendorCashHardCapGuaranteed,false);
  assert.equal((await call(host,'api/identity/agent-runtime/governed-route-plan',
    'POST',{preferredTargets:[]},owner)).status,200);
  const added=await call(host,'api/identity/tenant-accounts','POST',{
    provider:'deepseek',modelId:'deepseek-flash',apiKey:BYOA,label:'Owned key'
  },owner);
  assert.equal(added.status,201,JSON.stringify(added.data));
  const selected=await call(host,'api/identity/agent-runtime/governed-route-plan',
    'POST',{preferredTargets:[]},owner);
  assert.equal(selected.status,200,JSON.stringify(selected.data));
  const route=selected.data.selected as {targetId:string;credentialId:string};
  assert.equal(route.targetId,'deepseek/deepseek-flash');
  assert.equal(route.credentialId,added.data.credentialId);
  const candidates=selected.data.candidates as {kind:string;eligibility:string}[];
  assert.ok(candidates.some(x=>x.kind==='agent-backed' &&
    x.eligibility==='subscription_agent_requires_native_isolation_and_entitlement'));
  assert.ok(candidates.some(x=>x.kind==='route-group' &&
    x.eligibility==='native_group_requires_final_account_receipt'));
  assert.equal(selected.data.paidDispatchPermitted,false);
  assert.equal(catalogReads,2);
  // Production evidence is calculated by Host, not set by a client-supplied
  // success flag. Its GET must neither send inference nor unlock anything.
  const proof=await call(host,
    'api/identity/agent-runtime/production-proof?credentialId='+added.data.credentialId,
    'GET',undefined,owner);
  assert.equal(proof.status,200,JSON.stringify(proof.data));
  assert.equal(proof.data.productionPaidDispatchApproved,false);
  assert.equal(proof.data.nativeSubscriptionExecutionApproved,false);
  assert.equal(proof.data.authoritativeInvoiceSettlementApproved,false);
  assert.equal(proof.data.strictPerRequestCashCapApproved,false);
  assert.equal(proof.data.realVendorInferencePerformedByThisCheck,false);
  assert.equal(proof.data.vendorCredentialsAccessedByThisCheck,false);
  assert.equal(proof.data.unknownHoldsReleasedByThisCheck,false);
  const proofItems=proof.data.items as {code:string;state:string}[];
  assert.equal(proofItems.find(x=>x.code==='exact_tenant_model_key')?.state,'verified');
  assert.equal(proofItems.find(x=>x.code==='fresh_real_docker_isolation')?.state,'blocked');
  assert.equal(proofItems.find(x=>x.code==='per_request_authoritative_cash_invoice')?.state,'unavailable');
  assert.ok(!JSON.stringify(proof.data).includes(BYOA));
  assert.equal((await call(host,
    'api/identity/agent-runtime/production-proof?credentialId=bad-id',
    'GET',undefined,owner)).status,400);

  const absent=await call(host,'api/identity/billing/issued-key-daily-costs',
    'POST',{credentialId:randomUUID(),adminKey:ADMIN,
      confirmation:'READ_OFFICIAL_KEY_SCOPED_COSTS'},owner);
  assert.equal(absent.status,404);
  assert.equal(officialReads,0);
  const issued=await call(host,'api/identity/openai/issue-service-key','POST',{
    requestId:randomUUID(),projectId:PROJECT,serviceAccountId:SERVICE,
    modelId:'gpt-6-luna',adminKey:ADMIN,
    confirmation:'CREATE_1_HOUR_OPENAI_SERVICE_KEY'
  },owner);
  assert.equal(issued.status,201,JSON.stringify(issued.data));
  assert.equal(issuanceMutations,1);
  assert.ok(!JSON.stringify(issued.data).includes(SECRET));
  const read=await call(host,'api/identity/billing/issued-key-daily-costs',
    'POST',{credentialId:issued.data.credentialId,adminKey:ADMIN,
      confirmation:'READ_OFFICIAL_KEY_SCOPED_COSTS'},owner);
  assert.equal(read.status,201,JSON.stringify(read.data));
  assert.equal(read.data.costMicroUsd,12345);
  assert.equal(read.data.singleRequestSettled,false);
  assert.equal(read.data.cashHoldReleased,false);
  assert.equal(read.data.monthlyProviderHardLimitVerified,false);
  assert.equal(officialReads,2);
  assert.ok(!JSON.stringify(read.data).includes(KEY));
  const observations=await call(host,'api/identity/billing/issued-key-daily-costs',
    'GET',undefined,owner);
  assert.equal((observations.data.observations as unknown[]).length,1);
  assert.equal(observations.data.authenticatedVendorInvoice,false);
  const limits=await call(host,'api/identity/billing/official-spend-limits','POST',{
    credentialId:issued.data.credentialId,adminKey:ADMIN,
    confirmation:'READ_OFFICIAL_MONTHLY_LIMITS'
  },owner);
  assert.equal(limits.status,201,JSON.stringify(limits.data));
  assert.equal(limits.data.providerMonthlyEnforcementVerified,true);
  assert.equal(limits.data.effectiveMonthlyThresholdMinor,750);
  assert.equal(limits.data.limitMayOvershoot,true);
  assert.equal(limits.data.exactPerRequestCashCapVerified,false);
  assert.equal(limits.data.automaticDispatchEnabled,false);
  assert.equal(limitReads,2);
  const recorded=await call(host,'api/identity/billing/official-spend-limits',
    'GET',undefined,owner);
  assert.equal((recorded.data.observations as unknown[]).length,1);
  assert.equal(recorded.data.strictPerRequestCashCapGuaranteed,false);
  assert.ok(!JSON.stringify(recorded.data).includes(ADMIN));
  assert.ok(!JSON.stringify(recorded.data).includes(KEY));

  const other=await call(host,'api/identity/tenants','POST',{name:'Tenant B'},owner);
  const switched=await call(host,'api/identity/switch-tenant','POST',
    {tenantId:other.data.tenantId},owner);
  const b:Auth={cookie:switched.cookie,csrf:String(switched.data.csrfToken)};
  assert.equal((await call(host,
    'api/identity/agent-runtime/production-proof?credentialId='+added.data.credentialId,
    'GET',undefined,b)).status,404, 'other tenant must not inspect account proof');
  assert.equal((await call(host,
    'api/identity/agent-runtime/production-proof','GET',undefined,b)).data.productionPaidDispatchApproved,
    false);
  assert.deepEqual((await call(host,'api/identity/billing/issued-key-daily-costs',
    'GET',undefined,b)).data.observations,[]);
  assert.deepEqual((await call(host,'api/identity/billing/official-spend-limits',
    'GET',undefined,b)).data.observations,[]);
  assert.equal((await call(host,'api/identity/billing/official-spend-limits',
    'POST',{credentialId:issued.data.credentialId,adminKey:ADMIN,
      confirmation:'READ_OFFICIAL_MONTHLY_LIMITS'},b)).status,404);
  assert.equal(limitReads,2);
  assert.equal((await call(host,'api/identity/billing/issued-key-daily-costs',
    'POST',{credentialId:issued.data.credentialId,adminKey:ADMIN,
      confirmation:'READ_OFFICIAL_KEY_SCOPED_COSTS'},b)).status,404);
  assert.equal((await call(host,'api/identity/agent-runtime/governed-route-plan',
    'POST',{preferredTargets:[]},b)).status,200,
    'root owner can inspect the global catalog but cannot borrow tenant A credential');
  assert.equal(officialReads,2);
  assert.equal(issuanceMutations,1);
});
