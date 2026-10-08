/** Entries and exits: maker ladder, taker fallback, partial fills, failed closes. */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { CloseFailedError, HyperliquidExecutor as HlClient, constants } from '../src/index.js';
import { dynamicPositionClient, fakeExchange, fakeInfo, makerMockedClient, mockedClient } from './helpers.js';

describe('openLong / openShort (mocked exchange)', () => {


test('openLong posts a buy IOC at slightly-above-mark price', async () => {
  const c = await mockedClient();
  let captured: { orders: unknown[]; grouping: string } | null = null;
  c.exchange = fakeExchange({
    order: async (params: { orders: unknown[]; grouping: string }) => {
      captured = params;
      return {
        status: 'ok',
        response: {
          type: 'order',
          data: { statuses: [{ filled: { totalSz: '0.0145', avgPx: '3451.20', oid: 12345 } }] },
        },
      };
    },
  });
  const res = await c.openLong('ETHUSDC', 50, 'test entry');
  assert.ok(res, 'returned result');
  assert.equal(res?.market, 'ETH-USD');
  assert.equal(res?.side, 'BUY');
  assert.equal(res?.orderId, 12345);
  assert.ok(captured, 'order called');
  const c2 = captured as unknown as { orders: Array<Record<string, unknown>>; grouping: string };
  assert.equal(c2.grouping, 'na');
  assert.equal(c2.orders[0]?.a, 0); // ETH asset idx
  assert.equal(c2.orders[0]?.b, true); // long
  assert.equal(c2.orders[0]?.r, false); // not reduce-only
});

test('openShort sets b:false', async () => {
  const c = await mockedClient();
  // The order rests, so keep the maker ladder short; only the side matters here.
  c.makerWaitMs = 90;
  c.makerPollMs = 10;
  let captured: { orders: Array<Record<string, unknown>>; grouping: string } | null = null;
  c.exchange = fakeExchange({
    order: async (params: { orders: Array<Record<string, unknown>>; grouping: string }) => {
      captured = params;
      return {
        status: 'ok',
        response: {
          type: 'order',
          data: { statuses: [{ resting: { oid: 999 } }] },
        },
      };
    },
  });
  await c.openShort('BNBUSDC', 50, 'test');
  assert.ok(captured);
  const c2 = captured as unknown as { orders: Array<Record<string, unknown>>; grouping: string };
  assert.equal(c2.orders[0]?.b, false); // short
  assert.equal(c2.orders[0]?.a, 1); // BNB asset idx
});

test('openLong handles error status without throwing', async () => {
  const c = await mockedClient();
  c.exchange = fakeExchange({
    order: async () => ({
      status: 'ok',
      response: { type: 'order', data: { statuses: [{ error: 'min notional' }] } },
    }),
  });
  const res = await c.openLong('ETHUSDC', 1, 'test');
  assert.equal(res, null);
});

});


describe('closePosition (mocked)', () => {

test('closePosition reads current side + flips it with reduce-only IOC', async () => {
  const c = await mockedClient();
  let captured: { orders: Array<Record<string, unknown>> } | null = null;
  c.exchange = fakeExchange({
    order: async (params: { orders: Array<Record<string, unknown>>; grouping: string }) => {
      captured = params;
      return {
        status: 'ok',
        response: { type: 'order', data: { statuses: [{ filled: { totalSz: '0.5', avgPx: '3445', oid: 777 } }] } },
      };
    },
  });
  const res = await c.closePosition('ETHUSDC', 'TP test');
  assert.ok(res);
  assert.ok(captured);
  const c2 = captured as unknown as { orders: Array<Record<string, unknown>> };
  // ETH position above is LONG → close is SELL (b:false), reduce-only true
  assert.equal(c2.orders[0]?.b, false);
  assert.equal(c2.orders[0]?.r, true);
});

test('closePosition returns null when no open position exists', async () => {
  const c = await mockedClient();
  // Override clearinghouseState to return no positions.
  c.info = fakeInfo({
    spotClearinghouseState: async () => ({ balances: [] }),
    ...c.info,
    clearinghouseState: async () => ({
      marginSummary: { accountValue: '100', totalNtlPos: '0', totalRawUsd: '100', totalMarginUsed: '0' },
      crossMarginSummary: { accountValue: '100', totalNtlPos: '0', totalRawUsd: '100', totalMarginUsed: '0' },
      crossMaintenanceMarginUsed: '0',
      withdrawable: '100',
      assetPositions: [],
      time: Date.now(),
    }),
  });
  const res = await c.closePosition('ETHUSDC', 'no pos');
  assert.equal(res, null);
});

});


