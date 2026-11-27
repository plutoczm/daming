import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDeepSeekBalanceService } from '../src/deepseek-balance.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('DeepSeek balance service queries the official endpoint and parses CNY amounts', async () => {
  let seenUrl = '';
  let seenAuthorization = '';
  const service = createDeepSeekBalanceService(
    { DEEPSEEK_API_KEY: 'sk-test-key' },
    {
      now: () => Date.parse('2026-11-11T06:30:00.000Z'),
      fetchImpl: (async (input, init) => {
        seenUrl = String(input);
        seenAuthorization = new Headers(init?.headers).get('Authorization') ?? '';
        return jsonResponse({
          is_available: true,
          balance_infos: [
            { currency: 'USD', total_balance: '1.00', granted_balance: '0.00', topped_up_balance: '1.00' },
            { currency: 'CNY', total_balance: '9.87', granted_balance: '0.12', topped_up_balance: '9.75' }
          ]
        });
      }) as typeof fetch
    }
  );
  const view = await service.query();
  assert.equal(seenUrl, 'https://api.deepseek.com/user/balance');
  assert.equal(seenAuthorization, 'Bearer sk-test-key');
  assert.deepEqual(view, {
    configured: true, available: true, currency: 'CNY', totalMinor: 987,
    grantedMinor: 12, toppedUpMinor: 975, checkedAt: '2026-11-11T06:30:00.000Z'
  });
  assert.deepEqual(await service.snapshot(), { currency: 'CNY', totalMinor: 987 });
});

test('DeepSeek balance service reports unavailable states without leaking the key', async () => {
  const service = createDeepSeekBalanceService(
    { DEEPSEEK_API_KEY: 'sk-secret' },
    { fetchImpl: (async () => jsonResponse({ error: 'bad' }, 401)) as typeof fetch }
  );
  const view = await service.query();
  assert.equal(view.configured, true);
  assert.equal(view.available, false);
  assert.equal(view.reason, 'http_401');
  assert.ok(!JSON.stringify(view).includes('sk-secret'));
});

test('DeepSeek balance service is disabled without a key', async () => {
  const service = createDeepSeekBalanceService({});
  assert.equal(service.configured, false);
  assert.equal((await service.query()).reason, 'not_configured');
  assert.equal(await service.snapshot(), undefined);
});
