/**
 * Unit tests for HyperliquidExecutor: pure helpers plus SDK orchestration
 * against mocked `info` / `exchange` clients (no network).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { CloseFailedError, HyperliquidExecutor as HlClient } from '../src/index.js';

const AGENT_KEY = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const ACCOUNT = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

async function mockedClient(): Promise<InstanceType<typeof HlClient>> {
  const c = new HlClient();
  c.info = {
    spotClearinghouseState: async () => ({ balances: [] }),
    // szDecimals per HL universe spec — required by _formatSize since
    // the #57 fix made the cache-miss path throw rather than guess.
    meta: async () => ({
      universe: [
        { name: 'ETH', szDecimals: 4 },
        { name: 'BNB', szDecimals: 3 },
      ],
    }),
    // Stubbed userFills used by _resolveFillFee (#56). Returning [] makes
    // the helper fall through to its estimated-fee path, which keeps the
    // existing per-test fee assertions stable.
    userFills: async () => [],
    metaAndAssetCtxs: async () => ([
      { universe: [{ name: 'ETH' }, { name: 'BNB' }] },
      [
        { markPx: '3450', midPx: '3450', prevDayPx: '0', dayNtlVlm: '0', funding: '0', openInterest: '0' },
        { markPx: '671', midPx: '671', prevDayPx: '0', dayNtlVlm: '0', funding: '0', openInterest: '0' },
      ],
    ]),
    clearinghouseState: async () => ({
      marginSummary: { accountValue: '100', totalNtlPos: '0', totalRawUsd: '100', totalMarginUsed: '0' },
      crossMarginSummary: { accountValue: '100', totalNtlPos: '0', totalRawUsd: '100', totalMarginUsed: '0' },
      crossMaintenanceMarginUsed: '0',
      withdrawable: '100',
      assetPositions: [
        { type: 'oneWay', position: { coin: 'ETH', szi: '0.5', entryPx: '3450', leverage: { type: 'isolated', value: 3, rawUsd: '0' } } },
      ],
      time: Date.now(),
    }),
    // BBO matching the oracle prices in metaAndAssetCtxs (ETH=$3450, BNB=$671).
    // Tick at ETH=$3450 is $0.1, so a $0.5-wide spread accommodates the 3-step walk.
    l2Book: async ({ coin }: { coin: string }) => {
      if (coin === 'ETH') {
        return {
          coin: 'ETH',
          time: Date.now(),
          levels: [
            [{ px: '3449.7', sz: '1', n: 1 }],
            [{ px: '3450.3', sz: '1', n: 1 }],
          ],
        };
      }
      if (coin === 'BNB') {
        return {
          coin: 'BNB',
          time: Date.now(),
          levels: [
            [{ px: '670.95', sz: '1', n: 1 }],
            [{ px: '671.05', sz: '1', n: 1 }],
          ],
        };
      }
      return null;
    },
  } as unknown as typeof c.info;
  c.mainAddress = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  c.agentAccount = { address: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' } as unknown as typeof c.agentAccount;
  // Placeholder exchange to satisfy _requireConnected during the index
  // warm-up; individual tests overwrite this with a behavior-asserting stub.
  c.exchange = {} as unknown as typeof c.exchange;
  // Pre-warm asset index so tests don't depend on lazy refresh order.
  await (c as unknown as { _refreshAssetIndex: () => Promise<void> })._refreshAssetIndex();
  return c;
}

async function makerMockedClient(): Promise<InstanceType<typeof HlClient>> {
  const c = await mockedClient();
  // Tight defaults so unit tests don't sleep for 4 minutes.
  c.makerCloseMaxWaitMs = 90;
  c.makerCloseFillCheckIntervalMs = 10;
  c.makerCloseStepCount = 3;
  return c;
}

// Mocked client whose on-chain position size is read from a mutable
// holder, so tests can simulate partial fills between polls.
async function dynamicPositionClient(
  coin: 'ETH' | 'BNB',
  initial: number,
): Promise<{ c: InstanceType<typeof HlClient>; pos: { size: number } }> {
  const c = await makerMockedClient();
  const pos = { size: initial };
  const baseInfo = c.info;
  c.info = {
    ...baseInfo,
    clearinghouseState: async () => ({
      marginSummary: { accountValue: '100', totalNtlPos: '0', totalRawUsd: '100', totalMarginUsed: '0' },
      crossMarginSummary: { accountValue: '100', totalNtlPos: '0', totalRawUsd: '100', totalMarginUsed: '0' },
      crossMaintenanceMarginUsed: '0',
      withdrawable: '100',
      assetPositions: pos.size === 0 ? [] : [
        { type: 'oneWay', position: { coin, szi: String(pos.size), entryPx: coin === 'ETH' ? '3450' : '671', leverage: { type: 'cross', value: 5 } } },
      ],
      time: Date.now(),
    }),
  } as unknown as typeof c.info;
  return { c, pos };
}

describe('toMarketKey', () => {

test('USDC suffix → dYdX market', () => {
  const c = new HlClient();
  assert.equal(c.toMarketKey('ETHUSDC'), 'ETH-USD');
  assert.equal(c.toMarketKey('SOLUSDC'), 'SOL-USD');
  assert.equal(c.toMarketKey('BNBUSDC'), 'BNB-USD');
  assert.equal(c.toMarketKey('BTCUSDC'), 'BTC-USD');
});

test('USDT suffix → dYdX market', () => {
  const c = new HlClient();
  assert.equal(c.toMarketKey('ETHUSDT'), 'ETH-USD');
});

test('already-dYdX format passes through', () => {
  const c = new HlClient();
  assert.equal(c.toMarketKey('ETH-USD'), 'ETH-USD');
});

test('unknown <BASE>USDC fallback', () => {
  const c = new HlClient();
  assert.equal(c.toMarketKey('DOGEUSDC'), 'DOGE-USD');
});

test('unknown format returned verbatim', () => {
  const c = new HlClient();
  assert.equal(c.toMarketKey('FAKE'), 'FAKE');
});

});

describe('connect()', () => {

test('connect() without credentials explains how to provide them', async () => {
  const c = new HlClient();
  await assert.rejects(c.connect(), /no credentials/i);
});

test('rejects malformed private key', async () => {
  const c = new HlClient();
  await assert.rejects(c.connectWithCredentials({ agentPrivateKey: '0xnothex', accountAddress: ACCOUNT }), /private key/);
});

test('rejects malformed account address', async () => {
  const c = new HlClient();
  await assert.rejects(c.connectWithCredentials({ agentPrivateKey: AGENT_KEY, accountAddress: '0xshort' }), /account address/);
});

test('rejects malformed vault address', async () => {
  const c = new HlClient();
  await assert.rejects(
    c.connectWithCredentials({ agentPrivateKey: AGENT_KEY, accountAddress: ACCOUNT, vaultAddress: '0x123' }),
    /vault address/,
  );
});

});

describe('getBalance (mocked info client)', () => {

test('parses clearinghouseState into ExchangeBalance shape', async () => {
  const c = new HlClient();
  // Bypass connect() by attaching mock clients directly.
  c.info = {
    spotClearinghouseState: async () => ({ balances: [] }),
    clearinghouseState: async () => ({
      marginSummary: { accountValue: '105.50', totalNtlPos: '0', totalRawUsd: '105.50', totalMarginUsed: '0' },
      crossMarginSummary: { accountValue: '105.50', totalNtlPos: '0', totalRawUsd: '105.50', totalMarginUsed: '0' },
      crossMaintenanceMarginUsed: '0',
      withdrawable: '52.25',
      assetPositions: [
        {
          type: 'oneWay',
          position: { coin: 'BNB', szi: '-2.75', entryPx: '671.10', leverage: { type: 'isolated', value: 5, rawUsd: '0' } },
        },
        {
          type: 'oneWay',
          position: { coin: 'ETH', szi: '0', entryPx: null, leverage: { type: 'isolated', value: 5, rawUsd: '0' } },
        },
      ],
      time: Date.now(),
    }),
  } as unknown as typeof c.info;
  c.mainAddress = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  c.exchange = {} as typeof c.exchange;
  c.agentAccount = { address: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' } as unknown as typeof c.agentAccount;

  const bal = await c.getBalance();
  assert.equal(bal.equity, 105.5);
  assert.equal(bal.freeCollateral, 52.25);
  // ETH at szi=0 is filtered out; only BNB shows up as a position.
  assert.equal(Object.keys(bal.positions).length, 1);
  assert.deepEqual(bal.positions['BNB-USD'], {
    side: 'SHORT',
    size: '2.75',
    entryPrice: '671.10',
  });
});

test('unified margin: equity = spot.total, free = tokenToAvailableAfterMaintenance (NOT perp+spot — #80 double-count)', async () => {
  // Unified-margin account shape: spot USDC total $10,000 already includes
  // the $4,000 held as cross collateral; perp accountValue $3,900 is that
  // SAME held slice ± uPnL. Summing perp+spot ($13,900) was the bug.
  const c = new HlClient();
  c.info = {
    spotClearinghouseState: async () => ({
      balances: [{ coin: 'USDC', total: '10000', hold: '4000' }],
      tokenToAvailableAfterMaintenance: [[0, '9900']],
    }),
    clearinghouseState: async () => ({
      marginSummary: { accountValue: '3900', totalNtlPos: '4000', totalRawUsd: '0', totalMarginUsed: '4000' },
      crossMarginSummary: { accountValue: '3900', totalNtlPos: '4000', totalRawUsd: '0', totalMarginUsed: '4000' },
      crossMaintenanceMarginUsed: '49.37',
      withdrawable: '0.0',
      assetPositions: [
        { type: 'oneWay', position: { coin: 'SOL', szi: '-15.1', entryPx: '64.554', leverage: { type: 'cross', value: 3, rawUsd: '0' } } },
      ],
      time: Date.now(),
    }),
  } as unknown as typeof c.info;
  c.mainAddress = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  c.exchange = {} as typeof c.exchange;
  c.agentAccount = { address: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' } as unknown as typeof c.agentAccount;

  const bal = await c.getBalance();
  assert.equal(bal.equity, 10000, 'equity must be spot.total, not perp+spot ($13,900)');
  assert.equal(bal.freeCollateral, 9900, 'free must be available-after-maintenance');
});

test('unified margin: free falls back to spot.total when tokenToAvailableAfterMaintenance absent', async () => {
  const c = new HlClient();
  c.info = {
    spotClearinghouseState: async () => ({
      balances: [{ coin: 'USDC', total: '1000', hold: '0' }],
    }),
    clearinghouseState: async () => ({
      marginSummary: { accountValue: '0', totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' },
      crossMarginSummary: { accountValue: '0', totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' },
      crossMaintenanceMarginUsed: '0',
      withdrawable: '0.0',
      assetPositions: [],
      time: Date.now(),
    }),
  } as unknown as typeof c.info;
  c.mainAddress = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  c.exchange = {} as typeof c.exchange;
  c.agentAccount = { address: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' } as unknown as typeof c.agentAccount;

  const bal = await c.getBalance();
  assert.equal(bal.equity, 1000);
  assert.equal(bal.freeCollateral, 1000);
});

test('getPositions delegates to getBalance', async () => {
  const c = new HlClient();
  c.info = {
    spotClearinghouseState: async () => ({ balances: [] }),
    clearinghouseState: async () => ({
      marginSummary: { accountValue: '100', totalNtlPos: '0', totalRawUsd: '100', totalMarginUsed: '0' },
      crossMarginSummary: { accountValue: '100', totalNtlPos: '0', totalRawUsd: '100', totalMarginUsed: '0' },
      crossMaintenanceMarginUsed: '0',
      withdrawable: '100',
      assetPositions: [
        {
          type: 'oneWay',
          position: { coin: 'ETH', szi: '0.5', entryPx: '3400', leverage: { type: 'isolated', value: 3, rawUsd: '0' } },
        },
      ],
      time: Date.now(),
    }),
  } as unknown as typeof c.info;
  c.mainAddress = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  c.exchange = {} as typeof c.exchange;
  c.agentAccount = { address: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' } as unknown as typeof c.agentAccount;

  const pos = await c.getPositions();
  assert.equal(pos['ETH-USD']?.side, 'LONG');
  assert.equal(pos['ETH-USD']?.size, '0.5');
});

});

describe('getOraclePrice (mocked)', () => {

test('returns markPx for requested coin', async () => {
  const c = new HlClient();
  c.info = {
    spotClearinghouseState: async () => ({ balances: [] }),
    meta: async () => ({ universe: [{ name: 'BTC' }, { name: 'ETH' }, { name: 'BNB' }] }),
    metaAndAssetCtxs: async () => ([
      { universe: [{ name: 'BTC' }, { name: 'ETH' }, { name: 'BNB' }] },
      [
        { markPx: '95000', midPx: '95000', prevDayPx: '0', dayNtlVlm: '0', funding: '0', openInterest: '0' },
        { markPx: '3450.25', midPx: '3450', prevDayPx: '0', dayNtlVlm: '0', funding: '0', openInterest: '0' },
        { markPx: '671.10', midPx: '671', prevDayPx: '0', dayNtlVlm: '0', funding: '0', openInterest: '0' },
      ],
    ]),
  } as unknown as typeof c.info;
  c.mainAddress = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  c.exchange = {} as typeof c.exchange;
  c.agentAccount = { address: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' } as unknown as typeof c.agentAccount;

  assert.equal(await c.getOraclePrice('ETH-USD'), 3450.25);
  assert.equal(await c.getOraclePrice('BNB-USD'), 671.10);
});

});

describe('getCandles interval mapping (mocked)', () => {

test('maps 4HOURS to HL 4h and shapes response in dYdX form', async () => {
  const c = new HlClient();
  let capturedInterval: string | null = null;
  c.info = {
    spotClearinghouseState: async () => ({ balances: [] }),
    meta: async () => ({ universe: [{ name: 'ETH' }] }),
    candleSnapshot: async (params: { coin: string; interval: string }) => {
      capturedInterval = params.interval;
      return [
        { t: 1_700_000_000_000, T: 1_700_014_400_000, s: 'ETH', i: '4h', o: '3400', c: '3450', h: '3455', l: '3395', v: '100.5', n: 200 },
      ];
    },
  } as unknown as typeof c.info;
  c.mainAddress = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  c.exchange = {} as typeof c.exchange;
  c.agentAccount = { address: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' } as unknown as typeof c.agentAccount;

  const candles = (await c.getCandles('ETH-USD', '4HOURS', 10)) as Array<Record<string, unknown>>;
  assert.equal(capturedInterval, '4h');
  assert.equal(candles.length, 1);
  assert.equal(candles[0]?.open, '3400');
  assert.equal(candles[0]?.high, '3455');
  assert.equal(candles[0]?.low, '3395');
  assert.equal(candles[0]?.close, '3450');
  assert.equal(candles[0]?.resolution, '4HOURS');
});

test('unknown resolution falls back to 4h', async () => {
  const c = new HlClient();
  let capturedInterval: string | null = null;
  c.info = {
    spotClearinghouseState: async () => ({ balances: [] }),
    meta: async () => ({ universe: [{ name: 'ETH' }] }),
    candleSnapshot: async (params: { coin: string; interval: string }) => {
      capturedInterval = params.interval;
      return [];
    },
  } as unknown as typeof c.info;
  c.mainAddress = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  c.exchange = {} as typeof c.exchange;
  c.agentAccount = { address: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' } as unknown as typeof c.agentAccount;
  await c.getCandles('ETH-USD', 'WEIRD', 1);
  assert.equal(capturedInterval, '4h');
});

});

describe('openLong / openShort (mocked exchange)', () => {


test('openLong posts a buy IOC at slightly-above-mark price', async () => {
  const c = await mockedClient();
  let captured: { orders: unknown[]; grouping: string } | null = null;
  c.exchange = {
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
  } as unknown as typeof c.exchange;
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
  c.makerCloseMaxWaitMs = 90;
  c.makerCloseFillCheckIntervalMs = 10;
  let captured: { orders: Array<Record<string, unknown>>; grouping: string } | null = null;
  c.exchange = {
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
  } as unknown as typeof c.exchange;
  await c.openShort('BNBUSDC', 50, 'test');
  assert.ok(captured);
  const c2 = captured as unknown as { orders: Array<Record<string, unknown>>; grouping: string };
  assert.equal(c2.orders[0]?.b, false); // short
  assert.equal(c2.orders[0]?.a, 1); // BNB asset idx
});

test('openLong handles error status without throwing', async () => {
  const c = await mockedClient();
  c.exchange = {
    order: async () => ({
      status: 'ok',
      response: { type: 'order', data: { statuses: [{ error: 'min notional' }] } },
    }),
  } as unknown as typeof c.exchange;
  const res = await c.openLong('ETHUSDC', 1, 'test');
  assert.equal(res, null);
});

});

describe('closePosition (mocked)', () => {

test('closePosition reads current side + flips it with reduce-only IOC', async () => {
  const c = await mockedClient();
  let captured: { orders: Array<Record<string, unknown>> } | null = null;
  c.exchange = {
    order: async (params: { orders: Array<Record<string, unknown>>; grouping: string }) => {
      captured = params;
      return {
        status: 'ok',
        response: { type: 'order', data: { statuses: [{ filled: { totalSz: '0.5', avgPx: '3445', oid: 777 } }] } },
      };
    },
  } as unknown as typeof c.exchange;
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
  c.info = {
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
  } as unknown as typeof c.info;
  const res = await c.closePosition('ETHUSDC', 'no pos');
  assert.equal(res, null);
});

});

describe('placeTPSL (mocked)', () => {

test('placeTPSL emits two orders with positionTpsl grouping', async () => {
  const c = await mockedClient();
  let captured: { orders: Array<Record<string, unknown>>; grouping: string } | null = null;
  c.exchange = {
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
  } as unknown as typeof c.exchange;
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
  c.exchange = {
    order: async (params: { orders: Array<Record<string, unknown>>; grouping: string }) => {
      captured = params;
      return {
        status: 'ok',
        response: { type: 'order', data: { statuses: [{ resting: { oid: 1 } }, { resting: { oid: 2 } }] } },
      };
    },
  } as unknown as typeof c.exchange;
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
  c.exchange = {
    order: async (params: { orders: Array<Record<string, unknown>>; grouping: string }) => {
      captured = params;
      return {
        status: 'ok',
        response: { type: 'order', data: { statuses: [{ resting: { oid: 200 } }, { resting: { oid: 201 } }] } },
      };
    },
  } as unknown as typeof c.exchange;
  await c.placeTPSL('BNBUSDC', 'SHORT', 2.75, 603.99, 697.95);
  const c2 = captured as unknown as { orders: Array<Record<string, unknown>>; grouping: string };
  assert.equal(c2.orders[0]?.b, true); // SHORT closes via BUY
  assert.equal(c2.orders[1]?.b, true);
});

test('placeTPSL resolves oids from open orders when HL acks "waitingForTrigger"', async () => {
  const c = await mockedClient();
  const baseInfo = c.info;
  c.info = {
    ...baseInfo,
    frontendOpenOrders: async () => ([
      { coin: 'ETH', oid: 10, orderType: 'Take Profit Limit', triggerPx: '3800', isTrigger: true, reduceOnly: true },
      { coin: 'ETH', oid: 21, orderType: 'Take Profit Limit', triggerPx: '3800', isTrigger: true, reduceOnly: true },
      { coin: 'ETH', oid: 22, orderType: 'Stop Market', triggerPx: '3300', isTrigger: true, reduceOnly: true },
      { coin: 'BNB', oid: 99, orderType: 'Stop Market', triggerPx: '3300', isTrigger: true, reduceOnly: true },
    ]),
  } as unknown as typeof c.info;
  c.exchange = {
    order: async () => ({ status: 'ok', response: { type: 'order', data: { statuses: ['waitingForTrigger', 'waitingForTrigger'] } } }),
  } as unknown as typeof c.exchange;
  const res = await c.placeTPSL('ETHUSDC', 'LONG', 0.5, 3800, 3300);
  assert.deepEqual(res, { tp: { clientId: 21, goodTilSec: 0 }, sl: { clientId: 22, goodTilSec: 0 } });
});

});

describe('cancelTPSLOrder (mocked)', () => {

test('cancelTPSLOrder skips when clientId is null', async () => {
  const c = await mockedClient();
  let cancelCalled = false;
  c.exchange = {
    cancel: async () => {
      cancelCalled = true;
      return { status: 'ok', response: { type: 'cancel', data: { statuses: ['success'] } } };
    },
  } as unknown as typeof c.exchange;
  await c.cancelTPSLOrder('ETHUSDC', null, 'tp', 0);
  assert.equal(cancelCalled, false);
});

test('cancelTPSLOrder issues cancel by oid', async () => {
  const c = await mockedClient();
  let captured: { cancels: Array<Record<string, unknown>> } | null = null;
  c.exchange = {
    cancel: async (params: { cancels: Array<Record<string, unknown>> }) => {
      captured = params;
      return { status: 'ok', response: { type: 'cancel', data: { statuses: ['success'] } } };
    },
  } as unknown as typeof c.exchange;
  await c.cancelTPSLOrder('ETHUSDC', 12345, 'tp', 0);
  assert.ok(captured);
  const cap2 = captured as unknown as { cancels: Array<Record<string, unknown>> };
  assert.equal(cap2.cancels.length, 1);
  assert.equal(cap2.cancels[0]?.a, 0);
  assert.equal(cap2.cancels[0]?.o, 12345);
});

});

describe('_priceTick (5-sig-fig rule)', () => {

test('_priceTick at $640 → $0.01', () => {
  const c = new HlClient();
  const t = (c as unknown as { _priceTick: (p: number) => number })._priceTick(640);
  assert.ok(Math.abs(t - 0.01) < 1e-12, `expected ~0.01, got ${t}`);
});

test('_priceTick at $4000 → $0.1', () => {
  const c = new HlClient();
  const t = (c as unknown as { _priceTick: (p: number) => number })._priceTick(4000);
  assert.ok(Math.abs(t - 0.1) < 1e-12, `expected ~0.1, got ${t}`);
});

test('_priceTick at $200 → $0.01', () => {
  const c = new HlClient();
  const t = (c as unknown as { _priceTick: (p: number) => number })._priceTick(200);
  assert.ok(Math.abs(t - 0.01) < 1e-12);
});

test('_priceTick at $100,000 → $10', () => {
  const c = new HlClient();
  const t = (c as unknown as { _priceTick: (p: number) => number })._priceTick(100_000);
  assert.ok(Math.abs(t - 10) < 1e-9);
});

test('_priceTick at $0 / negative falls back safely', () => {
  const c = new HlClient();
  const fn = (c as unknown as { _priceTick: (p: number) => number })._priceTick.bind(c);
  assert.equal(fn(0), 0.01);
  assert.equal(fn(-5), 0.01);
  assert.equal(fn(NaN), 0.01);
});

});

describe('_stepPrice (step-aggressive direction)', () => {

type StepPriceFn = (
  bbo: { bestBid: number; bestAsk: number } | null,
  oracle: number,
  side: 'BUY' | 'SELL',
  step: number,
) => number;

test('_stepPrice BUY (no BBO): each step bumps oracle UP by one tick', () => {
  const c = new HlClient();
  const fn = (c as unknown as { _stepPrice: StepPriceFn })._stepPrice.bind(c);
  // BNB at $640.025 → tick $0.01. No BBO → legacy oracle-based fallback.
  assert.ok(Math.abs(fn(null, 640.025, 'BUY', 1) - 640.025) < 1e-9, 'step1 = oracle');
  assert.ok(Math.abs(fn(null, 640.025, 'BUY', 2) - 640.035) < 1e-9, 'step2 = oracle + 1 tick');
  assert.ok(Math.abs(fn(null, 640.025, 'BUY', 3) - 640.045) < 1e-9, 'step3 = oracle + 2 ticks');
});

test('_stepPrice SELL (no BBO): each step bumps oracle DOWN by one tick', () => {
  const c = new HlClient();
  const fn = (c as unknown as { _stepPrice: StepPriceFn })._stepPrice.bind(c);
  assert.ok(Math.abs(fn(null, 640.025, 'SELL', 1) - 640.025) < 1e-9);
  assert.ok(Math.abs(fn(null, 640.025, 'SELL', 2) - 640.015) < 1e-9);
  assert.ok(Math.abs(fn(null, 640.025, 'SELL', 3) - 640.005) < 1e-9);
});

test('_stepPrice BUY (BBO present): step1 = bestBid, walks toward bestAsk, capped at bestAsk - 1 tick', () => {
  const c = new HlClient();
  const fn = (c as unknown as { _stepPrice: StepPriceFn })._stepPrice.bind(c);
  // SOL @ ~$200 → tick $0.01. Wide-enough spread for steps to spread.
  const bbo = { bestBid: 200.00, bestAsk: 200.10 };
  assert.ok(Math.abs(fn(bbo, 200.05, 'BUY', 1) - 200.00) < 1e-9, 'step1 = bestBid');
  assert.ok(Math.abs(fn(bbo, 200.05, 'BUY', 2) - 200.01) < 1e-9, 'step2 = bestBid + 1 tick');
  assert.ok(Math.abs(fn(bbo, 200.05, 'BUY', 3) - 200.02) < 1e-9, 'step3 = bestBid + 2 ticks');
  // Far-off step: capped at bestAsk - 1 tick (= 200.09) so never crosses.
  assert.ok(Math.abs(fn(bbo, 200.05, 'BUY', 99) - 200.09) < 1e-9, 'step99 capped at bestAsk - tick');
});

test('_stepPrice SELL (BBO present): step1 = bestAsk, walks toward bestBid, floored at bestBid + 1 tick', () => {
  const c = new HlClient();
  const fn = (c as unknown as { _stepPrice: StepPriceFn })._stepPrice.bind(c);
  const bbo = { bestBid: 200.00, bestAsk: 200.10 };
  assert.ok(Math.abs(fn(bbo, 200.05, 'SELL', 1) - 200.10) < 1e-9, 'step1 = bestAsk');
  assert.ok(Math.abs(fn(bbo, 200.05, 'SELL', 2) - 200.09) < 1e-9, 'step2 = bestAsk - 1 tick');
  assert.ok(Math.abs(fn(bbo, 200.05, 'SELL', 3) - 200.08) < 1e-9, 'step3 = bestAsk - 2 ticks');
  assert.ok(Math.abs(fn(bbo, 200.05, 'SELL', 99) - 200.01) < 1e-9, 'step99 floored at bestBid + tick');
});

test('_stepPrice on 1-tick spread: all 3 BUY steps collapse to bestBid (cannot cross)', () => {
  const c = new HlClient();
  const fn = (c as unknown as { _stepPrice: StepPriceFn })._stepPrice.bind(c);
  // SOL with 1-tick spread: the smoke-test scenario that exposed the bug.
  const bbo = { bestBid: 200.00, bestAsk: 200.01 };
  // step1 = bestBid = 200.00. step2 = bestBid + 1 tick = 200.01 BUT capped at bestAsk - 1 tick = 200.00.
  // step3 = bestBid + 2 ticks capped at 200.00 too. All three identical.
  assert.ok(Math.abs(fn(bbo, 200.005, 'BUY', 1) - 200.00) < 1e-9, 'step1 = bestBid');
  assert.ok(Math.abs(fn(bbo, 200.005, 'BUY', 2) - 200.00) < 1e-9, 'step2 collapses to bestBid (cap)');
  assert.ok(Math.abs(fn(bbo, 200.005, 'BUY', 3) - 200.00) < 1e-9, 'step3 collapses to bestBid (cap)');
});

});

describe('step-aggressive maker close (mocked)', () => {


test('closePosition(FLAT) walks 3 step prices, cancels between each, then falls back to taker IOC', async () => {
  const c = await makerMockedClient();
  const orderCalls: Array<Record<string, unknown>> = [];
  const cancelCalls: Array<Record<string, unknown>> = [];
  c.exchange = {
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
  } as unknown as typeof c.exchange;

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
  c.info = {
    ...baseInfo,
    l2Book: async () => { throw new Error('book unavailable'); },
  } as unknown as typeof c.info;
  c.exchange = {
    order: async (params: { orders: Array<Record<string, unknown>> }) => {
      orderCalls.push(params.orders[0]!);
      return {
        status: 'ok',
        response: { type: 'order', data: { statuses: [{ resting: { oid: 7000 + orderCalls.length } }] } },
      };
    },
    cancel: async () => ({ status: 'ok', response: { type: 'cancel', data: { statuses: ['success'] } } }),
  } as unknown as typeof c.exchange;

  await c.closePosition('ETHUSDC', 'FLAT');

  // With BBO null, step1 SELL must be the oracle ($3450), not bestAsk.
  const p1 = Number(orderCalls[0]!.p);
  assert.ok(Math.abs(p1 - 3450) < 1e-6, `step1 SELL with no BBO falls back to oracle ($3450), got ${p1}`);
});

test('closePosition(MH) returns immediately on instant fill at step 1 (no repricing)', async () => {
  const c = await makerMockedClient();
  let orderCalls = 0;
  c.exchange = {
    order: async () => {
      orderCalls++;
      return {
        status: 'ok',
        response: { type: 'order', data: { statuses: [{ filled: { totalSz: '0.5', avgPx: '3450.5', oid: 5555 } }] } },
      };
    },
    cancel: async () => ({ status: 'ok', response: { type: 'cancel', data: { statuses: ['success'] } } }),
  } as unknown as typeof c.exchange;

  const res = await c.closePosition('ETHUSDC', 'MH');
  assert.ok(res, 'instant fill returns result');
  assert.equal(res?.orderId, 5555);
  // Maker fee rate applied (~0.02% = 0.0002)
  assert.ok(Math.abs(res!.fee - 0.5 * 3450.5 * 0.0002) < 1e-6, 'maker fee applied');
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
  c.exchange = {
    order: async (params: { orders: Array<Record<string, unknown>> }) => {
      orderCalls.push(params.orders[0]!);
      return {
        status: 'ok',
        response: { type: 'order', data: { statuses: [{ filled: { totalSz: '0.5', avgPx: '3450', oid: 7777 } }] } },
      };
    },
  } as unknown as typeof c.exchange;

  await c.closePosition('ETHUSDC', 'CLOSE_OPP');
  assert.equal(orderCalls.length, 1, 'only the taker order — no maker steps');
  const tif = (orderCalls[0]!.t as { limit: { tif: string } }).limit.tif;
  assert.equal(tif, 'Ioc', 'CLOSE_OPP uses Ioc (taker), not Alo (maker)');
});

test('closePosition(non-maker reason) skips maker, goes straight to taker IOC', async () => {
  const c = await makerMockedClient();
  const orderCalls: Array<Record<string, unknown>> = [];
  c.exchange = {
    order: async (params: { orders: Array<Record<string, unknown>> }) => {
      orderCalls.push(params.orders[0]!);
      return {
        status: 'ok',
        response: { type: 'order', data: { statuses: [{ filled: { totalSz: '0.5', avgPx: '3450', oid: 99 } }] } },
      };
    },
  } as unknown as typeof c.exchange;

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
  c.exchange = {
    order: async () => {
      orderCalls++;
      return { status: 'ok', response: { type: 'order', data: { statuses: [{ error: 'User or API Wallet does not exist' }] } } };
    },
  } as unknown as typeof c.exchange;
  await assert.rejects(
    c.closePosition('ETHUSDC', 'SL', { expectedSide: 'LONG', expectedSize: 0.5 }),
    (err: unknown) => err instanceof CloseFailedError && err.remainingSize === 0.5 && err.filledSize === 0,
  );
  assert.equal(orderCalls, 3, 'IOC retried 3 times before giving up');
});

test('closePosition retries the IOC on the unfilled remainder after a partial fill', async () => {
  const c = await mockedClient();
  const sizes: number[] = [];
  c.exchange = {
    order: async (params: { orders: Array<Record<string, unknown>> }) => {
      const s = Number(params.orders[0]!.s);
      sizes.push(s);
      const filled = sizes.length === 1 ? 0.2 : s;
      return { status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { totalSz: String(filled), avgPx: '3440', oid: 800 + sizes.length } }] } } };
    },
  } as unknown as typeof c.exchange;
  const res = await c.closePosition('ETHUSDC', 'SL', { expectedSide: 'LONG', expectedSize: 0.5 });
  assert.deepEqual(sizes, [0.5, 0.3], 'second IOC sized to the remainder');
  assert.ok(res && Math.abs(res.size - 0.5) < 1e-9, 'merged result covers the whole share');
  assert.equal(res?.orderId, 802, 'last oid reported');
});

test('closePosition(FLAT) sweeps the leftover of a >=90% maker fill with a reduce-only IOC', async () => {
  const { c, pos } = await dynamicPositionClient('ETH', 0.5);
  const orders: Array<Record<string, unknown>> = [];
  c.exchange = {
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
  } as unknown as typeof c.exchange;
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
  c.exchange = {
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
  } as unknown as typeof c.exchange;
  const res = await c.closePosition('ETHUSDC', 'FLAT', { expectedSide: 'LONG', expectedSize: 0.5 });
  const iocs = orders.filter((o) => (o.t as { limit: { tif: string } }).limit.tif === 'Ioc');
  assert.equal(iocs.length, 1, 'one IOC');
  assert.equal(iocs[0]?.s, '0.2500', 'IOC sized to what is still open on-chain');
  assert.ok(res && Math.abs(res.size - 0.5) < 1e-9, 'whole share reported closed');
  assert.equal(pos.size, 0);
});

test('closePosition does not throw when the share is already flat on-chain (TP/SL fired meanwhile)', async () => {
  const { c, pos } = await dynamicPositionClient('ETH', 0.5);
  c.exchange = {
    order: async () => {
      pos.size = 0; // on-chain trigger closed it; our reduce-only IOC is rejected
      return { status: 'ok', response: { type: 'order', data: { statuses: [{ error: 'Reduce only order would increase position' }] } } };
    },
  } as unknown as typeof c.exchange;
  const res = await c.closePosition('ETHUSDC', 'SL', { expectedSide: 'LONG', expectedSize: 0.5 });
  assert.equal(res, null, 'nothing filled by us, but no CloseFailedError');
});

test('maker entry: a still-resting ladder order is cancelled once the fill is detected', async () => {
  const { c, pos } = await dynamicPositionClient('BNB', 0);
  const cancelled: number[] = [];
  const resting = new Set<number>();
  const baseInfo = c.info;
  c.info = {
    ...baseInfo,
    frontendOpenOrders: async () => [...resting].map((oid) => ({ coin: 'BNB', oid, isTrigger: false, reduceOnly: false })),
  } as unknown as typeof c.info;
  c.exchange = {
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
  } as unknown as typeof c.exchange;
  await c.openLong('BNBUSDC', 67.1, 'test');
  assert.deepEqual(cancelled, [6001], 'leftover resting entry order cancelled');
});

test('open: partial maker fill + taker fallback never exceeds the target size', async () => {
  const { c, pos } = await dynamicPositionClient('BNB', 0);
  const sizes: Array<{ tif: string; s: number }> = [];
  c.exchange = {
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
  } as unknown as typeof c.exchange;
  await c.openLong('BNBUSDC', 67.1, 'test');
  assert.deepEqual(sizes.map((x) => x.s), [0.1, 0.06, 0.06, 0.06], 'steps 2-3 and the IOC use the remainder');
  assert.ok(Math.abs(pos.size - 0.1) < 1e-9, `final position ${pos.size} equals the 0.1 target`);
});

test('open sets cross leverage once per coin, clamped to maxLeverage', async () => {
  const c = await mockedClient();
  c.targetLeverage = 50;
  const calls: Array<Record<string, unknown>> = [];
  c.exchange = {
    updateLeverage: async (p: Record<string, unknown>) => { calls.push(p); return { status: 'ok' }; },
    order: async () => ({ status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { totalSz: '0.01', avgPx: '3450', oid: 1 } }] } } }),
  } as unknown as typeof c.exchange;
  (c as unknown as { maxLeverageByCoin: Map<string, number> }).maxLeverageByCoin.set('ETH', 25);
  await c.openLong('ETHUSDC', 30, 'a');
  await c.openLong('ETHUSDC', 30, 'b');
  assert.equal(calls.length, 1, 'leverage set once');
  assert.deepEqual(calls[0], { asset: 0, isCross: true, leverage: 25 });
});

test('getFundingSince sums only the requested coin', async () => {
  const c = await mockedClient();
  const baseInfo = c.info;
  c.info = {
    ...baseInfo,
    userFunding: async () => ([
      { time: 1, hash: '0x', delta: { type: 'funding', coin: 'ETH', usdc: '-0.5', szi: '1', fundingRate: '0', nSamples: null } },
      { time: 2, hash: '0x', delta: { type: 'funding', coin: 'BNB', usdc: '-9', szi: '1', fundingRate: '0', nSamples: null } },
      { time: 3, hash: '0x', delta: { type: 'funding', coin: 'ETH', usdc: '0.2', szi: '1', fundingRate: '0', nSamples: null } },
    ]),
  } as unknown as typeof c.info;
  const f = await c.getFundingSince('ETH-USD', 0);
  assert.ok(Math.abs(f - -0.3) < 1e-9, `got ${f}`);
});

test('getFundingRates paginates 500-row pages and parses rates', async () => {
  const c = await mockedClient();
  const calls: number[] = [];
  const baseInfo = c.info;
  c.info = {
    ...baseInfo,
    fundingHistory: async ({ startTime }: { startTime: number }) => {
      calls.push(startTime);
      const n = calls.length === 1 ? 500 : 3;
      return Array.from({ length: n }, (_, i) => ({ coin: 'ETH', fundingRate: '0.0000125', premium: '0', time: startTime + i * 3_600_000 }));
    },
  } as unknown as typeof c.info;
  const rows = await c.getFundingRates('ETH-USD', 0, 10_000_000_000);
  assert.equal(rows.length, 503);
  assert.equal(calls.length, 2);
  assert.equal(calls[1], 499 * 3_600_000 + 1);
  assert.ok(Math.abs(rows[0]!.rate - 0.0000125) < 1e-15);
});

});

describe('getFillsForOrder (mocked userFills)', () => {

test('aggregates a single-fill order into avg + total fee + closedPnl', async () => {
  const c = new HlClient();
  c.info = {
    userFills: async () => [
      // Mix of unrelated oids — only oid=42 matches the target.
      { oid: 99, px: '3000', sz: '1', side: 'B', fee: '0.5', closedPnl: '0', crossed: true, time: 1_000, hash: '0xaaa' },
      { oid: 42, px: '3050', sz: '0.5', side: 'A', fee: '0.31', closedPnl: '24.69', crossed: true, time: 2_000, hash: '0xbbb' },
    ],
  } as unknown as typeof c.info;
  c.mainAddress = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  c.exchange = {} as typeof c.exchange;
  c.agentAccount = { address: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' } as unknown as typeof c.agentAccount;

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
  c.info = {
    userFills: async () => [
      { oid: 7, px: '3000', sz: '0.4', side: 'B', fee: '0.24', closedPnl: '0', crossed: false, time: 1_000, hash: '0x111' },
      { oid: 7, px: '3010', sz: '0.6', side: 'B', fee: '0.36', closedPnl: '0', crossed: false, time: 1_500, hash: '0x222' },
    ],
  } as unknown as typeof c.info;
  c.mainAddress = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  c.exchange = {} as typeof c.exchange;
  c.agentAccount = { address: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' } as unknown as typeof c.agentAccount;

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
  c.info = {
    userFills: async () => [
      { oid: 11, px: '100', sz: '1', side: 'B', fee: '0.02', closedPnl: '0', crossed: false, time: 1_000, hash: '0xa' },
      { oid: 11, px: '101', sz: '1', side: 'B', fee: '0.045', closedPnl: '0', crossed: true,  time: 1_100, hash: '0xb' },
    ],
  } as unknown as typeof c.info;
  c.mainAddress = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  c.exchange = {} as typeof c.exchange;
  c.agentAccount = { address: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' } as unknown as typeof c.agentAccount;

  const agg = await c.getFillsForOrder(11, { pollMaxMs: 100, pollIntervalMs: 10 });
  assert.ok(agg);
  assert.equal(agg!.wasTaker, true);
});

test('returns null when no fills match the oid within poll window', async () => {
  const c = new HlClient();
  c.info = {
    userFills: async () => [
      { oid: 1, px: '100', sz: '1', side: 'B', fee: '0', closedPnl: '0', crossed: false, time: 1, hash: '' },
    ],
  } as unknown as typeof c.info;
  c.mainAddress = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  c.exchange = {} as typeof c.exchange;
  c.agentAccount = { address: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' } as unknown as typeof c.agentAccount;

  const agg = await c.getFillsForOrder(999, { pollMaxMs: 50, pollIntervalMs: 10 });
  assert.equal(agg, null);
});

test('retries on transient userFills error and succeeds when fill appears', async () => {
  const c = new HlClient();
  let calls = 0;
  c.info = {
    userFills: async () => {
      calls++;
      if (calls < 2) throw new Error('rate limited');
      return [{ oid: 5, px: '50', sz: '2', side: 'A', fee: '0.045', closedPnl: '10', crossed: true, time: 1, hash: '0xc' }];
    },
  } as unknown as typeof c.info;
  c.mainAddress = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  c.exchange = {} as typeof c.exchange;
  c.agentAccount = { address: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' } as unknown as typeof c.agentAccount;

  const agg = await c.getFillsForOrder(5, { pollMaxMs: 500, pollIntervalMs: 10 });
  assert.ok(agg, `expected aggregate after retry, calls=${calls}`);
  assert.equal(agg!.totalClosedPnl, 10);
});

});

describe('getFillsByTime (mocked userFillsByTime)', () => {

test('forwards startMs / endMs and normalizes string numerics', async () => {
  const c = new HlClient();
  let captured: { startTime?: number; endTime?: number } = {};
  c.info = {
    userFillsByTime: async (params: { startTime: number; endTime?: number }) => {
      captured = params;
      return [
        { oid: 1, px: '3000', sz: '0.5', side: 'B', fee: '0.30', closedPnl: '0', crossed: false, time: 1_700, hash: '0x111' },
      ];
    },
  } as unknown as typeof c.info;
  c.mainAddress = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  c.exchange = {} as typeof c.exchange;
  c.agentAccount = { address: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' } as unknown as typeof c.agentAccount;

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
  c.info = {
    userFillsByTime: async (params: { startTime: number; endTime?: number }) => {
      captured = params;
      return [];
    },
  } as unknown as typeof c.info;
  c.mainAddress = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  c.exchange = {} as typeof c.exchange;
  c.agentAccount = { address: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' } as unknown as typeof c.agentAccount;

  await c.getFillsByTime(1_000);
  assert.equal(captured.startTime, 1_000);
  assert.equal(captured.endTime, undefined);
});

});

describe('WS fill cache (#36)', () => {

test('_resolveFillFee returns cached WS fee before falling back to poll', async () => {
  const c = await makerMockedClient();
  // userFills stub on info returns [] so the poll fallback would yield
  // the estimate. The cache hit must be what produces the asserted fee.
  c.info = {
    ...c.info,
    userFills: async () => [],
  } as unknown as typeof c.info;
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

  c.exchange = {
    order: async () => ({
      status: 'ok',
      response: { type: 'order', data: { statuses: [{ filled: { totalSz: '0.5', avgPx: '3450', oid: 8888 } }] } },
    }),
    cancel: async () => ({ status: 'ok', response: { type: 'cancel', data: { statuses: ['success'] } } }),
  } as unknown as typeof c.exchange;

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
