/** Native take-profit / stop-loss triggers. */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { HyperliquidExecutor as HlClient } from '../src/index.js';
import { fakeExchange, fakeInfo, mockedClient } from './helpers.js';

describe('placeTPSL (mocked)', () => {

test('placeTPSL emits two orders with positionTpsl grouping', async () => {
  const c = await mockedClient();
  let captured: { orders: Array<Record<string, unknown>>; grouping: string } | null = null;
  c.exchange = fakeExchange({
    order: async (params: { orders: Array<Record<string, unknown>>; grouping: string }) => {
      captured = params;
      return {
        status: 'ok',
        response: {
          type: 'order',
          data: { statuses: [{ resting: { oid: 100 } }, { resting: { oid: 101 } }] },
        },
      };
    },
  });
  const orders = await c.placeTPSL('ETHUSDC', 'LONG', 0.5, 4172.91, 3078.45);
  assert.equal(orders.tp?.clientId, 100);
  assert.equal(orders.sl?.clientId, 101);
  assert.ok(captured);
  const c2 = captured as unknown as { orders: Array<Record<string, unknown>>; grouping: string };
  assert.equal(c2.grouping, 'positionTpsl');
  assert.equal(c2.orders.length, 2);
  // LONG position closes via SELL (b:false) on both TP and SL.
  assert.equal(c2.orders[0]?.b, false);
  assert.equal(c2.orders[1]?.b, false);
  assert.equal(c2.orders[0]?.r, true);
  assert.equal(c2.orders[1]?.r, true);
  // TP is non-market limit; SL is market.
  const t0 = (c2.orders[0]?.t as { trigger: { isMarket: boolean; tpsl: string } }).trigger;
  const t1 = (c2.orders[1]?.t as { trigger: { isMarket: boolean; tpsl: string } }).trigger;
  assert.equal(t0.tpsl, 'tp');
  assert.equal(t0.isMarket, false);
  assert.equal(t1.tpsl, 'sl');
  assert.equal(t1.isMarket, true);
});

test('placeTPSL SL limit price absorbs 5% slippage past the trigger', async () => {
  const c = await mockedClient();
  let captured: { orders: Array<Record<string, unknown>>; grouping: string } | null = null;
  c.exchange = fakeExchange({
    order: async (params: { orders: Array<Record<string, unknown>>; grouping: string }) => {
      captured = params;
      return {
        status: 'ok',
        response: { type: 'order', data: { statuses: [{ resting: { oid: 1 } }, { resting: { oid: 2 } }] } },
      };
    },
  });
  // LONG closes SELL — SL limit must be BELOW trigger by ~5% so a fast
  // candle gap still fills instead of leaving the position open.
  await c.placeTPSL('ETHUSDC', 'LONG', 0.5, 4000, 3000);
  const longSlOrder = (captured as unknown as { orders: Array<Record<string, unknown>> }).orders[1]!;
  const longSlLimit = Number(longSlOrder.p);
  const longSlTrigger = Number((longSlOrder.t as { trigger: { triggerPx: string } }).trigger.triggerPx);
  assert.ok(longSlTrigger - longSlLimit > longSlTrigger * 0.04, `LONG SL: limit ${longSlLimit} must sit ≥4% below trigger ${longSlTrigger}`);

  // SHORT closes BUY — SL limit must be ABOVE trigger by ~5%.
  await c.placeTPSL('ETHUSDC', 'SHORT', 0.5, 3000, 4000);
  const shortSlOrder = (captured as unknown as { orders: Array<Record<string, unknown>> }).orders[1]!;
  const shortSlLimit = Number(shortSlOrder.p);
  const shortSlTrigger = Number((shortSlOrder.t as { trigger: { triggerPx: string } }).trigger.triggerPx);
  assert.ok(shortSlLimit - shortSlTrigger > shortSlTrigger * 0.04, `SHORT SL: limit ${shortSlLimit} must sit ≥4% above trigger ${shortSlTrigger}`);
});

test('placeTPSL for SHORT flips closing side to BUY', async () => {
  const c = await mockedClient();
  let captured: { orders: Array<Record<string, unknown>>; grouping: string } | null = null;
  c.exchange = fakeExchange({
    order: async (params: { orders: Array<Record<string, unknown>>; grouping: string }) => {
      captured = params;
      return {
        status: 'ok',
        response: { type: 'order', data: { statuses: [{ resting: { oid: 200 } }, { resting: { oid: 201 } }] } },
      };
    },
  });
  await c.placeTPSL('BNBUSDC', 'SHORT', 2.75, 603.99, 697.95);
  const c2 = captured as unknown as { orders: Array<Record<string, unknown>>; grouping: string };
  assert.equal(c2.orders[0]?.b, true); // SHORT closes via BUY
  assert.equal(c2.orders[1]?.b, true);
});

test('placeTPSL resolves oids from open orders when HL acks "waitingForTrigger"', async () => {
  const c = await mockedClient();
  const baseInfo = c.info;
  c.info = fakeInfo({
    ...baseInfo,
    frontendOpenOrders: async () => ([
      { coin: 'ETH', oid: 10, orderType: 'Take Profit Limit', triggerPx: '3800', isTrigger: true, reduceOnly: true },
      { coin: 'ETH', oid: 21, orderType: 'Take Profit Limit', triggerPx: '3800', isTrigger: true, reduceOnly: true },
      { coin: 'ETH', oid: 22, orderType: 'Stop Market', triggerPx: '3300', isTrigger: true, reduceOnly: true },
      { coin: 'BNB', oid: 99, orderType: 'Stop Market', triggerPx: '3300', isTrigger: true, reduceOnly: true },
    ]),
  });
  c.exchange = fakeExchange({
    order: async () => ({ status: 'ok', response: { type: 'order', data: { statuses: ['waitingForTrigger', 'waitingForTrigger'] } } }),
  });
  const res = await c.placeTPSL('ETHUSDC', 'LONG', 0.5, 3800, 3300);
  assert.deepEqual(res, { tp: { clientId: 21, goodTilSec: 0 }, sl: { clientId: 22, goodTilSec: 0 } });
});

});


describe('cancelTPSLOrder (mocked)', () => {

test('cancelTPSLOrder skips when clientId is null', async () => {
  const c = await mockedClient();
  let cancelCalled = false;
  c.exchange = fakeExchange({
    cancel: async () => {
      cancelCalled = true;
      return { status: 'ok', response: { type: 'cancel', data: { statuses: ['success'] } } };
    },
  });
  await c.cancelTPSLOrder('ETHUSDC', null, 'tp', 0);
  assert.equal(cancelCalled, false);
});

test('cancelTPSLOrder issues cancel by oid', async () => {
  const c = await mockedClient();
  let captured: { cancels: Array<Record<string, unknown>> } | null = null;
  c.exchange = fakeExchange({
    cancel: async (params: { cancels: Array<Record<string, unknown>> }) => {
      captured = params;
      return { status: 'ok', response: { type: 'cancel', data: { statuses: ['success'] } } };
    },
  });
  await c.cancelTPSLOrder('ETHUSDC', 12345, 'tp', 0);
  assert.ok(captured);
  const cap2 = captured as unknown as { cancels: Array<Record<string, unknown>> };
  assert.equal(cap2.cancels.length, 1);
  assert.equal(cap2.cancels[0]?.a, 0);
  assert.equal(cap2.cancels[0]?.o, 12345);
});

});
