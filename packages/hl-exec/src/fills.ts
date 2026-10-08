import type { ExchangeTradeResult, OrderFill, OrderFillsAggregate } from './types.js';

/** A fill as HL sends it (numbers as strings, to avoid float drift on the wire). */
export interface RawFill {
  oid: number;
  px: string;
  sz: string;
  side: 'B' | 'A';
  fee: string;
  closedPnl: string;
  crossed: boolean;
  time: number;
  hash: string;
  coin?: string;
}

/** Parse once; malformed numbers become 0 rather than throwing inside the trading loop. */
export function normalizeFill(raw: RawFill): OrderFill {
  return {
    oid: raw.oid,
    px: Number(raw.px) || 0,
    sz: Number(raw.sz) || 0,
    side: raw.side,
    fee: Number(raw.fee) || 0,
    closedPnl: Number(raw.closedPnl) || 0,
    crossed: !!raw.crossed,
    time: raw.time,
    hash: raw.hash ?? '',
    ...(raw.coin ? { coin: raw.coin } : {}),
  };
}

/**
 * Summarise every partial fill of one order: total size, size-weighted
 * price, fees, realised PnL, maker/taker. `null` when there are no fills.
 */
export function aggregateFills(oid: number, rawFills: RawFill[]): OrderFillsAggregate | null {
  if (rawFills.length === 0) return null;
  const fills = rawFills.map(normalizeFill);
  let totalSize = 0;
  let notional = 0;
  let totalFee = 0;
  let totalClosedPnl = 0;
  let wasTaker = false;
  let firstFillTime = Number.POSITIVE_INFINITY;
  let lastFillTime = 0;
  const hashes = new Set<string>();
  for (const f of fills) {
    totalSize += f.sz;
    notional += f.px * f.sz;
    totalFee += f.fee;
    totalClosedPnl += f.closedPnl;
    if (f.crossed) wasTaker = true;
    firstFillTime = Math.min(firstFillTime, f.time);
    lastFillTime = Math.max(lastFillTime, f.time);
    if (f.hash) hashes.add(f.hash);
  }
  return {
    oid,
    fills,
    totalSize,
    avgPrice: totalSize > 0 ? notional / totalSize : 0,
    totalFee,
    totalClosedPnl,
    wasTaker,
    firstFillTime: firstFillTime === Number.POSITIVE_INFINITY ? 0 : firstFillTime,
    lastFillTime,
    txHashes: [...hashes],
  };
}

/**
 * Collapse the orders of one operation (maker ladder + taker remainder)
 * into one result: summed size and fee, size-weighted price, last oid.
 */
export function mergeTradeResults(
  results: ExchangeTradeResult[],
  market: string,
  side: 'BUY' | 'SELL',
  reason: string,
): ExchangeTradeResult | null {
  if (results.length === 0) return null;
  if (results.length === 1) return results[0] ?? null;
  const size = results.reduce((s, r) => s + r.size, 0);
  const notional = results.reduce((s, r) => s + r.size * r.price, 0);
  const last = results[results.length - 1];
  return {
    orderId: last?.orderId ?? 0,
    market,
    side,
    size,
    price: size > 0 ? notional / size : (last?.price ?? 0),
    fee: results.reduce((s, r) => s + r.fee, 0),
    reason,
    timestamp: new Date().toISOString(),
  };
}
