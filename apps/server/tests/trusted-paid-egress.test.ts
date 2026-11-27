import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { IdentityRegistry } from '../src/identity-registry.ts';
import { TenantBudgetLedger } from '../src/tenant-budget.ts';
import { TrustedPaidEgress, officialPaidModelTransport } from '../src/trusted-paid-egress.ts';

const vaultOptions = { protectMaster: (value: string) => 'local:' + value,
  unprotectMaster: (value: string) => value.slice(6) };
const secret = 'sk-test-private-egress-secret-never-outside-host-2026';

test('trusted broker keeps real tenant vault secret in Host; no replay or unverified refund', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daming-egress-'));
  const registry = new IdentityRegistry(dir, vaultOptions);
  let ledger = new TenantBudgetLedger(dir);
  try {
    const opened = await registry.setup({
      username: 'owner2026', password: 'credential-owner-long-password-2026',
      tenantName: 'Alpha'
    });
    const owner = opened.session.identity;
    const childTenant = registry.createTenant(owner, 'Bravo');
    const other = registry.switchTenant(owner, childTenant.tenantId,
      'daming_identity=' + opened.cookie).session.identity;
    const account = registry.registerIndependentAccount(owner, {
      provider: 'deepseek', modelId: 'deepseek-flash', apiKey: secret,
      label: 'Private key'
    });
    ledger.configure(owner, { currency: 'CNY', perRequestMinor: 400, perUtcDayMinor: 500 });
    ledger.configure(other, { currency: 'CNY', perRequestMinor: 100, perUtcDayMinor: 100 });
    const requestId = randomUUID();
    const input = {
      requestId, credentialId: account.credentialId, currency: 'CNY' as const,
      reservedMinor: 400, prompt: 'Summarize once', maxOutputTokens: 32
    };
    let vendorCalls = 0, runnerCalls = 0;
    const runner = async (job: { requestId: string; prompt: string },
      callback: () => Promise<{ text: string }>) => {
      runnerCalls++;
      assert.equal(job.requestId, requestId);
      assert.equal(job.prompt, input.prompt);
      assert.ok(!JSON.stringify(job).includes(secret));
      return (await callback()).text;
    };
    const transport = async (request: {
      provider: string; modelId: string; apiKey: string; prompt: string; maxOutputTokens: number
    }) => {
      vendorCalls++;
      assert.equal(request.provider, 'deepseek');
      assert.equal(request.modelId, 'deepseek-flash');
      assert.equal(request.apiKey, secret);
      assert.equal(request.prompt, input.prompt);
      assert.equal(request.maxOutputTokens, 32);
      return { text: 'Broker replied once', inputTokens: 9, outputTokens: 5 };
    };
    const broker = new TrustedPaidEgress(registry, ledger, true, transport, runner);
    assert.throws(() => broker.prepare(other, input), /tenant_egress_account_unverified_or_expired/);
    assert.equal(broker.prepare(owner, input).status, 'prepared');
    assert.equal(broker.prepare(owner, input).status, 'prepared');
    assert.equal(ledger.policy(owner, 'CNY')?.holdsAndSettledTodayMinor, 400);
    assert.throws(() => broker.prepare(owner, { ...input, prompt: 'different' }),
      /paid_egress_request_conflict/);
    const disabled = new TrustedPaidEgress(registry, ledger, false, transport, runner);
    await assert.rejects(disabled.execute(owner, input), /trusted_paid_egress_disabled/);
    assert.equal(vendorCalls, 0);
    const completed = await broker.execute(owner, input);
    assert.equal(completed.text, 'Broker replied once');
    assert.equal(completed.inputTokens, 9);
    assert.equal(completed.outputTokens, 5);
    assert.equal(completed.attempt.status, 'uncertain');
    assert.equal(completed.chargedMinor, null);
    assert.equal(completed.vendorInvoiceVerified, false);
    assert.equal(completed.vendorHardCapGuaranteed, false);
    assert.equal(completed.agentReceivedApiKey, false);
    assert.equal(vendorCalls, 1);
    assert.equal(runnerCalls, 1);
    assert.ok(!JSON.stringify(completed).includes(secret));
    await assert.rejects(broker.execute(owner, input), /paid_egress_already_claimed/);
    assert.equal(vendorCalls, 1);
    assert.throws(() => ledger.cancelPaidBeforeSend(owner, requestId), /paid_egress_cannot_release/);
    assert.throws(() => broker.prepare(owner, {
      ...input, requestId: randomUUID(), reservedMinor: 50
    }), /paid_egress_budget_denied/);
    ledger.close();
    ledger = new TenantBudgetLedger(dir);
    assert.equal(ledger.listPaid(owner)[0].status, 'uncertain');
    assert.equal(ledger.policy(owner, 'CNY')?.canReservePreview, false);
    assert.ok(!readFileSync(join(dir, 'identities.db')).includes(Buffer.from(secret)));
  } finally {
    ledger.close(); registry.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('cash-unknown after a synthetic accepted error prevents retries across currencies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daming-egress-error-'));
  const registry = new IdentityRegistry(dir, vaultOptions);
  const ledger = new TenantBudgetLedger(dir);
  try {
    const principal = (await registry.setup({
      username: 'ownererror', password: 'long-password-for-error-check',
      tenantName: 'Firm'
    })).session.identity;
    const account = registry.registerIndependentAccount(principal, {
      provider: 'openai', modelId: 'gpt-4o-mini', apiKey: secret, label: 'OpenAI'
    });
    ledger.configure(principal, { currency: 'USD', perRequestMinor: 200, perUtcDayMinor: 300 });
    ledger.configure(principal, { currency: 'CNY', perRequestMinor: 200, perUtcDayMinor: 300 });
    let requests = 0;
    const broker = new TrustedPaidEgress(registry, ledger, true,
      async () => {
        requests++;
        throw new Error('synthetic connection lost AFTER vendor accepted request');
      }, async (_, callback) => (await callback()).text);
    const input = {
      requestId: randomUUID(), credentialId: account.credentialId,
      currency: 'USD' as const, reservedMinor: 150,
      prompt: 'One short request', maxOutputTokens: 12
    };
    broker.prepare(principal, input);
    await assert.rejects(broker.execute(principal, input), /synthetic connection lost/);
    assert.equal(requests, 1);
    assert.equal(ledger.listPaid(principal)[0].status, 'uncertain');
    assert.equal(ledger.policy(principal, 'CNY')?.canReservePreview, false);
    await assert.rejects(broker.execute(principal, input), /paid_egress_already_claimed/);
    assert.equal(requests, 1);
  } finally {
    ledger.close(); registry.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('official transport rejects unapproved key, host-independent inputs before HTTPS', async () => {
  await assert.rejects(officialPaidModelTransport({
    provider: 'openai', modelId: 'gpt-4o-mini', apiKey: 'sk-\r\ninjection',
    prompt: 'hello', maxOutputTokens: 12
  }), /trusted_vendor_input_invalid/);
  await assert.rejects(officialPaidModelTransport({
    provider: 'deepseek', modelId: 'https://evil.test/x', apiKey: secret,
    prompt: 'hello', maxOutputTokens: 12
  }), /trusted_vendor_input_invalid/);
  await assert.rejects(officialPaidModelTransport({
    provider: 'deepseek', modelId: 'deepseek-flash', apiKey: secret,
    prompt: 'hello', maxOutputTokens: 99999
  }), /trusted_vendor_input_invalid/);
});

const optInDocker = process.platform === 'win32' &&
  process.env.DAMING_VALIDATE_DOCKER_AGENT === '1';
test('actual networkless Docker Agent invokes a Host-only synthetic vendor bridge', {
  skip: optInDocker ? false : 'needs Docker Desktop and explicit opt-in'
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daming-egress-real-docker-'));
  const registry = new IdentityRegistry(dir, vaultOptions);
  const ledger = new TenantBudgetLedger(dir);
  try {
    const principal = (await registry.setup({
      username: 'ownerbridge', password: 'long-password-for-docker-bridge',
      tenantName: 'Test'
    })).session.identity;
    const account = registry.registerIndependentAccount(principal, {
      provider: 'deepseek', modelId: 'deepseek-flash',
      apiKey: secret, label: 'Synthetic key'
    });
    ledger.configure(principal, { currency: 'CNY', perRequestMinor: 200, perUtcDayMinor: 200 });
    const input = {
      requestId: randomUUID(), credentialId: account.credentialId,
      currency: 'CNY' as const, reservedMinor: 100,
      prompt: '离线容器中的 Agent 请求', maxOutputTokens: 16
    };
    let called = 0;
    const broker = new TrustedPaidEgress(registry, ledger, true,
      async payload => {
        called++;
        assert.equal(payload.apiKey, secret);
        return { text: '来自受信 Host 的响应', inputTokens: 12, outputTokens: 7 };
      });
    broker.prepare(principal, input);
    const result = await broker.execute(principal, input);
    assert.equal(result.text, '来自受信 Host 的响应');
    assert.equal(called, 1);
    assert.equal(result.attempt.status, 'uncertain');
  } finally {
    ledger.close(); registry.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
