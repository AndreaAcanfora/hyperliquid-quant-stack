/** Fill lookups, aggregation and the WebSocket fill cache. */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { HyperliquidExecutor as HlClient } from '../src/index.js';
import { FAKE_AGENT, fakeExchange, fakeInfo, makerMockedClient } from './helpers.js';

describe('getFillsForOrder (mocked userFills)', () => {

test('aggregates a single-fill order into avg + total fee + closedPnl', async () => {
  const c = new HlClient();
  c.info = fakeInfo({
    userFills: async () => [
      // Mix of unrelated oids — only oid=42 matches the target.
      { oid: 99, px: '3000', sz: '1', side: 'B', fee: '0.5', closedPnl: '0', crossed: true, time: 1_000, hash: '0xaaa' },
      { oid: 42, px: '3050', sz: '0.5', side: 'A', fee: '0.31', closedPnl: '24.69', crossed: true, time: 2_000, hash: '0xbbb' },
    ],
  });
  c.accountAddress = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  c.exchange = fakeExchange({});
  c.agentAccount = FAKE_AGENT;

  const agg = await c.getFillsForOrder(42, { pollMaxMs: 100, pollIntervalMs: 10 });
  assert.ok(agg, 'expected aggregate, got null');
  assert.equal(agg!.oid, 42);
  assert.equal(agg!.fills.length, 1);
  assert.equal(agg!.totalSize, 0.5);
  assert.equal(agg!.avgPrice, 3050);
  assert.equal(agg!.totalFee, 0.31);
  assert.equal(agg!.totalClosedPnl, 24.69);
  assert.equal(agg!.wasTaker, true);
  assert.deepEqual(agg!.txHashes, ['0xbbb']);
});

test('aggregates multiple partial fills into weighted-avg price + summed fee', async () => {
  const c = new HlClient();
  c.info = fakeInfo({
    userFills: async () => [
      { oid: 7, px: '3000', sz: '0.4', side: 'B', fee: '0.24', closedPnl: '0', crossed: false, time: 1_000, hash: '0x111' },
      { oid: 7, px: '3010', sz: '0.6', side: 'B', fee: '0.36', closedPnl: '0', crossed: false, time: 1_500, hash: '0x222' },
    ],
  });
  c.accountAddress = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  c.exchange = fakeExchange({});
  c.agentAccount = FAKE_AGENT;

  const agg = await c.getFillsForOrder(7, { pollMaxMs: 100, pollIntervalMs: 10 });
  assert.ok(agg);
  // Weighted: (3000×0.4 + 3010×0.6) / 1.0 = 3006
  assert.equal(agg!.avgPrice, 3006);
  assert.equal(agg!.totalSize, 1.0);
  assert.ok(Math.abs(agg!.totalFee - 0.6) < 1e-9, `fee=${agg!.totalFee}`);
  assert.equal(agg!.wasTaker, false, 'both fills crossed=false → pure maker');
  assert.equal(agg!.txHashes.length, 2);
  assert.equal(agg!.firstFillTime, 1_000);
  assert.equal(agg!.lastFillTime, 1_500);
});

test('mixed maker + taker partials → wasTaker=true (any crossed=true wins)', async () => {
  const c = new HlClient();
  c.info = fakeInfo({
    userFills: async () => [
      { oid: 11, px: '100', sz: '1', side: 'B', fee: '0.02', closedPnl: '0', crossed: false, time: 1_000, hash: '0xa' },
      { oid: 11, px: '101', sz: '1', side: 'B', fee: '0.045', closedPnl: '0', crossed: true,  time: 1_100, hash: '0xb' },
    ],
  });
  c.accountAddress = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  c.exchange = fakeExchange({});
  c.agentAccount = FAKE_AGENT;

  const agg = await c.getFillsForOrder(11, { pollMaxMs: 100, pollIntervalMs: 10 });
  assert.ok(agg);
  assert.equal(agg!.wasTaker, true);
});

test('returns null when no fills match the oid within poll window', async () => {
  const c = new HlClient();
  c.info = fakeInfo({
    userFills: async () => [
      { oid: 1, px: '100', sz: '1', side: 'B', fee: '0', closedPnl: '0', crossed: false, time: 1, hash: '' },
    ],
  });
  c.accountAddress = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  c.exchange = fakeExchange({});
  c.agentAccount = FAKE_AGENT;

  const agg = await c.getFillsForOrder(999, { pollMaxMs: 50, pollIntervalMs: 10 });
  assert.equal(agg, null);
});

test('retries on transient userFills error and succeeds when fill appears', async () => {
  const c = new HlClient();
  let calls = 0;
  c.info = fakeInfo({
    userFills: async () => {
      calls++;
      if (calls < 2) throw new Error('rate limited');
      return [{ oid: 5, px: '50', sz: '2', side: 'A', fee: '0.045', closedPnl: '10', crossed: true, time: 1, hash: '0xc' }];
    },
  });
  c.accountAddress = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  c.exchange = fakeExchange({});
  c.agentAccount = FAKE_AGENT;

  const agg = await c.getFillsForOrder(5, { pollMaxMs: 500, pollIntervalMs: 10 });
  assert.ok(agg, `expected aggregate after retry, calls=${calls}`);
  assert.equal(agg!.totalClosedPnl, 10);
});

});


