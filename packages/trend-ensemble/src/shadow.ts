/**
 * Trend Ensemble SHADOW runner: trades a virtual portfolio with the
 * strategy rules on real Hyperliquid prices, places no orders.
 *
 * Once per UTC day, after the daily candle closes:
 *   1. fetch HL 1d candles for the universe (in-progress day dropped),
 *   2. compute target weights (`targetWeights`, the same math as
 *      research/trend_ensemble_backtest.py),
 *   3. mark the virtual book to the current HL mark price,
 *   4. simulate the band-filtered rebalance as taker fills
 *      (mark +/- slippage, taker fee),
 *   5. persist state + append the day's trades/snapshot to JSONL files,
 *   6. hand a short text report to `deps.report` (e.g. a Telegram message).
 *
 * Funding: at each run, every held position is charged the sum of HL's
 * hourly funding rates since the previous run times its notional at the
 * current mark (positive rate = longs pay), like the backtest does.
 *
 * State lives in `deps.dir` (keep it outside the deploy tree so it
 * survives redeploys):
 *   state.json   current book, rewritten atomically each day
 *   trades.jsonl one line per simulated fill
 *   daily.jsonl  one line per daily run (equity, gross, weights, orders)
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_TREND_PARAMS,
  rebalanceOrders,
  targetWeights,
  type TrendEnsembleParams,
} from './math.js';

/** The 13 liquid Hyperliquid perps the strategy was researched on. */
export const DEFAULT_UNIVERSE = [
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'LINK', 'AVAX', 'ADA', 'LTC', 'SUI', 'NEAR', 'HYPE',
] as const;

const DAY_MS = 86_400_000;
const TAKER_FEE = 0.00045;
const SLIPPAGE = 0.0002;

export interface ShadowState {
  /** `v8-shadow-1` is the same schema, written by releases before 0.2. */
  version: 'shadow-1' | 'v8-shadow-1';
  startedAt: string;
  capitalStart: number;
  /** Quote balance; negative when the book is levered (perp margin). */
  cash: number;
  /** Signed base-asset size per coin. */
  positions: Record<string, number>;
  feesPaid: number;
  /** Net funding paid (positive = cost), cumulative. */
  fundingPaid?: number;
  /** UTC day (YYYY-MM-DD) of the last completed daily run. */
  lastRunDay: string | null;
  /** Epoch ms of the last completed run (funding accrual window start). */
  lastRunAt?: number;
}

export interface ShadowDayResult {
  day: string;
  equity: number;
  equityBefore: number;
  gross: number;
  /** Funding charged this run (positive = cost). */
  funding: number;
  weights: Record<string, number>;
  orders: Array<{ coin: string; side: 'BUY' | 'SELL'; usd: number; price: number; fee: number }>;
  missing: string[];
}

interface CandleLike { startedAt: string; close: string | number }

export interface ShadowClient {
  getCandles(market: string, resolution?: string, limit?: number): Promise<unknown[]>;
  getOraclePrice(market: string): Promise<number>;
  /** Optional: hourly funding rates; without it funding is not charged. */
  getFundingRates?(market: string, startMs: number, endMs: number): Promise<Array<{ time: number; rate: number }>>;
}

export interface ShadowDeps {
  client: ShadowClient;
  dir: string;
  capital: number;
  params?: TrendEnsembleParams;
  universe?: readonly string[];
  now?: () => number;
  log?: (level: 'info' | 'warning' | 'error', msg: string) => void;
  report?: (text: string) => Promise<void>;
  /** Name used in log lines and the report title. Default `shadow`. */
  label?: string;
}

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function loadShadowState(dir: string, capital: number, nowMs: number): ShadowState {
  const file = join(dir, 'state.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as ShadowState;
  return {
    version: 'shadow-1',
    startedAt: new Date(nowMs).toISOString(),
    capitalStart: capital,
    cash: capital,
    positions: {},
    feesPaid: 0,
    lastRunDay: null,
  };
}

function saveState(dir: string, state: ShadowState): void {
  const file = join(dir, 'state.json');
  writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 1));
  renameSync(`${file}.tmp`, file);
}

/** Closed daily closes, oldest -> newest (the in-progress UTC day is dropped). */
function closedDailyCloses(raw: unknown[], nowMs: number): number[] {
  return (raw as CandleLike[])
    .filter((c) => Date.parse(c.startedAt) + DAY_MS <= nowMs)
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
    .map((c) => Number(c.close))
    .filter((x) => Number.isFinite(x) && x > 0);
}

/**
 * Run the daily step if it hasn't run yet today (UTC). Returns null when
 * already done or when the day's candle isn't closed long enough yet.
 */