describe('step-aggressive maker close (mocked)', () => {


test('closePosition(FLAT) walks 3 step prices, cancels between each, then falls back to taker IOC', async () => {
  const c = await makerMockedClient();
  const orderCalls: Array<Record<string, unknown>> = [];
  const cancelCalls: Array<Record<string, unknown>> = [];
  c.exchange = fakeExchange({
    order: async (params: { orders: Array<Record<string, unknown>> }) => {
      orderCalls.push(params.orders[0]!);
      // Always return `resting` so the poll loop never sees a fill on
      // maker steps. The taker fallback (4th call) also lands here and
      // simulates an Ioc that the exchange treats as resting; for our
      // assertions we only need the call count + tif sequence.
      return {
        status: 'ok',
        response: { type: 'order', data: { statuses: [{ resting: { oid: 1000 + orderCalls.length } }] } },
      };
    },
    cancel: async (params: { cancels: Array<Record<string, unknown>> }) => {
      cancelCalls.push(...params.cancels);
      return { status: 'ok', response: { type: 'cancel', data: { statuses: ['success'] } } };
    },
  });

  await c.closePosition('ETHUSDC', 'FLAT');

  // 3 maker steps (Alo) + 1 taker fallback (Ioc) = 4 order calls.
  assert.equal(orderCalls.length, 4, 'three maker steps + taker fallback');
  const tifs = orderCalls.map((o) => (o.t as { limit: { tif: string } }).limit.tif);
  assert.deepEqual(tifs, ['Alo', 'Alo', 'Alo', 'Ioc'], 'three Alo posts then one Ioc fallback');

  // ETH position is LONG → close is SELL. With BBO present (bestAsk=3450.3,
  // tick=$0.1), step1=bestAsk, step2=bestAsk-tick, step3=bestAsk-2tick.
  const p1 = Number(orderCalls[0]!.p);
  const p2 = Number(orderCalls[1]!.p);
  const p3 = Number(orderCalls[2]!.p);
  assert.ok(p1 > p2 && p2 > p3, `SELL maker step prices should decrease: ${p1}, ${p2}, ${p3}`);
  // ETH at $3450 → tick $0.1. Verify step delta ≈ $0.1.
  assert.ok(Math.abs((p1 - p2) - 0.1) < 1e-6, `step1→2 delta ≈ 0.1 (got ${p1 - p2})`);
  assert.ok(Math.abs((p2 - p3) - 0.1) < 1e-6, `step2→3 delta ≈ 0.1 (got ${p2 - p3})`);
  // Anchor is bestAsk ($3450.3), not the oracle midpoint ($3450). Off-by-one
  // tick at this step would mean we regressed to the buggy oracle anchor.
  assert.ok(Math.abs(p1 - 3450.3) < 1e-6, `step1 SELL must be bestAsk ($3450.3), got ${p1}`);

  // Each of the 3 maker steps cancels its resting order before reprice
  // (no cancel on the taker step). Total: 3 cancels.
  assert.equal(cancelCalls.length, 3, 'three cancels (one per maker step)');
});

test('closePosition(FLAT) falls back to oracle-anchored step price when l2Book throws', async () => {
  const c = await makerMockedClient();
  const orderCalls: Array<Record<string, unknown>> = [];
  // Force the l2Book path to throw; _getBbo catches and returns null.
  const baseInfo = c.info;
  c.info = fakeInfo({
    ...baseInfo,
    l2Book: async () => { throw new Error('book unavailable'); },
  });
  c.exchange = fakeExchange({
    order: async (params: { orders: Array<Record<string, unknown>> }) => {
      orderCalls.push(params.orders[0]!);
      return {
        status: 'ok',
        response: { type: 'order', data: { statuses: [{ resting: { oid: 7000 + orderCalls.length } }] } },
      };
    },
    cancel: async () => ({ status: 'ok', response: { type: 'cancel', data: { statuses: ['success'] } } }),
  });

  await c.closePosition('ETHUSDC', 'FLAT');

  // With BBO null, step1 SELL must be the oracle ($3450), not bestAsk.
  const p1 = Number(orderCalls[0]!.p);
  assert.ok(Math.abs(p1 - 3450) < 1e-6, `step1 SELL with no BBO falls back to oracle ($3450), got ${p1}`);
});

test('closePosition(MH) returns immediately on instant fill at step 1 (no repricing)', async () => {
  const c = await makerMockedClient();
  let orderCalls = 0;
  c.exchange = fakeExchange({
    order: async () => {
      orderCalls++;
      return {
        status: 'ok',
        response: { type: 'order', data: { statuses: [{ filled: { totalSz: '0.5', avgPx: '3450.5', oid: 5555 } }] } },
      };
    },
    cancel: async () => ({ status: 'ok', response: { type: 'cancel', data: { statuses: ['success'] } } }),
  });

  const res = await c.closePosition('ETHUSDC', 'MH');
  assert.ok(res, 'instant fill returns result');
  assert.equal(res?.orderId, 5555);
  // Maker fee estimate applied (0.015%)
  assert.ok(Math.abs(res!.fee - 0.5 * 3450.5 * constants.HL_MAKER_FEE_RATE) < 1e-6, 'maker fee applied');
  assert.equal(orderCalls, 1, 'only one place call — no step 2/3 needed');
});

test('closePosition(CLOSE_OPP) uses taker IOC (not maker)', async () => {
  // CLOSE_OPP is the close leg of a flip — the calling strategyRunner
  // holds the `flipOpening` mutex for the entire close+open sequence.
  // Routing the close through the maker ladder (240s wait) would block
  // the follow-up entry signal for the full window. CLOSE_OPP must
  // stay on the taker IOC path; only FLAT and MH use the maker ladder.
  const c = await makerMockedClient();
  const orderCalls: Array<Record<string, unknown>> = [];
  c.exchange = fakeExchange({
    order: async (params: { orders: Array<Record<string, unknown>> }) => {
      orderCalls.push(params.orders[0]!);
      return {
        status: 'ok',
        response: { type: 'order', data: { statuses: [{ filled: { totalSz: '0.5', avgPx: '3450', oid: 7777 } }] } },
      };
    },
  });

  await c.closePosition('ETHUSDC', 'CLOSE_OPP');
  assert.equal(orderCalls.length, 1, 'only the taker order — no maker steps');
  const tif = (orderCalls[0]!.t as { limit: { tif: string } }).limit.tif;
  assert.equal(tif, 'Ioc', 'CLOSE_OPP uses Ioc (taker), not Alo (maker)');
});

test('closePosition(non-maker reason) skips maker, goes straight to taker IOC', async () => {
  const c = await makerMockedClient();
  const orderCalls: Array<Record<string, unknown>> = [];
  c.exchange = fakeExchange({
    order: async (params: { orders: Array<Record<string, unknown>> }) => {
      orderCalls.push(params.orders[0]!);
      return {
        status: 'ok',
        response: { type: 'order', data: { statuses: [{ filled: { totalSz: '0.5', avgPx: '3450', oid: 99 } }] } },
      };
    },
  });

  await c.closePosition('ETHUSDC', 'SL');
  assert.equal(orderCalls.length, 1, 'only the taker order — no maker steps');
  const tif = (orderCalls[0]!.t as { limit: { tif: string } }).limit.tif;
  assert.equal(tif, 'Ioc', 'taker uses Ioc (not Alo)');
});

});


