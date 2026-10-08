/**
 * Price and size formatting plus the maker ladder's step prices. Pure
 * functions: everything they need (tick rules, size decimals, the book)
 * is passed in.
 */

export interface BestBidOffer {
  bestBid: number;
  bestAsk: number;
}

/**
 * HL price tick from the 5-significant-figure rule: $0.01 around $640
 * (BNB), $0.1 around $4,000 (ETH), $10 around $100k (BTC). Non-positive
 * or non-finite prices fall back to $0.01.
 */
export function priceTick(price: number): number {
  if (!Number.isFinite(price) || price <= 0) return 0.01;
  const magnitude = Math.floor(Math.log10(price));
  return Math.max(Math.pow(10, magnitude - 4), 0.000001);
}

/**
 * Limit price for maker step `step` (1..N). With a book, step 1 joins the
 * best bid (buy) / best ask (sell) and each step moves one tick toward the
 * other side, never crossing it (on a 1-tick spread every step stays at
 * the touch). Without a book, steps walk from the oracle price.
 */
export function stepPrice(bbo: BestBidOffer | null, oracle: number, side: 'BUY' | 'SELL', step: number): number {
  const tick = priceTick(oracle);
  const delta = Math.max(0, step - 1) * tick;
  if (bbo) {
    return side === 'BUY'
      ? Math.min(bbo.bestBid + delta, bbo.bestAsk - tick)
      : Math.max(bbo.bestAsk - delta, bbo.bestBid + tick);
  }
  return side === 'BUY' ? oracle + delta : oracle - delta;
}

/**
 * Price string HL accepts: integers always pass; otherwise at most 5
 * significant figures AND at most `6 - szDecimals` decimals (perps).
 */
export function formatPrice(px: number, szDecimals: number | undefined): string {
  if (!Number.isFinite(px) || px <= 0) throw new Error(`invalid price ${px}`);
  if (Number.isInteger(px)) return String(px);
  const maxDecimals = szDecimals !== undefined ? Math.max(0, 6 - szDecimals) : 8;
  return Number(Number(px.toPrecision(5)).toFixed(maxDecimals)).toString();
}

/** Size string with exactly the coin's size decimals (HL rejects more precision). */
export function formatSize(sz: number, szDecimals: number): string {
  if (!Number.isFinite(sz) || sz <= 0) throw new Error(`invalid size ${sz}`);
  return sz.toFixed(szDecimals);
}
