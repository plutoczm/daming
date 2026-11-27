import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeNpmPluginSpec, summarizeMagpieRead } from '../src/magpie-safe.ts';

test('Magpie provider summary exposes only sanitized IDs and aggregate account count', () => {
  const view = summarizeMagpieRead('providers', {
    providers: [{
      id: 'deepseek', name: 'alice@example.com', ready: true, off: false, exposed: 3,
      keyList: [{ key: 'sk-private', id: 'private-account' }, { token: 'secret' }],
      account: { email: 'alice@example.com', accessToken: 'must-never-leak' },
      headers: { Authorization: 'Bearer private-token' }
    }]
  });
  assert.equal(view.count, 1);
  assert.equal(view.items[0]?.id, 'deepseek');
  assert.equal(view.items[0]?.name, 'deepseek');
  assert.equal(view.items[0]?.status, 'ready');
  assert.match(view.items[0]?.detail ?? '', /2 个账号/);
  assert.doesNotMatch(JSON.stringify(view), /alice|example.com|private|secret|Bearer|sk-/i);
});

test('quota projection displays bounded numeric values without account identity or vendor errors', () => {
  const view = summarizeMagpieRead('quotas', [{
    provider: 'codex', user: 'secret@example.com', name: 'secret@example.com',
    kind: 'subscription', error: '', balance: 'private-wallet-id',
    windows: [{ name: 'Five hours', remaining: 37.33, resetsAt: '2026-11-12T03:00:00Z', display: 'very sensitive' }]
  }, {
    provider: 'workbuddy', kind: 'balance', error: 'secret-in-exception',
    windows: [{ remaining: 238, resetsAt: 'not-a-date' }]
  }]);
  assert.equal(view.count, 2);
  assert.equal(view.items[0]?.remainingPercent, 37.3);
  assert.equal(view.items[0]?.resetsAt, '2026-11-12T03:00:00.000Z');
  assert.equal(view.items[1]?.remainingPercent, undefined);
  assert.equal(view.items[1]?.status, 'error');
  assert.doesNotMatch(JSON.stringify(view), /secret|wallet|very sensitive|example.com/i);
});

test('plugin projection exposes vetted package specs and status but no arbitrary Git URLs or options', () => {
  const view = summarizeMagpieRead('plugins', {
    plugins: [
      { spec: '@safe/plugins', ownName: 'Trusted Tools', off: false, version: '1.2.3', latest: '1.2.4', options: { apiKey: 'private-secret' }, providers: ['demo'] },
      { spec: 'https://user:secret@example.com/private.git', package: 'git-private-plugin', off: true }
    ]
  });
  assert.equal(view.count, 2);
  assert.equal(view.items[0]?.installedSpec, '@safe/plugins');
  assert.equal(view.items[0]?.version, '1.2.3');
  assert.equal(view.items[1]?.installedSpec, undefined);
  assert.equal(view.items[1]?.status, 'disabled');
  assert.doesNotMatch(JSON.stringify(view), /user:|secret|example.com|apiKey/i);
  assert.equal(safeNpmPluginSpec('@safe/plugins'), true);
  assert.equal(safeNpmPluginSpec('@magpie-community/opencode-workbuddy-auth@latest'), true);
  const tagged = summarizeMagpieRead('plugins', { plugins: [{ spec: '@magpie-community/opencode-workbuddy-auth@latest', version: '0.2.27', off: false }] });
  assert.equal(tagged.items[0]?.name, 'opencode-workbuddy-auth');
  assert.equal(tagged.items[0]?.installedSpec, '@magpie-community/opencode-workbuddy-auth@latest');
  assert.equal(safeNpmPluginSpec('https://example.com/a'), false);
  assert.equal(safeNpmPluginSpec('../unsafe'), false);
});