describe('close/open execution safety (mocked)', () => {


test('closePosition throws CloseFailedError when every IOC is rejected (position stays open)', async () => {
  const c = await mockedClient();
  let orderCalls = 0;
  c.exchange = fakeExchange({
    order: async () => {
      orderCalls++;
      return { status: 'ok', response: { type: 'order', data: { statuses: [{ error: 'User or API Wallet does not exist' }] } } };
    },
  });
  await assert.rejects(
    c.closePosition('ETHUSDC', 'SL', { expectedSide: 'LONG', expectedSize: 0.5 }),
    (err: unknown) => err instanceof CloseFailedError && err.remainingSize === 0.5 && err.filledSize === 0,
  );
  assert.equal(orderCalls, 3, 'IOC retried 3 times before giving up');
});

test('closePosition retries the IOC on the unfilled remainder after a partial fill', async () => {
  const c = await mockedClient();
  const sizes: number[] = [];
  c.exchange = fakeExchange({
    order: async (params: { orders: Array<Record<string, unknown>> }) => {
      const s = Number(params.orders[0]!.s);
      sizes.push(s);
      const filled = sizes.length === 1 ? 0.2 : s;
      return { status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { totalSz: String(filled), avgPx: '3440', oid: 800 + sizes.length } }] } } };
    },
  });
  const res = await c.closePosition('ETHUSDC', 'SL', { expectedSide: 'LONG', expectedSize: 0.5 });
  assert.deepEqual(sizes, [0.5, 0.3], 'second IOC sized to the remainder');
  assert.ok(res && Math.abs(res.size - 0.5) < 1e-9, 'merged result covers the whole share');
  assert.equal(res?.orderId, 802, 'last oid reported');
});

