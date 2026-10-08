/**
 * Adapter interfaces for the two sources Price Guard feeds into the median (PRD §6.4: issuer NAV
 * weight 1, independent SEP-40 feed weight 1). The last-redemption-price and DEX/RFQ-monitoring-only
 * inputs from the same table are indexer/monitoring concerns, not this service's adapters.
 *
 * Both adapters return unsigned readings straight from the real source. Issuers do not sign NAV;
 * `pipeline.ts` has the price-publisher key attest each NAV (see `../navAttestor.ts`), which is
 * what `PriceGuard.publish_nav` verifies on-chain.
 */

export interface IssuerNavAdapter {
  /** NAV per token in USD, `PRICE_SCALE` fixed point, with the unix-seconds time the issuer last updated it. */
  fetchNav(assetCode: string): Promise<{ value: bigint; ts: number }>;
}

export interface IndependentFeedAdapter {
  /** USD price, `PRICE_SCALE` fixed point, with the unix-seconds time the oracle package was signed. */
  fetchPrice(assetCode: string): Promise<{ value: bigint; ts: number }>;
}
