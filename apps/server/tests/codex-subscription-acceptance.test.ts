import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '@daming/core';
import { SqliteStore } from '@daming/store-sqlite';
import { CodexSubscriptionAcceptance, CODEX_SUBSCRIPTION_ACCEPTANCE_TASK } from '../src/codex-subscription-acceptance.ts';

const binding = { instanceId:'a'.repeat(32), providerId:'codex', modelId:'gpt-6.1-sol',
  accountRef:'0123456789abcdef', accountKind:'codex-subscription' as const };
test('one manual subscription acceptance reserves before execute and keeps unknown cash after a successful text', async t => {
  const root = mkdtempSync(join(tmpdir(),'daming subscription acceptance '));
  const store = new SqliteStore(join(root,'tasks.sqlite'));
  t.after(() => { store.close(); rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}); });
  const engine = new Engine(store);
  let sends = 0;
  const run = async () => {
    sends++;
    assert.equal(store.governanceGet('budgets',CODEX_SUBSCRIPTION_ACCEPTANCE_TASK)?.heldMinor,500);
    assert.equal(store.governanceList('approvals',CODEX_SUBSCRIPTION_ACCEPTANCE_TASK)[0].status,'consumed');
    return { status:'completed' as const,exitCode:0,output:'OK',events:[],usage:{input_tokens:7,output_tokens:1} };
  };
  const acceptance = new CodexSubscriptionAcceptance(store,engine,binding,run);
  acceptance.prepare();
  assert.equal(sends,0);
  assert.equal(engine.getTask(CODEX_SUBSCRIPTION_ACCEPTANCE_TASK)?.status,'awaiting_approval');
  await assert.rejects(acceptance.authorizeAndRun(499),/approval/);
  assert.equal(sends,0);
  const result = await acceptance.authorizeAndRun(500);
  assert.equal(sends,1);
  assert.equal(result.modelStatus,'completed');
  assert.equal(result.output,'OK');
  assert.equal(result.taskStatus,'blocked');
  assert.equal(result.cashHeldMinor,500);
  assert.equal(result.cashChargedMinor,null);
  assert.equal(store.governanceList('reservations',CODEX_SUBSCRIPTION_ACCEPTANCE_TASK)[0].status,'unknown');
  await assert.rejects(acceptance.authorizeAndRun(500),/already/);
  assert.throws(() => new CodexSubscriptionAcceptance(store,engine,binding,run).prepare(),/already/);
  assert.equal(sends,1);
});

test('a crash or thrown request cannot release the reservation or enable replay', async t => {
  const root = mkdtempSync(join(tmpdir(),'daming subscription crash '));
  const file = join(root,'tasks.sqlite');
  let store = new SqliteStore(file);
  t.after(() => { store.close(); rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}); });
  let calls = 0;
  const run = async (): Promise<never> => { calls++; throw new Error('private token must not escape'); };
  const acceptance = new CodexSubscriptionAcceptance(store,new Engine(store),binding,run);
  acceptance.prepare();
  const result = await acceptance.authorizeAndRun(500);
  assert.equal(result.taskStatus,'blocked');
  assert.equal(result.cashHeldMinor,500);
  assert.doesNotMatch(JSON.stringify(result),/private token/);
  store.close(); store = new SqliteStore(file);
  assert.throws(() => new CodexSubscriptionAcceptance(store,new Engine(store),binding,run).prepare(),/already/);
  assert.equal(calls,1);
});