test('closePosition(FLAT) sweeps the leftover of a >=90% maker fill with a reduce-only IOC', async () => {
  const { c, pos } = await dynamicPositionClient('ETH', 0.5);
  const orders: Array<Record<string, unknown>> = [];
  c.exchange = fakeExchange({
    order: async (params: { orders: Array<Record<string, unknown>> }) => {
      const o = params.orders[0]!;
      orders.push(o);
      const tif = (o.t as { limit: { tif: string } }).limit.tif;
      if (tif === 'Alo') {
        pos.size = 0.02; // 96% of the share filled while resting
        return { status: 'ok', response: { type: 'order', data: { statuses: [{ resting: { oid: 4242 } }] } } };
      }
      pos.size = 0;
      return { status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { totalSz: String(o.s), avgPx: '3450', oid: 4343 } }] } } };
    },
    cancel: async () => ({ status: 'ok', response: { type: 'cancel', data: { statuses: ['success'] } } }),
  });
  const res = await c.closePosition('ETHUSDC', 'FLAT', { expectedSide: 'LONG', expectedSize: 0.5 });
  const ioc = orders.find((o) => (o.t as { limit: { tif: string } }).limit.tif === 'Ioc');
  assert.ok(ioc, 'leftover swept with IOC');
  assert.equal(ioc?.s, '0.0200');
  assert.equal(ioc?.r, true, 'sweep is reduce-only');
  assert.ok(res && Math.abs(res.size - 0.5) < 1e-9);
});

test('closePosition(FLAT): maker ladder partially fills then times out -> IOC closes only the on-chain remainder', async () => {
  const { c, pos } = await dynamicPositionClient('ETH', 0.5);
  const orders: Array<Record<string, unknown>> = [];
  c.exchange = fakeExchange({
    order: async (params: { orders: Array<Record<string, unknown>> }) => {
      const o = params.orders[0]!;
      orders.push(o);
      const tif = (o.t as { limit: { tif: string } }).limit.tif;
      if (tif === 'Alo') {
        pos.size = 0.25; // half fills, never reaches the 90% threshold
        return { status: 'ok', response: { type: 'order', data: { statuses: [{ resting: { oid: 5100 + orders.length } }] } } };
      }
      pos.size = Math.max(0, pos.size - Number(o.s));
      return { status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { totalSz: String(o.s), avgPx: '3449', oid: 5200 } }] } } };
    },
    cancel: async () => ({ status: 'ok', response: { type: 'cancel', data: { statuses: ['success'] } } }),
  });
  const res = await c.closePosition('ETHUSDC', 'FLAT', { expectedSide: 'LONG', expectedSize: 0.5 });
  const iocs = orders.filter((o) => (o.t as { limit: { tif: string } }).limit.tif === 'Ioc');
  assert.equal(iocs.length, 1, 'one IOC');
  assert.equal(iocs[0]?.s, '0.2500', 'IOC sized to what is still open on-chain');
  assert.ok(res && Math.abs(res.size - 0.5) < 1e-9, 'whole share reported closed');
  assert.equal(pos.size, 0);
});

test('closePosition does not throw when the share is already flat on-chain (TP/SL fired meanwhile)', async () => {
  const { c, pos } = await dynamicPositionClient('ETH', 0.5);
  c.exchange = fakeExchange({
    order: async () => {
      pos.size = 0; // on-chain trigger closed it; our reduce-only IOC is rejected
      return { status: 'ok', response: { type: 'order', data: { statuses: [{ error: 'Reduce only order would increase position' }] } } };
    },
  });
  const res = await c.closePosition('ETHUSDC', 'SL', { expectedSide: 'LONG', expectedSize: 0.5 });
  assert.equal(res, null, 'nothing filled by us, but no CloseFailedError');
});

test('maker entry: a still-resting ladder order is cancelled once the fill is detected', async () => {
  const { c, pos } = await dynamicPositionClient('BNB', 0);
  const cancelled: number[] = [];
  const resting = new Set<number>();
  const baseInfo = c.info;
  c.info = fakeInfo({
    ...baseInfo,
    frontendOpenOrders: async () => [...resting].map((oid) => ({ coin: 'BNB', oid, isTrigger: false, reduceOnly: false })),
  });
  c.exchange = fakeExchange({
    updateLeverage: async () => ({ status: 'ok' }),
    order: async () => {
      pos.size = 0.095; // 95% filled; 0.005 still resting
      resting.add(6001);
      return { status: 'ok', response: { type: 'order', data: { statuses: [{ resting: { oid: 6001 } }] } } };
    },
    cancel: async (p: { cancels: Array<{ o: number }> }) => {
      for (const x of p.cancels) { cancelled.push(x.o); resting.delete(x.o); }
      return { status: 'ok', response: { type: 'cancel', data: { statuses: ['success'] } } };
    },
  });
  await c.openLong('BNBUSDC', 67.1, 'test');
  assert.deepEqual(cancelled, [6001], 'leftover resting entry order cancelled');
});

