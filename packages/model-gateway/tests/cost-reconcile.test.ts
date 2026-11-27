import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as api from '../src/index.ts';
const reconcile=(...args:unknown[])=>{const fn=(api as unknown as {reconcileUsage:(...args:unknown[])=>string}).reconcileUsage;assert.equal(typeof fn,'function');return fn(...args);};
test('usage reconciliation separates zero missing and conflict without creating cash',()=>{
 assert.equal(reconcile('responses',undefined,{inputTokens:0,outputTokens:0}),'missing');
 assert.equal(reconcile('responses',{inputTokens:0,outputTokens:0},{inputTokens:0,outputTokens:0}),'consistent');
 assert.equal(reconcile('responses',{inputTokens:10,outputTokens:2},{inputTokens:10,outputTokens:3}),'conflict');
});
test('invalid usage and Responses cache greater than total input are conflicts',()=>{
 for(const inputTokens of [-1,0.1,Number.MAX_SAFE_INTEGER+1])assert.equal(reconcile('responses',{inputTokens,outputTokens:0},{inputTokens,outputTokens:0}),'conflict');
 assert.equal(reconcile('responses',{inputTokens:2,outputTokens:0,cacheReadTokens:4},{inputTokens:2,outputTokens:0,cacheReadTokens:4}),'conflict');
 assert.equal(reconcile('messages',{inputTokens:2,outputTokens:0,cacheReadTokens:4},{inputTokens:2,outputTokens:0,cacheReadTokens:4}),'consistent');
});

test('contradictions outrank missing mandatory and optional counters',()=>{
 assert.equal(reconcile('responses',{outputTokens:99},{inputTokens:10,outputTokens:2}),'conflict');
 assert.equal(reconcile('messages',{inputTokens:10,outputTokens:2,cacheWriteTokens:9},{inputTokens:10,outputTokens:2,cacheReadTokens:4,cacheWriteTokens:1}),'conflict');
 assert.equal(reconcile('messages',undefined,{inputTokens:-1,outputTokens:2}),'conflict');
 assert.equal(reconcile('responses',{outputTokens:2},{inputTokens:10,outputTokens:2}),'missing');
});
