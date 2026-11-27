import assert from 'node:assert/strict';
import { test } from 'node:test';
import { probeDeepSeekBalance, probeOpenAiProjectCost, BillingProbeError } from '../src/vendor-billing-readonly.ts';
import type { OfficialReadTransport } from '../src/vendor-billing-readonly.ts';

const adminKey = 'fixture-admin-key-not-real-2026';
const modelKey = 'fixture-model-key-not-real-2026';
const projectId = 'proj_fixture_001';
const now = Date.UTC(2026, 10, 12, 12, 0, 0);

test('official DeepSeek balance: fixed host, exact money amounts, no invoice/cap claims', async () => {
  const calls: string[] = [];
  const read: OfficialReadTransport = async (host, path, secret) => {
    calls.push(host + path);
    assert.equal(secret, modelKey);
    return { is_available: true, balance_infos: [
      { currency: 'CNY', total_balance: '110.05', granted_balance: '10.05',
        topped_up_balance: '100.00' },
      { currency: 'USD', total_balance: '0.15', granted_balance: '0.00',
        topped_up_balance: '0.15' }
    ] };
  };
  const result = await probeDeepSeekBalance(modelKey, read);
  assert.deepEqual(calls, ['api.deepseek.com/user/balance']);
  assert.deepEqual(result.amounts, [
    { currency: 'CNY', minor: 11005 },
    { currency: 'USD', minor: 15 }
  ]);
  assert.equal(result.administratorReadAccess, false);
  assert.equal(result.billingOwnerVerified, false);
  assert.equal(result.modelKeyProjectLinkVerified, false);
  assert.equal(result.vendorInvoiceVerified, false);
  assert.equal(result.perRequestCashCapGuaranteed, false);
  assert.equal(result.productionDispatchEnabled, false);
  await assert.rejects(probeDeepSeekBalance(modelKey, async () => ({
    is_available: true, balance_infos: [{
      currency: 'CNY', total_balance: '1.001', granted_balance: '0.00',
      topped_up_balance: '1.00'
    }]
  })), /balance_amount_invalid/);
  await assert.rejects(probeDeepSeekBalance(modelKey, async () => ({
    is_available: true, balance_infos: [{
      currency: 'USD', total_balance: '99.00', granted_balance: '1.00',
      topped_up_balance: '1.00'
    }]
  })), /vendor_balance_inconsistent/);
  await assert.rejects(probeDeepSeekBalance(modelKey, async () => ({
    is_available: true, balance_infos: []
  })), /vendor_balance_schema_invalid/);
});

test('OpenAI Admin API project costs: read only, project filtered, full UTC day and incomplete pages fail closed', async () => {
  const start = Date.UTC(2026, 10, 11) / 1000;
  const end = Date.UTC(2026, 10, 12) / 1000;
  const calls: string[] = [];
  const read: OfficialReadTransport = async (hostname, path, key) => {
    assert.equal(hostname, 'api.openai.com');
    assert.equal(key, adminKey);
    calls.push(path);
    if (path.includes('/projects/')) return {
      id: projectId, object: 'organization.project', name: 'Fixture'
    };
    assert.equal(path.split('?')[0], '/v1/organization/costs');
    const search = new URLSearchParams(path.split('?')[1]);
    assert.equal(search.get('start_time'), String(start));
    assert.equal(search.get('end_time'), String(end));
    assert.equal(search.get('project_ids[]'), projectId);
    assert.equal(search.get('group_by[]'), 'project_id');
    return { object: 'page', has_more: false, next_page: null,
      data: [{
        object: 'bucket', start_time: start, end_time: end,
        results: [{
          object: 'organization.costs.result', project_id: projectId,
          amount: { currency: 'usd', value: 1.234 }
        }]
      }]
    };
  };
  const observed = await probeOpenAiProjectCost(adminKey, projectId, now, read);
  assert.equal(calls.length, 2);
  assert.equal(calls[0], '/v1/organization/projects/' + projectId);
  assert.deepEqual(observed.amounts, [{ currency: 'USD', minor: 124 }]);
  assert.equal(observed.administratorReadAccess, true);
  assert.equal(observed.billingOwnerVerified, false);
  assert.equal(observed.vendorInvoiceVerified, false);
  assert.equal(observed.modelKeyProjectLinkVerified, false);
  assert.equal(observed.perRequestCashCapGuaranteed, false);
  assert.equal(observed.productionDispatchEnabled, false);
  const badRead = async (_host: string, path: string) => path.includes('/projects/')
    ? { id: projectId, object: 'organization.project' }
    : { object: 'page', has_more: false, next_page: null,
        data: [{ object: 'bucket', start_time: start, end_time: end,
          results: [{
            object: 'organization.costs.result', project_id: 'proj_OTHER',
            amount: { currency: 'usd', value: 0.01 }
          }]
        }] };
  await assert.rejects(probeOpenAiProjectCost(adminKey, projectId, now,
    badRead as OfficialReadTransport), /openai_cost_not_project_scoped/);
  await assert.rejects(probeOpenAiProjectCost(adminKey, 'https://malicious.local', now, read),
    /openai_billing_request_invalid/);
  await assert.rejects(probeOpenAiProjectCost(adminKey, projectId, now,
    (async () => ({ id: 'proj_wrong', object: 'organization.project' })) as OfficialReadTransport),
  /openai_project_admin_access_unverified/);
  await assert.rejects(probeOpenAiProjectCost(adminKey, projectId, now,
    (async (_host: string, path: string) => path.includes('/projects/')
      ? { id: projectId, object: 'organization.project' }
      : { object: 'page', has_more: true, next_page: 'next',
          data: [] }) as OfficialReadTransport), /openai_cost_page_incomplete/);
});