test('open: partial maker fill + taker fallback never exceeds the target size', async () => {
  const { c, pos } = await dynamicPositionClient('BNB', 0);
  const sizes: Array<{ tif: string; s: number }> = [];
  c.exchange = fakeExchange({
    updateLeverage: async () => ({ status: 'ok' }),
    order: async (params: { orders: Array<Record<string, unknown>> }) => {
      const o = params.orders[0]!;
      const tif = (o.t as { limit: { tif: string } }).limit.tif;
      sizes.push({ tif, s: Number(o.s) });
      if (tif === 'Alo' && sizes.length === 1) {
        pos.size = 0.04; // step 1 partially fills 0.04 of 0.1
      }
      if (tif === 'Ioc') {
        pos.size += Number(o.s);
        return { status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { totalSz: String(o.s), avgPx: '671.2', oid: 3131 } }] } } };
      }
      return { status: 'ok', response: { type: 'order', data: { statuses: [{ resting: { oid: 3000 + sizes.length } }] } } };
    },
    cancel: async () => ({ status: 'ok', response: { type: 'cancel', data: { statuses: ['success'] } } }),
  });
  await c.openLong('BNBUSDC', 67.1, 'test');
  assert.deepEqual(sizes.map((x) => x.s), [0.1, 0.06, 0.06, 0.06], 'steps 2-3 and the IOC use the remainder');
  assert.ok(Math.abs(pos.size - 0.1) < 1e-9, `final position ${pos.size} equals the 0.1 target`);
});

test('open sets cross leverage once per coin, clamped to maxLeverage', async () => {
  const c = await mockedClient();
  c.targetLeverage = 50;
  const calls: Array<Record<string, unknown>> = [];
  c.exchange = fakeExchange({
    updateLeverage: async (p: Record<string, unknown>) => { calls.push(p); return { status: 'ok' }; },
    order: async () => ({ status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { totalSz: '0.01', avgPx: '3450', oid: 1 } }] } } }),
  });
  (c as unknown as { maxLeverageByCoin: Map<string, number> }).maxLeverageByCoin.set('ETH', 25);
  await c.openLong('ETHUSDC', 30, 'a');
  await c.openLong('ETHUSDC', 30, 'b');
  assert.equal(calls.length, 1, 'leverage set once');
  assert.deepEqual(calls[0], { asset: 0, isCross: true, leverage: 25 });
});

test('getFundingSince sums only the requested coin', async () => {
  const c = await mockedClient();
  const baseInfo = c.info;
  c.info = fakeInfo({
    ...baseInfo,
    userFunding: async () => ([
      { time: 1, hash: '0x', delta: { type: 'funding', coin: 'ETH', usdc: '-0.5', szi: '1', fundingRate: '0', nSamples: null } },
      { time: 2, hash: '0x', delta: { type: 'funding', coin: 'BNB', usdc: '-9', szi: '1', fundingRate: '0', nSamples: null } },
      { time: 3, hash: '0x', delta: { type: 'funding', coin: 'ETH', usdc: '0.2', szi: '1', fundingRate: '0', nSamples: null } },
    ]),
  });
  const f = await c.getFundingSince('ETH-USD', 0);
  assert.ok(Math.abs(f - -0.3) < 1e-9, `got ${f}`);
});

test('getFundingRates paginates 500-row pages and parses rates', async () => {
  const c = await mockedClient();
  const calls: number[] = [];
  const baseInfo = c.info;
  c.info = fakeInfo({
    ...baseInfo,
    fundingHistory: async ({ startTime }: { startTime: number }) => {
      calls.push(startTime);
      const n = calls.length === 1 ? 500 : 3;
      return Array.from({ length: n }, (_, i) => ({ coin: 'ETH', fundingRate: '0.0000125', premium: '0', time: startTime + i * 3_600_000 }));
    },
  });
  const rows = await c.getFundingRates('ETH-USD', 0, 10_000_000_000);
  assert.equal(rows.length, 503);
  assert.equal(calls.length, 2);
  assert.equal(calls[1], 499 * 3_600_000 + 1);
  assert.ok(Math.abs(rows[0]!.rate - 0.0000125) < 1e-15);
});

});