describe('getFillsByTime (mocked userFillsByTime)', () => {

test('forwards startMs / endMs and normalizes string numerics', async () => {
  const c = new HlClient();
  let captured: { startTime?: number; endTime?: number } = {};
  c.info = fakeInfo({
    userFillsByTime: async (params: { startTime: number; endTime?: number }) => {
      captured = params;
      return [
        { oid: 1, px: '3000', sz: '0.5', side: 'B', fee: '0.30', closedPnl: '0', crossed: false, time: 1_700, hash: '0x111' },
      ];
    },
  });
  c.accountAddress = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  c.exchange = fakeExchange({});
  c.agentAccount = FAKE_AGENT;

  const fills = await c.getFillsByTime(1_000, 2_000);
  assert.equal(captured.startTime, 1_000);
  assert.equal(captured.endTime, 2_000);
  assert.equal(fills.length, 1);
  assert.equal(fills[0]!.px, 3000);
  assert.equal(fills[0]!.sz, 0.5);
  assert.equal(fills[0]!.fee, 0.3);
  assert.equal(fills[0]!.crossed, false);
});

test('omits endTime when not supplied', async () => {
  const c = new HlClient();
  let captured: { startTime?: number; endTime?: number } = {};
  c.info = fakeInfo({
    userFillsByTime: async (params: { startTime: number; endTime?: number }) => {
      captured = params;
      return [];
    },
  });
  c.accountAddress = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  c.exchange = fakeExchange({});
  c.agentAccount = FAKE_AGENT;

  await c.getFillsByTime(1_000);
  assert.equal(captured.startTime, 1_000);
  assert.equal(captured.endTime, undefined);
});

});


describe('WS fill cache', () => {

test('_resolveFillFee returns cached WS fee before falling back to poll', async () => {
  const c = await makerMockedClient();
  // userFills stub on info returns [] so the poll fallback would yield
  // the estimate. The cache hit must be what produces the asserted fee.
  c.info = fakeInfo({
    ...c.info,
    userFills: async () => [],
  });
  // The cache check is gated behind subClient !== null (skipped when the
  // WS subscription isn't active, to avoid 200ms of wasted polling on
  // every fee resolution). Tests set a stub to satisfy the gate.
  c.subClient = {} as unknown as typeof c.subClient;
  // Pre-populate the WS cache via the same shape the real handler stores
  // (one partial fill for oid 8888, fee = $0.42).
  const cache = (c as unknown as { fillCacheByOid: Map<number, Array<Record<string, unknown>>> }).fillCacheByOid;
  cache.set(8888, [{
    oid: 8888, px: '3450', sz: '0.5', side: 'A', fee: '0.42',
    closedPnl: '0', crossed: false, time: Date.now(), hash: '0xcache',
  }]);

  c.exchange = fakeExchange({
    order: async () => ({
      status: 'ok',
      response: { type: 'order', data: { statuses: [{ filled: { totalSz: '0.5', avgPx: '3450', oid: 8888 } }] } },
    }),
    cancel: async () => ({ status: 'ok', response: { type: 'cancel', data: { statuses: ['success'] } } }),
  });

  const res = await c.closePosition('ETHUSDC', 'FLAT');
  assert.ok(res, 'maker close returns result on instant fill');
  // Cache had fee=0.42 — _resolveFillFee should pick that over the
  // estimate (0.5 * 3450 * 0.0002 = 0.345).
  assert.ok(Math.abs(res!.fee - 0.42) < 1e-6, `cached fee 0.42 used, got ${res!.fee}`);
});

test('_onUserFillsEvent caches fills by oid with FIFO eviction', async () => {
  const c = new HlClient();
  const handler = (c as unknown as { _onUserFillsEvent: (data: { fills: Array<Record<string, unknown>> }) => void })._onUserFillsEvent.bind(c);
  const cache = (c as unknown as { fillCacheByOid: Map<number, unknown> }).fillCacheByOid;

  handler({ fills: [{ oid: 1, px: '100', sz: '1', side: 'B', fee: '0.1', closedPnl: '0', crossed: false, time: 1, hash: '0x1' }] });
  handler({ fills: [{ oid: 1, px: '100', sz: '0.5', side: 'B', fee: '0.05', closedPnl: '0', crossed: false, time: 2, hash: '0x2' }] });
  const stored = cache.get(1) as Array<unknown>;
  assert.equal(stored.length, 2, 'partial fills for same oid accumulate');

  // Force FIFO eviction by exceeding fillCacheMaxSize=1000.
  (c as unknown as { fillCacheMaxSize: number }).fillCacheMaxSize = 2;
  handler({ fills: [{ oid: 2, px: '100', sz: '1', side: 'B', fee: '0.1', closedPnl: '0', crossed: false, time: 3, hash: '0x3' }] });
  handler({ fills: [{ oid: 3, px: '100', sz: '1', side: 'B', fee: '0.1', closedPnl: '0', crossed: false, time: 4, hash: '0x4' }] });
  assert.equal(cache.size, 2, 'oldest oid evicted on overflow');
  assert.ok(!cache.has(1), 'oid 1 (oldest) was evicted');
  assert.ok(cache.has(2) && cache.has(3), 'oid 2 and 3 retained');
});
});
