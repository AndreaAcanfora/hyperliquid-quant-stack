/**
 * v8 "Trend Ensemble": pure target-weight math, no I/O.
 *
 * Mirrors `scripts/research/v8/trend_ensemble_backtest.py` exactly so
 * the live runner trades what was backtested:
 *
 *   score_i  = mean over L in lookbacks of sign(close_t / close_{t-L} - 1)
 *   long-only: score clipped to [0, 1]
 *   weight_i = score_i * min(volTarget / vol_i, 3) / N_active
 *   gross    = sum |w| capped at grossCap (pro-rata scale-down)
 *
 * `vol_i` is the annualised (sqrt(365)) sample stdev of the last
 * `volLookback` daily returns. Weights are fractions of account equity.
 */

export interface TrendEnsembleParams {
  lookbacks: number[];
  volLookback: number;
  volTarget: number;
  grossCap: number;
  /** No-trade band: rebalance a coin only when |target - held| > band * |target|. */
  band: number;
  longOnly: boolean;
}

export const DEFAULT_TREND_PARAMS: TrendEnsembleParams = {
  lookbacks: [14, 28, 56, 112],
  volLookback: 30,
  volTarget: 0.6,
  grossCap: 1.5,
  band: 0.2,
  longOnly: true,
};

/** Max per-coin vol-scaling multiplier (caps weight on very quiet coins). */
const MAX_VOL_SCALE = 3;

function sign(x: number): number {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

/**
 * Ensemble trend score in [-1, 1] (or [0, 1] long-only) from daily
 * closes ordered oldest -> newest, last = most recent CLOSED day.
 * Returns null when there isn't enough history for the longest lookback.
 */
export function trendScore(closes: number[], p: TrendEnsembleParams): number | null {
  const n = closes.length;
  const maxL = Math.max(...p.lookbacks);
  if (n <= maxL) return null;
  const last = closes[n - 1]!;
  let sum = 0;
  for (const L of p.lookbacks) {
    const past = closes[n - 1 - L]!;
    if (!(past > 0)) return null;
    sum += sign(last / past - 1);
  }
  const s = sum / p.lookbacks.length;
  return p.longOnly ? Math.max(0, s) : s;
}

/** Annualised realised vol of the last `lookback` daily returns (sample stdev). */
export function realizedVol(closes: number[], lookback: number): number | null {
  const n = closes.length;
  if (n < lookback + 1) return null;
  const rets: number[] = [];
  for (let i = n - lookback; i < n; i++) {
    const a = closes[i - 1]!;
    const b = closes[i]!;
    if (!(a > 0)) return null;
    rets.push(b / a - 1);
  }
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(365);
}

/**
 * Target weights (fraction of equity, signed) per coin. As in the
 * backtest, N_active counts every coin that has a price, including
 * young listings whose score can't be computed yet (they get weight 0).
 */
export function targetWeights(
  closesByCoin: Record<string, number[]>,
  p: TrendEnsembleParams,
): Record<string, number> {
  const raw: Record<string, number> = {};
  let nActive = 0;
  for (const [coin, closes] of Object.entries(closesByCoin)) {
    if (closes.length === 0) continue;
    nActive++;
    const score = trendScore(closes, p);
    const vol = realizedVol(closes, p.volLookback);
    if (score === null || vol === null || !(vol > 0)) continue;
    raw[coin] = score * Math.min(p.volTarget / vol, MAX_VOL_SCALE);
  }
  const out: Record<string, number> = {};
  if (nActive === 0) return out;
  let gross = 0;
  for (const c of Object.keys(raw)) {
    out[c] = raw[c]! / nActive;
    gross += Math.abs(out[c]!);
  }
  const scale = gross > p.grossCap ? p.grossCap / gross : 1;
  for (const c of Object.keys(out)) out[c] = out[c]! * scale;
  return out;
}

export interface RebalanceOrder {
  coin: string;
  /** Signed USD notional change: + buy, - sell. */
  deltaUsd: number;
  targetUsd: number;
  heldUsd: number;
}

/**
 * Orders needed to move held notionals toward targets, honouring the
 * no-trade band (always trade to flat when the target is 0) and a
 * minimum order notional (HL rejects orders under $10).
 */
export function rebalanceOrders(
  targetUsdByCoin: Record<string, number>,
  heldUsdByCoin: Record<string, number>,
  band: number,
  minOrderUsd = 10,
): RebalanceOrder[] {
  const coins = new Set([...Object.keys(targetUsdByCoin), ...Object.keys(heldUsdByCoin)]);
  const orders: RebalanceOrder[] = [];
  for (const coin of coins) {
    const target = targetUsdByCoin[coin] ?? 0;
    const held = heldUsdByCoin[coin] ?? 0;
    const delta = target - held;
    const needs = target === 0 ? held !== 0 : Math.abs(delta) > band * Math.abs(target);
    if (!needs) continue;
    // Closing to flat is always allowed (reduce-only); other trades need
    // to clear the venue's minimum notional.
    if (target !== 0 && Math.abs(delta) < minOrderUsd) continue;
    orders.push({ coin, deltaUsd: delta, targetUsd: target, heldUsd: held });
  }
  // Sells first so freed margin is available for buys.
  return orders.sort((a, b) => a.deltaUsd - b.deltaUsd);
}