export async function runShadowDay(deps: ShadowDeps): Promise<ShadowDayResult | null> {
  const now = (deps.now ?? Date.now)();
  const log = deps.log ?? (() => undefined);
  const params = deps.params ?? DEFAULT_TREND_PARAMS;
  const universe = deps.universe ?? DEFAULT_UNIVERSE;
  const label = deps.label ?? 'shadow';
  mkdirSync(deps.dir, { recursive: true });
  const state = loadShadowState(deps.dir, deps.capital, now);
  const day = utcDay(now);
  if (state.lastRunDay === day) return null;
  // Give HL a few minutes to finalise the daily candle.
  if (now - Date.parse(`${day}T00:00:00Z`) < 10 * 60_000) return null;

  const need = Math.max(...params.lookbacks, params.volLookback) + 5;
  const closes: Record<string, number[]> = {};
  const prices: Record<string, number> = {};
  const missing: string[] = [];
  for (const coin of universe) {
    try {
      const raw = await deps.client.getCandles(`${coin}-USD`, '1DAY', need + 2);
      const c = closedDailyCloses(raw, now);
      const px = await deps.client.getOraclePrice(`${coin}-USD`);
      if (c.length === 0 || !(px > 0)) throw new Error('no data');
      closes[coin] = c;
      prices[coin] = px;
    } catch (err: unknown) {
      missing.push(coin);
      log('warning', `[${label}] ${coin}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // A coin we hold but can't price: keep it untouched and mark it at its
  // last known value only if we have a price; without one, skip the day
  // rather than trading on a partial book.
  const heldWithoutPrice = Object.keys(state.positions).filter((c) => state.positions[c] !== 0 && !(c in prices));
  if (heldWithoutPrice.length > 0) {
    log('error', `[${label}] no price for held ${heldWithoutPrice.join(',')} - skipping ${day}`);
    return null;
  }

  // Funding accrued on the book held since the previous run.
  let funding = 0;
  // States written before funding existed have no lastRunAt: accrue from
  // the book's creation instead.
  const accrueFrom = state.lastRunAt ?? (state.lastRunDay ? Date.parse(state.startedAt) : undefined);
  if (deps.client.getFundingRates && accrueFrom) {
    for (const [coin, q] of Object.entries(state.positions)) {
      if (q === 0) continue;
      try {
        const rates = await deps.client.getFundingRates(`${coin}-USD`, accrueFrom, now);
        const sumRate = rates.reduce((s, r) => s + r.rate, 0);
        funding += q * prices[coin]! * sumRate;
      } catch (err: unknown) {
        log('warning', `[${label}] funding ${coin}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    state.cash -= funding;
    state.fundingPaid = (state.fundingPaid ?? 0) + funding;
  }

  const markValue = (): number =>
    state.cash + Object.entries(state.positions).reduce((s, [c, q]) => s + q * (prices[c] ?? 0), 0);
  const equityBefore = markValue();
  const weights = targetWeights(closes, params);
  const targetUsd: Record<string, number> = {};
  for (const [c, w] of Object.entries(weights)) targetUsd[c] = w * equityBefore;
  const heldUsd: Record<string, number> = {};
  for (const [c, q] of Object.entries(state.positions)) if (q !== 0) heldUsd[c] = q * prices[c]!;

  const orders: ShadowDayResult['orders'] = [];
  const fills: string[] = [];
  for (const o of rebalanceOrders(targetUsd, heldUsd, params.band)) {
    const mark = prices[o.coin]!;
    const side = o.deltaUsd > 0 ? 'BUY' : 'SELL';
    const px = side === 'BUY' ? mark * (1 + SLIPPAGE) : mark * (1 - SLIPPAGE);
    // Going flat closes the exact held size.
    const qty = o.targetUsd === 0 ? -(state.positions[o.coin] ?? 0) : o.deltaUsd / mark;
    const fee = Math.abs(qty * px) * TAKER_FEE;
    state.positions[o.coin] = (state.positions[o.coin] ?? 0) + qty;
    if (Math.abs(state.positions[o.coin]!) < 1e-12) delete state.positions[o.coin];
    state.cash -= qty * px + fee;
    state.feesPaid += fee;
    const usd = Math.abs(qty * px);
    orders.push({ coin: o.coin, side, usd, price: px, fee });
    fills.push(JSON.stringify({ t: new Date(now).toISOString(), day, coin: o.coin, side, qty, price: px, usd, fee, mark }));
  }

  const equity = markValue();
  const gross = equity > 0
    ? Object.entries(state.positions).reduce((s, [c, q]) => s + Math.abs(q * prices[c]!), 0) / equity
    : 0;
  state.lastRunDay = day;
  state.lastRunAt = now;
  saveState(deps.dir, state);
  if (fills.length > 0) appendFileSync(join(deps.dir, 'trades.jsonl'), fills.join('\n') + '\n');
  const result: ShadowDayResult = { day, equity, equityBefore, gross, funding, weights, orders, missing };
  appendFileSync(join(deps.dir, 'daily.jsonl'), JSON.stringify({ ...result, t: new Date(now).toISOString(), feesPaid: state.feesPaid, fundingPaid: state.fundingPaid ?? 0 }) + '\n');
  log('info', `[${label}] ${day} equity=$${equity.toFixed(2)} gross=${gross.toFixed(2)}x orders=${orders.length}${missing.length ? ` missing=${missing.join(',')}` : ''}`);

  if (deps.report) {
    const pnl = equity - state.capitalStart;
    const lines = [
      `${label} (no real orders) - ${day}`,
      `Equity $${equity.toFixed(2)} (${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}, ${((equity / state.capitalStart - 1) * 100).toFixed(2)}% since ${state.startedAt.slice(0, 10)})`,
      `Exposure ${gross.toFixed(2)}x, fees so far $${state.feesPaid.toFixed(2)}, funding so far $${(state.fundingPaid ?? 0).toFixed(2)}${funding !== 0 ? ` (today ${funding >= 0 ? '-' : '+'}$${Math.abs(funding).toFixed(2)})` : ''}`,
      orders.length === 0
        ? 'No rebalance today.'
        : `Rebalance: ${orders.map((o) => `${o.side} ${o.coin} $${o.usd.toFixed(0)}`).join(', ')}`,
    ];
    try {
      await deps.report(lines.join('\n'));
    } catch (err: unknown) {
      log('warning', `[${label}] report failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}
