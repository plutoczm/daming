import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEEPSEEK_PEAK_CNY, SMOKE_PRICE_BASIS, assertCurrentDeepSeekPrice,
  checkSmokePrice, estimateDeepseekCashMinor, quoteDeepSeekPeakCny
} from '../src/deepseek-price.ts';

const inspected = Date.parse('2026-11-12T12:00:00Z');

test('official CNY peak pricing refresh is narrow, expiring, with the gateway one-call cap', () => {
  assert.equal(DEEPSEEK_PEAK_CNY.currency, 'CNY');
  assert.equal(DEEPSEEK_PEAK_CNY.models['deepseek-flash'].inputMissMinorPerMillion, 200);
  assert.equal(DEEPSEEK_PEAK_CNY.models['deepseek-flash'].outputMinorPerMillion, 800);
  assert.equal(DEEPSEEK_PEAK_CNY.models['deepseek-v4-pro'].inputMissMinorPerMillion, 900);
  assert.equal(DEEPSEEK_PEAK_CNY.models['deepseek-v4-pro'].outputMinorPerMillion, 2700);
  assert.equal(DEEPSEEK_PEAK_CNY.searchOrFetchMinorPerThousand, 500);
  assert.doesNotThrow(() => assertCurrentDeepSeekPrice(inspected));
  assert.throws(() => assertCurrentDeepSeekPrice(Date.parse('2026-11-11T23:59:59Z')), /expired/);
  assert.throws(() => assertCurrentDeepSeekPrice(Date.parse('2026-11-13T00:00:00Z')), /expired/);
  const limit = checkSmokePrice(inspected);
  assert.equal(limit.maximumMinor, 210);
  assert.equal(limit.budgetMinor, 500);
  assert.equal(limit.priceBasisId, SMOKE_PRICE_BASIS.id);
  assert.equal(SMOKE_PRICE_BASIS.maximumSearchRequests, 0);
  assert.equal(SMOKE_PRICE_BASIS.maximumFetchRequests, 0);
});

test('peak price quote includes separately billable Search/Fetch, but never claims a hard ceiling for CLI', () => {
  const quote = quoteDeepSeekPeakCny({
    model: 'deepseek-flash', inputTokens: 1000000, outputTokens: 100000,
    searchRequests: 1, fetchRequests: 1
  }, inspected);
  assert.equal(quote.currency, 'CNY');
  assert.equal(quote.inputMinor, 200);
  assert.equal(quote.outputMinor, 80);
  assert.equal(quote.searchFetchMinor, 1);
  assert.equal(quote.advisoryMinor, 281);
  assert.equal(quote.hardBound, false);
  const pro = quoteDeepSeekPeakCny({
    model: 'deepseek-v4-pro', inputTokens: 1000000, outputTokens: 100000,
    searchRequests: 0, fetchRequests: 0
  }, inspected);
  assert.equal(pro.advisoryMinor, 1170);
  assert.throws(() => quoteDeepSeekPeakCny({
    model: 'deepseek-unknown' as 'deepseek-flash', inputTokens: 1, outputTokens: 1,
    searchRequests: 0, fetchRequests: 0
  }, inspected), /unknown/);
  assert.throws(() => quoteDeepSeekPeakCny({
    model: 'deepseek-flash', inputTokens: -1, outputTokens: 1,
    searchRequests: 0, fetchRequests: 0
  }, inspected), /invalid/);
  assert.throws(() => quoteDeepSeekPeakCny({
    model: 'deepseek-flash', inputTokens: 1, outputTokens: 384001,
    searchRequests: 0, fetchRequests: 0
  }, inspected), /invalid/);
});

test('unknown DSH model usage is conservatively estimated at Pro peak with optional tool charges', () => {
  assert.equal(estimateDeepseekCashMinor({
    inputTokens: 1000000, outputTokens: 100000, searchRequests: 1, fetchRequests: 1
  }), 1171);
  assert.equal(estimateDeepseekCashMinor({
    inputTokens: 1000000, outputTokens: 100000, searchRequests: 1, fetchRequests: 1
  }, 'deepseek-flash'), 281);
  assert.equal(estimateDeepseekCashMinor(undefined), undefined);
  assert.equal(estimateDeepseekCashMinor({ inputTokens: 100, outputTokens: -1 }), undefined);
  assert.equal(estimateDeepseekCashMinor({ inputTokens: 100, outputTokens: 100, searchRequests: -1 }), undefined);
});
