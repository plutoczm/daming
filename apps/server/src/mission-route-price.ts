/**
 * Offline-only fixed-route price ceiling.
 * A snapshot is not a vendor spending cap. The caller must also enforce
 * max input/output tokens and prevent tools, retries and other billable routes.
 * Never accept this structure from HTTP as a trusted price authority.
 */
export interface SyntheticRoutePriceBasis {
  readonly source: 'synthetic_fixture';
  readonly id: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly verifiedAtMs: number;
  readonly expiresAtMs: number;
  readonly inputMinorPerMillion: number;
  readonly outputMinorPerMillion: number;
  readonly maximumInputTokens: number;
  readonly nonTokenMaximumMinor: 0;
}
export interface SyntheticRouteQuote {
  readonly ceilingMinor: number;
  readonly source: 'synthetic_fixture';
  readonly dispatchPermitted: false;
  readonly hardVendorCashCap: false;
  readonly expiresAtMs: number;
  readonly priceBasisId: string;
}
function integer(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
}
function ceilPerMillion(tokens: number, price: number): bigint {
  return (BigInt(tokens) * BigInt(price) + 999999n) / 1000000n;
}
export function quoteSyntheticRouteCeiling(
  basis: SyntheticRoutePriceBasis,
  bound: { readonly providerId: string; readonly modelId: string; readonly outputTokens: number },
  nowMs = Date.now()
): SyntheticRouteQuote {
  if (!basis || basis.source !== 'synthetic_fixture' ||
      typeof basis.id !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,79}$/i.test(basis.id) ||
      basis.providerId !== bound.providerId || basis.modelId !== bound.modelId ||
      !integer(nowMs, Number.MAX_SAFE_INTEGER) ||
      !integer(basis.verifiedAtMs, Number.MAX_SAFE_INTEGER) ||
      !integer(basis.expiresAtMs, Number.MAX_SAFE_INTEGER) ||
      basis.verifiedAtMs > nowMs || basis.expiresAtMs <= nowMs ||
      basis.expiresAtMs - basis.verifiedAtMs > 24 * 60 * 60 * 1000 ||
      !integer(basis.maximumInputTokens, 1048576) || basis.maximumInputTokens === 0 ||
      !integer(bound.outputTokens, 8192) || bound.outputTokens === 0 ||
      !integer(basis.inputMinorPerMillion, 1000000000) ||
      !integer(basis.outputMinorPerMillion, 1000000000) ||
      basis.nonTokenMaximumMinor !== 0) {
    throw new Error('route_price_basis_untrusted_or_expired');
  }
  const ceiling = ceilPerMillion(basis.maximumInputTokens, basis.inputMinorPerMillion) +
    ceilPerMillion(bound.outputTokens, basis.outputMinorPerMillion);
  if (ceiling > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('route_price_ceiling_overflow');
  return {
    ceilingMinor: Number(ceiling), source: 'synthetic_fixture',
    priceBasisId: basis.id, expiresAtMs: basis.expiresAtMs,
    dispatchPermitted: false, hardVendorCashCap: false
  };
}
