/** Connecting, balances, prices and candles. */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { HyperliquidExecutor as HlClient } from '../src/index.js';
import { ACCOUNT, AGENT_KEY, FAKE_AGENT, fakeExchange, fakeInfo } from './helpers.js';

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
  c.info = fakeInfo({
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
  });
  c.accountAddress = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  c.exchange = fakeExchange({});
  c.agentAccount = FAKE_AGENT;

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
  c.info = fakeInfo({
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
  });
  c.accountAddress = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  c.exchange = fakeExchange({});
  c.agentAccount = FAKE_AGENT;

  const bal = await c.getBalance();
  assert.equal(bal.equity, 10000, 'equity must be spot.total, not perp+spot ($13,900)');
  assert.equal(bal.freeCollateral, 9900, 'free must be available-after-maintenance');
});

test('unified margin: free falls back to spot.total when tokenToAvailableAfterMaintenance absent', async () => {
  const c = new HlClient();
  c.info = fakeInfo({
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
  });
  c.accountAddress = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  c.exchange = fakeExchange({});
  c.agentAccount = FAKE_AGENT;

  const bal = await c.getBalance();
  assert.equal(bal.equity, 1000);
  assert.equal(bal.freeCollateral, 1000);
});

test('getPositions delegates to getBalance', async () => {
  const c = new HlClient();
  c.info = fakeInfo({
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
  });
  c.accountAddress = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  c.exchange = fakeExchange({});
  c.agentAccount = FAKE_AGENT;

  const pos = await c.getPositions();
  assert.equal(pos['ETH-USD']?.side, 'LONG');
  assert.equal(pos['ETH-USD']?.size, '0.5');
});

});


describe('getOraclePrice (mocked)', () => {

test('returns markPx for requested coin', async () => {
  const c = new HlClient();
  c.info = fakeInfo({
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
  });
  c.accountAddress = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  c.exchange = fakeExchange({});
  c.agentAccount = FAKE_AGENT;

  assert.equal(await c.getOraclePrice('ETH-USD'), 3450.25);
  assert.equal(await c.getOraclePrice('BNB-USD'), 671.10);
});

});


describe('getCandles interval mapping (mocked)', () => {

test('maps 4HOURS to HL 4h and shapes response in dYdX form', async () => {
  const c = new HlClient();
  let capturedInterval: string | null = null;
  c.info = fakeInfo({
    spotClearinghouseState: async () => ({ balances: [] }),
    meta: async () => ({ universe: [{ name: 'ETH' }] }),
    candleSnapshot: async (params: { coin: string; interval: string }) => {
      capturedInterval = params.interval;
      return [
        { t: 1_700_000_000_000, T: 1_700_014_400_000, s: 'ETH', i: '4h', o: '3400', c: '3450', h: '3455', l: '3395', v: '100.5', n: 200 },
      ];
    },
  });
  c.accountAddress = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  c.exchange = fakeExchange({});
  c.agentAccount = FAKE_AGENT;

  const candles = await c.getCandles('ETH-USD', '4HOURS', 10);
  assert.equal(capturedInterval, '4h');
  assert.equal(candles.length, 1);
  assert.equal(candles[0]?.open, 3400);
  assert.equal(candles[0]?.high, 3455);
  assert.equal(candles[0]?.low, 3395);
  assert.equal(candles[0]?.close, 3450);
  assert.equal(candles[0]?.volume, 100.5);
  assert.equal(candles[0]?.startedAt, new Date(1_700_000_000_000).toISOString());
});

test('unknown resolution falls back to 4h', async () => {
  const c = new HlClient();
  let capturedInterval: string | null = null;
  c.info = fakeInfo({
    spotClearinghouseState: async () => ({ balances: [] }),
    meta: async () => ({ universe: [{ name: 'ETH' }] }),
    candleSnapshot: async (params: { coin: string; interval: string }) => {
      capturedInterval = params.interval;
      return [];
    },
  });
  c.accountAddress = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  c.exchange = fakeExchange({});
  c.agentAccount = FAKE_AGENT;
  await c.getCandles('ETH-USD', 'WEIRD', 1);
  assert.equal(capturedInterval, '4h');
});

});
