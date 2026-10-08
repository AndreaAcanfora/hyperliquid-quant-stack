/**
 * Tests for src/math.ts (pure v8 target math).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  DEFAULT_TREND_PARAMS,
  rebalanceOrders,
  realizedVol,
  targetWeights,
  trendScore,
  type TrendEnsembleParams,
} from '../src/math.js';


const P: TrendEnsembleParams = { ...DEFAULT_TREND_PARAMS, lookbacks: [2, 4], volLookback: 3 };
const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) < eps;

describe('trendScore', () => {

test('all lookbacks up -> 1, all down -> 0 long-only / -1 long-short', () => {
  assert.equal(trendScore([1, 2, 3, 4, 5, 6], P), 1);
  assert.equal(trendScore([6, 5, 4, 3, 2, 1], P), 0);
  assert.equal(trendScore([6, 5, 4, 3, 2, 1], { ...P, longOnly: false }), -1);
});

test('mixed lookbacks average the signs', () => {
  // last=5; L=2 -> closes[2]=6 (down), L=4 -> closes[0]=1 (up) => 0
  assert.equal(trendScore([1, 2, 6, 5, 5], { ...P, longOnly: false }), 0);
});

test('not enough history -> null', () => {
  assert.equal(trendScore([1, 2, 3, 4], P), null);
});

});

describe('realizedVol', () => {

test('matches sample stdev * sqrt(365)', () => {
  const closes = [100, 101, 99, 102];
  const r = [0.01, 99 / 101 - 1, 102 / 99 - 1];
  const m = r.reduce((s, x) => s + x, 0) / 3;
  const sd = Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / 2);
  assert.ok(near(realizedVol(closes, 3)!, sd * Math.sqrt(365)));
});

});

describe('targetWeights', () => {

test('vol-scaled weight divided by N_active, gross capped', () => {
  const up = [100, 101, 99, 102, 104, 106];
  const w = targetWeights({ A: up, B: up.slice().reverse() }, { ...P, grossCap: 10 });
  const vol = realizedVol(up, 3)!;
  assert.ok(near(w.A!, Math.min(P.volTarget / vol, 3) / 2), `A=${w.A}`);
  assert.equal(w.B ?? 0, 0, 'downtrend coin gets 0 long-only');
});

test('gross above cap is scaled down pro-rata', () => {
  const up = [100, 100.1, 100.2, 100.3, 100.4, 100.5]; // very low vol -> 3x cap per coin
  const w = targetWeights({ A: up, B: up }, { ...P, grossCap: 1.5 });
  assert.ok(near(w.A! + w.B!, 1.5));
  assert.ok(near(w.A!, w.B!));
});

test('young listing counts in N_active but gets no weight (backtest parity)', () => {
  const up = [100, 101, 99, 102, 104, 106];
  const w = targetWeights({ A: up, NEW: [5, 6] }, { ...P, grossCap: 10 });
  const vol = realizedVol(up, 3)!;
  assert.ok(near(w.A!, Math.min(P.volTarget / vol, 3) / 2));
  assert.equal(w.NEW, undefined);
});

});

describe('rebalanceOrders', () => {

test('inside the band -> no order; outside -> delta; sells first', () => {
  const o = rebalanceOrders({ BTC: 1000, ETH: 500, SOL: 0 }, { BTC: 900, ETH: 100, SOL: 300 }, 0.2);
  assert.deepEqual(o.map((x) => [x.coin, x.deltaUsd]), [['SOL', -300], ['ETH', 400]]);
});

test('closing to flat ignores the min-notional rule; tiny adds are skipped', () => {
  const o = rebalanceOrders({ BTC: 0, ETH: 30 }, { BTC: 4, ETH: 22 }, 0.2, 10);
  assert.deepEqual(o.map((x) => x.coin), ['BTC']);
});
});
