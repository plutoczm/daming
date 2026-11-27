import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectCodexSubscriptionBinding } from '../src/magpie-codex-subscription.ts';

const instance = 'a'.repeat(32);
const model = { id: 'codex/gpt-6.1-sol', provider: 'codex', name: 'GPT 6.1 sol' };
const account = { id: 'codex/0123456789abcdef', provider: 'codex', account: true, name: 'private@example.com', plan: 'private plan' };
test('native Codex subscription picker returns stable private binding without login identities', () => {
  const result = selectCodexSubscriptionBinding({ models: [model], accounts: [account] }, instance, 'gpt-6.1-sol');
  assert.deepEqual(result, { instanceId: instance, providerId: 'codex', modelId: 'gpt-6.1-sol',
    accountRef: '0123456789abcdef', accountKind: 'codex-subscription' });
  assert.doesNotMatch(JSON.stringify(result), /private|example|plan|name/);
});
test('subscription picker rejects wrong provider, group, API key, stale model and ambiguous accounts', () => {
  for (const raw of [
    {}, { models: [], accounts: [account] },
    { models: [model], accounts: [{ ...account, key: true }] },
    { models: [model], accounts: [{ ...account, provider: 'other' }] },
    { models: [{ ...model, group: true }], accounts: [account] },
    { models: [model], accounts: [account, { ...account, id: 'codex/abcdef0123456789' }] },
    { models: [model], accounts: [{ ...account, id: 'codex/private@example.com' }] }
  ]) assert.throws(() => selectCodexSubscriptionBinding(raw, instance, 'gpt-6.1-sol'));
  assert.throws(() => selectCodexSubscriptionBinding({ models:[model], accounts:[account] }, instance, '../gpt-6.1-sol'));
});
