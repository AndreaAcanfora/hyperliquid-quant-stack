/**
 * Daily portfolio backtest for the trend ensemble. Pure and synchronous so
 * it runs in Node, in a browser Web Worker, or in tests.
 *
 * Same accounting as the Python research engine
 * (research/trend_ensemble_backtest.py), so both report identical curves:
 *   - each day, PnL = sum(held_w * return) - sum(held_w * funding)
 *   - held weights then drift with prices until the next rebalance
 *   - rebalance at the close toward the target weights, trading only coins
 *     outside the no-trade band (or whose target is flat)
 *   - costs = turnover * fee rate
 */
import { targetWeights, type TrendEnsembleParams } from './math.js';

export interface DailySeries {
  /** UTC day timestamps (ms), ascending, shared by every coin. */
  days: number[];
  /** Close per day per coin; `null` before a coin lists or on gaps. */
  closes: Record<string, Array<number | null>>;
  /** Optional daily funding rate per coin (sum of hourly rates; + = longs pay). */
  funding?: Record<string, Array<number | null>>;
}

export interface BacktestOptions {
  /** Cost per unit of turnover (fee + slippage). Default 0.065%. */
  feeRate?: number;
  /** Funding charged when a day has no rate. Default 0.01%/8h. */
  defaultFundingPerDay?: number;
  /** First day (ms) to trade; earlier days only warm up the indicators. */
  startMs?: number;
  /** Also return each day's held weights per coin (for position charts). */
  recordWeights?: boolean;
}

export interface BacktestPoint {
  t: number;
  equity: number;
  /** Day return after costs. */
  ret: number;
  turnover: number;
  /** Gross exposure (sum |weight|) after the day's rebalance. */
  gross: number;
  /** Held weight per coin after the rebalance (only with `recordWeights`). */
  weights?: Record<string, number>;
}

export interface BacktestStats {
  cagr: number;
  sharpe: number;
  maxDrawdown: number;
  totalReturn: number;
  avgGross: number;
  turnoverPerYear: number;
  byYear: Record<number, number>;
}

export interface BacktestResult {
  points: BacktestPoint[];
  stats: BacktestStats;
}

const DEFAULTS = { feeRate: 0.00045 + 0.0002, defaultFundingPerDay: 0.0001 * 3 };

export function runBacktest(
  series: DailySeries,
  params: TrendEnsembleParams,
  opts: BacktestOptions = {},
): BacktestResult {
  const feeRate = opts.feeRate ?? DEFAULTS.feeRate;
  const defFunding = opts.defaultFundingPerDay ?? DEFAULTS.defaultFundingPerDay;
  const coins = Object.keys(series.closes);
  const n = series.days.length;
  const start = opts.startMs === undefined ? 0 : lowerBound(series.days, opts.startMs);

  // Non-null history per coin up to each day, built incrementally.
  const history: Record<string, number[]> = Object.fromEntries(coins.map((c) => [c, []]));
  const held: Record<string, number> = Object.fromEntries(coins.map((c) => [c, 0]));
  const prev: Record<string, number | null> = Object.fromEntries(coins.map((c) => [c, null]));
  const points: BacktestPoint[] = [];
  let equity = 1;

  for (let i = 0; i < n; i++) {
    const rets: Record<string, number> = {};
    for (const c of coins) {
      const px = series.closes[c]![i] ?? null;
      const p0 = prev[c] ?? null;
      rets[c] = px !== null && p0 !== null && p0 > 0 ? px / p0 - 1 : 0;
      if (px !== null) {
        history[c]!.push(px);
        prev[c] = px;
      }
    }
    if (i < start) continue;

    let pnl = 0;
    for (const c of coins) {
      if (held[c] === 0) continue;
      const f = series.funding?.[c]?.[i];
      pnl += held[c]! * rets[c]! - held[c]! * (f ?? defFunding);
    }
    equity *= 1 + pnl;
    for (const c of coins) held[c] = (held[c]! * (1 + rets[c]!)) / (1 + pnl);

    const listed: Record<string, number[]> = {};
    for (const c of coins) if (series.closes[c]![i] != null) listed[c] = history[c]!;
    const want = targetWeights(listed, params);

    let turnover = 0;
    for (const c of coins) {
      const target = want[c] ?? 0;
      const diff = target - held[c]!;
      const needs = target === 0 || Math.abs(diff) > params.band * Math.abs(target);
      if (!needs || diff === 0) continue;
      turnover += Math.abs(diff);
      held[c] = held[c]! + diff;
    }
    equity *= 1 - turnover * feeRate;
    const gross = coins.reduce((s, c) => s + Math.abs(held[c]!), 0);
    const point: BacktestPoint = { t: series.days[i]!, equity, ret: pnl, turnover, gross };
    if (opts.recordWeights) {
      point.weights = {};
      for (const c of coins) if (held[c] !== 0) point.weights[c] = held[c]!;
    }
    points.push(point);
  }
  return { points, stats: computeStats(points) };
}

export function computeStats(points: BacktestPoint[]): BacktestStats {
  if (points.length === 0) {
    return { cagr: 0, sharpe: 0, maxDrawdown: 0, totalReturn: 0, avgGross: 0, turnoverPerYear: 0, byYear: {} };
  }
  const daily: number[] = [];
  let prevEq = 1;
  let peak = 1;
  let maxDd = 0;
  const byYear: Record<number, number> = {};
  for (const p of points) {
    const r = p.equity / prevEq - 1;
    daily.push(r);
    const y = new Date(p.t).getUTCFullYear();
    byYear[y] = ((byYear[y] ?? 0) + 1) * (1 + r) - 1;
    prevEq = p.equity;
    peak = Math.max(peak, p.equity);
    maxDd = Math.min(maxDd, p.equity / peak - 1);
  }
  const years = points.length / 365;
  const last = points[points.length - 1]!.equity;
  const mean = daily.reduce((s, r) => s + r, 0) / daily.length;
  const sd = Math.sqrt(daily.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, daily.length - 1));
  return {
    cagr: years > 0 ? last ** (1 / years) - 1 : 0,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(365) : 0,
    maxDrawdown: maxDd,
    totalReturn: last - 1,
    avgGross: points.reduce((s, p) => s + p.gross, 0) / points.length,
    turnoverPerYear: points.reduce((s, p) => s + p.turnover, 0) / Math.max(years, 1e-9),
    byYear,
  };
}

function lowerBound(arr: number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (arr[m]! < x) lo = m + 1;
    else hi = m;
  }
  return lo;
}
