/**
 * Official CNY peak rates inspected on 2026-11-12:
 * https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 * Expiry is deliberately short. A stale rate may NEVER authorize paid inference.
 * Search/Fetch have additional per-request charges, also covered by the rate card.
 */
export const DEEPSEEK_PEAK_CNY = Object.freeze({
  source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
  checkedAtMs: Date.parse('2026-11-12T00:00:00Z'),
  expiresMs: Date.parse('2026-11-13T00:00:00Z'),
  currency: 'CNY' as const,
  models: Object.freeze({
    'deepseek-flash': Object.freeze({ inputMissMinorPerMillion: 200, outputMinorPerMillion: 800 }),
    'deepseek-v4-pro': Object.freeze({ inputMissMinorPerMillion: 900, outputMinorPerMillion: 2700 })
  }),
  searchOrFetchMinorPerThousand: 500
});

export type DeepSeekPricedModel = keyof typeof DEEPSEEK_PEAK_CNY.models;

export const SMOKE_PRICE_BASIS = Object.freeze({
  id: 'deepseek-flash-2026-11-12-peak-cny-no-tools',
  source: DEEPSEEK_PEAK_CNY.source,
  verifiedAtMs: DEEPSEEK_PEAK_CNY.checkedAtMs,
  expiresMs: DEEPSEEK_PEAK_CNY.expiresMs,
  maximumInputTokens: 1048576,
  maximumOutputTokens: 128,
  inputMinorPerMillion: DEEPSEEK_PEAK_CNY.models['deepseek-flash'].inputMissMinorPerMillion,
  outputMinorPerMillion: DEEPSEEK_PEAK_CNY.models['deepseek-flash'].outputMinorPerMillion,
  maximumSearchRequests: 0,
  maximumFetchRequests: 0,
  budgetMinor: 500
});

function safeCount(value: unknown, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    throw new Error(label + '_invalid');
  }
  return value as number;
}

export function assertCurrentDeepSeekPrice(now = Date.now()): void {
  if (!Number.isSafeInteger(now) || now < DEEPSEEK_PEAK_CNY.checkedAtMs ||
      now >= DEEPSEEK_PEAK_CNY.expiresMs) {
    throw new Error('deepseek_price_basis_expired');
  }
}

/** Peak/no-cache advisory quote only. External CLI call count/tool usage are NOT hard bounded. */
export function quoteDeepSeekPeakCny(input: {
  model: DeepSeekPricedModel;
  inputTokens: number;
  outputTokens: number;
  searchRequests: number;
  fetchRequests: number;
}, now = Date.now()): {
  currency: 'CNY'; advisoryMinor: number; pricingModel: DeepSeekPricedModel;
  inputMinor: number; outputMinor: number; searchFetchMinor: number;
  rateExpiresMs: number; hardBound: false;
} {
  assertCurrentDeepSeekPrice(now);
  const rate = DEEPSEEK_PEAK_CNY.models[input.model];
  if (!rate) throw new Error('deepseek_model_price_unknown');
  const inputTokens = safeCount(input.inputTokens, 1048576, 'input_tokens');
  const outputTokens = safeCount(input.outputTokens, 384000, 'output_tokens');
  const searchRequests = safeCount(input.searchRequests, 1000000, 'search_requests');
  const fetchRequests = safeCount(input.fetchRequests, 1000000, 'fetch_requests');
  const inputMinor = Math.ceil(inputTokens * rate.inputMissMinorPerMillion / 1000000);
  const outputMinor = Math.ceil(outputTokens * rate.outputMinorPerMillion / 1000000);
  const searchFetchMinor = Math.ceil((searchRequests + fetchRequests) *
    DEEPSEEK_PEAK_CNY.searchOrFetchMinorPerThousand / 1000);
  return {
    currency: 'CNY', advisoryMinor: inputMinor + outputMinor + searchFetchMinor,
    pricingModel: input.model, inputMinor, outputMinor, searchFetchMinor,
    rateExpiresMs: DEEPSEEK_PEAK_CNY.expiresMs,
    hardBound: false // A CLI may issue additional model turns and billable tools.
  };
}

/** Existing gateway has independently validated one request, max_tokens=128 and no tools. */
export function checkSmokePrice(now = Date.now()) {
  assertCurrentDeepSeekPrice(now);
  const b = SMOKE_PRICE_BASIS;
  const maximumMinor = Math.ceil(
    (b.maximumInputTokens * b.inputMinorPerMillion +
      b.maximumOutputTokens * b.outputMinorPerMillion) / 1000000
  );
  if (maximumMinor > b.budgetMinor || b.maximumSearchRequests !== 0 ||
      b.maximumFetchRequests !== 0) {
    throw new Error('deepseek_smoke_budget_exceeded');
  }
  return { maximumMinor, budgetMinor: b.budgetMinor, priceBasisId: b.id };
}

/**
 * Usage-based post-call estimate, NEVER authoritative cash settlement.
 * Unknown DSH model is conservatively priced at V4 Pro peak, not Flash.
 * Search/Fetch requests may be omitted from CLI usage: reconcile with account balance.
 */
export function estimateDeepseekCashMinor(
  usage: Readonly<Record<string, number>> | undefined,
  model: DeepSeekPricedModel = 'deepseek-v4-pro'
): number | undefined {
  if (!usage) return undefined;
  const input = usage.inputTokens ?? usage.input_tokens;
  const output = usage.outputTokens ?? usage.output_tokens;
  if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output) || input! < 0 || output! < 0) return undefined;
  const rates = DEEPSEEK_PEAK_CNY.models[model];
  const tokenMinor = Math.ceil((input * rates.inputMissMinorPerMillion +
    output * rates.outputMinorPerMillion) / 1000000);
  const search = usage.searchRequests ?? usage.search_requests ?? 0;
  const fetchCount = usage.fetchRequests ?? usage.fetch_requests ?? 0;
  if (!Number.isSafeInteger(search) || !Number.isSafeInteger(fetchCount) || search < 0 || fetchCount < 0) {
    return undefined;
  }
  return tokenMinor + Math.ceil((search + fetchCount) *
    DEEPSEEK_PEAK_CNY.searchOrFetchMinorPerThousand / 1000);
}
