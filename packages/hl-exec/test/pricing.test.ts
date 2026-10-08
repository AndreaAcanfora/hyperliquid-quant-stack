/** Pure helpers: market names, price ticks and maker step prices. */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { aggregateFills, formatPrice, formatSize, intervalMs, mergeTradeResults, priceTick, stepPrice, toInterval, toMarket } from '../src/index.js';

describe('toMarket', () => {

test('USDC suffix → dYdX market', () => {
  assert.equal(toMarket('ETHUSDC'), 'ETH-USD');
  assert.equal(toMarket('SOLUSDC'), 'SOL-USD');
  assert.equal(toMarket('BNBUSDC'), 'BNB-USD');
  assert.equal(toMarket('BTCUSDC'), 'BTC-USD');
});

test('USDT suffix → dYdX market', () => {
  assert.equal(toMarket('ETHUSDT'), 'ETH-USD');
});

test('already-dYdX format passes through', () => {
  assert.equal(toMarket('ETH-USD'), 'ETH-USD');
});

test('unknown <BASE>USDC fallback', () => {
  assert.equal(toMarket('DOGEUSDC'), 'DOGE-USD');
});

test('unknown format returned verbatim', () => {
  assert.equal(toMarket('FAKE'), 'FAKE');
});

});

describe('priceTick (5 significant figures)', () => {

test('priceTick at $640 → $0.01', () => {
  const t = priceTick(640);
  assert.ok(Math.abs(t - 0.01) < 1e-12, `expected ~0.01, got ${t}`);
});

test('priceTick at $4000 → $0.1', () => {
  const t = priceTick(4000);
  assert.ok(Math.abs(t - 0.1) < 1e-12, `expected ~0.1, got ${t}`);
});

test('priceTick at $200 → $0.01', () => {
  const t = priceTick(200);
  assert.ok(Math.abs(t - 0.01) < 1e-12);
});

test('priceTick at $100,000 → $10', () => {
  const t = priceTick(100_000);
  assert.ok(Math.abs(t - 10) < 1e-9);
});

test('priceTick at $0 / negative falls back safely', () => {
  const fn = priceTick;
  assert.equal(fn(0), 0.01);
  assert.equal(fn(-5), 0.01);
  assert.equal(fn(NaN), 0.01);
});

});

describe('stepPrice (maker ladder)', () => {


test('stepPrice BUY (no BBO): each step bumps oracle UP by one tick', () => {
  const fn = stepPrice;
  // BNB at $640.025 → tick $0.01. No BBO → legacy oracle-based fallback.
  assert.ok(Math.abs(fn(null, 640.025, 'BUY', 1) - 640.025) < 1e-9, 'step1 = oracle');
  assert.ok(Math.abs(fn(null, 640.025, 'BUY', 2) - 640.035) < 1e-9, 'step2 = oracle + 1 tick');
  assert.ok(Math.abs(fn(null, 640.025, 'BUY', 3) - 640.045) < 1e-9, 'step3 = oracle + 2 ticks');
});

test('stepPrice SELL (no BBO): each step bumps oracle DOWN by one tick', () => {
  const fn = stepPrice;
  assert.ok(Math.abs(fn(null, 640.025, 'SELL', 1) - 640.025) < 1e-9);
  assert.ok(Math.abs(fn(null, 640.025, 'SELL', 2) - 640.015) < 1e-9);
  assert.ok(Math.abs(fn(null, 640.025, 'SELL', 3) - 640.005) < 1e-9);
});

test('stepPrice BUY (BBO present): step1 = bestBid, walks toward bestAsk, capped at bestAsk - 1 tick', () => {
  const fn = stepPrice;
  // SOL @ ~$200 → tick $0.01. Wide-enough spread for steps to spread.
  const bbo = { bestBid: 200.00, bestAsk: 200.10 };
  assert.ok(Math.abs(fn(bbo, 200.05, 'BUY', 1) - 200.00) < 1e-9, 'step1 = bestBid');
  assert.ok(Math.abs(fn(bbo, 200.05, 'BUY', 2) - 200.01) < 1e-9, 'step2 = bestBid + 1 tick');
  assert.ok(Math.abs(fn(bbo, 200.05, 'BUY', 3) - 200.02) < 1e-9, 'step3 = bestBid + 2 ticks');
  // Far-off step: capped at bestAsk - 1 tick (= 200.09) so never crosses.
  assert.ok(Math.abs(fn(bbo, 200.05, 'BUY', 99) - 200.09) < 1e-9, 'step99 capped at bestAsk - tick');
});

test('stepPrice SELL (BBO present): step1 = bestAsk, walks toward bestBid, floored at bestBid + 1 tick', () => {
  const fn = stepPrice;
  const bbo = { bestBid: 200.00, bestAsk: 200.10 };
  assert.ok(Math.abs(fn(bbo, 200.05, 'SELL', 1) - 200.10) < 1e-9, 'step1 = bestAsk');
  assert.ok(Math.abs(fn(bbo, 200.05, 'SELL', 2) - 200.09) < 1e-9, 'step2 = bestAsk - 1 tick');
  assert.ok(Math.abs(fn(bbo, 200.05, 'SELL', 3) - 200.08) < 1e-9, 'step3 = bestAsk - 2 ticks');
  assert.ok(Math.abs(fn(bbo, 200.05, 'SELL', 99) - 200.01) < 1e-9, 'step99 floored at bestBid + tick');
});

test('stepPrice on 1-tick spread: all 3 BUY steps collapse to bestBid (cannot cross)', () => {
  const fn = stepPrice;
  // SOL with 1-tick spread: the smoke-test scenario that exposed the bug.
  const bbo = { bestBid: 200.00, bestAsk: 200.01 };
  // step1 = bestBid = 200.00. step2 = bestBid + 1 tick = 200.01 BUT capped at bestAsk - 1 tick = 200.00.
  // step3 = bestBid + 2 ticks capped at 200.00 too. All three identical.
  assert.ok(Math.abs(fn(bbo, 200.005, 'BUY', 1) - 200.00) < 1e-9, 'step1 = bestBid');
  assert.ok(Math.abs(fn(bbo, 200.005, 'BUY', 2) - 200.00) < 1e-9, 'step2 collapses to bestBid (cap)');
  assert.ok(Math.abs(fn(bbo, 200.005, 'BUY', 3) - 200.00) < 1e-9, 'step3 collapses to bestBid (cap)');
});

});

describe('formatPrice / formatSize', () => {
  test('integers pass through untouched', () => {
    assert.equal(formatPrice(84000, 5), '84000');
  });

  test('5 significant figures and at most 6 - szDecimals decimals', () => {
    assert.equal(formatPrice(3450.123, 4), '3450.1'); // ETH: 5 sig figs wins
    assert.equal(formatPrice(117.6412, 2), '117.64'); // SOL: 5 sig figs
    assert.equal(formatPrice(0.123456, 0), '0.12346'); // 0 size decimals allow 6
  });

  test('sizes use exactly the coin size decimals', () => {
    assert.equal(formatSize(0.38049, 4), '0.3805');
    assert.equal(formatSize(8.3, 2), '8.30');
  });

  test('rejects non-positive values', () => {
    assert.throws(() => formatPrice(0, 4), /invalid price/);
    assert.throws(() => formatSize(-1, 4), /invalid size/);
  });
});

describe('intervals', () => {
  test('resolution names and native intervals both map to HL intervals', () => {
    assert.equal(toInterval('4HOURS'), '4h');
    assert.equal(toInterval('1d'), '1d');
    assert.equal(toInterval('nonsense'), '4h');
    assert.equal(intervalMs('1h'), 3_600_000);
  });
});

describe('fill aggregation', () => {
  const fill = (px: string, sz: string, fee: string, crossed: boolean, time: number) => ({
    oid: 7, px, sz, side: 'B' as const, fee, closedPnl: '0', crossed, time, hash: `0x${time}`,
  });

  test('size-weighted price, summed fees, taker if any partial crossed', () => {
    const agg = aggregateFills(7, [fill('100', '1', '0.015', false, 1), fill('103', '2', '0.09', true, 2)])!;
    assert.equal(agg.totalSize, 3);
    assert.ok(Math.abs(agg.avgPrice - 102) < 1e-12);
    assert.ok(Math.abs(agg.totalFee - 0.105) < 1e-12);
    assert.equal(agg.wasTaker, true);
    assert.deepEqual([agg.firstFillTime, agg.lastFillTime], [1, 2]);
  });

  test('no fills is null, malformed numbers become 0', () => {
    assert.equal(aggregateFills(7, []), null);
    assert.equal(aggregateFills(7, [fill('x', '1', 'y', false, 1)])!.totalFee, 0);
  });

  test('merging a maker partial and a taker remainder', () => {
    const t = (size: number, price: number, fee: number, orderId: number) => ({
      orderId, market: 'ETH-USD', side: 'SELL' as const, size, price, fee, reason: 'r', timestamp: '',
    });
    const merged = mergeTradeResults([t(0.3, 2000, 0.09, 1), t(0.1, 1990, 0.09, 2)], 'ETH-USD', 'SELL', 'FLAT')!;
    assert.ok(Math.abs(merged.size - 0.4) < 1e-12);
    assert.ok(Math.abs(merged.price - 1997.5) < 1e-9);
    assert.equal(merged.orderId, 2);
    assert.equal(mergeTradeResults([], 'ETH-USD', 'SELL', 'x'), null);
  });
});
