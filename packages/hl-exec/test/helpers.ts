/** Shared fakes for the executor tests: no network, no keys. */
import type { PrivateKeyAccount } from 'viem/accounts';
import { HyperliquidExecutor as HlClient } from '../src/index.js';

export const AGENT_KEY = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
export const ACCOUNT = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
export const FAKE_AGENT = { address: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' } as unknown as PrivateKeyAccount;

type Info = NonNullable<HlClient['info']>;
type Exchange = NonNullable<HlClient['exchange']>;

/** Partial fake of the SDK info client; only the methods a test touches. */
export function fakeInfo(methods: Record<string, unknown>): Info {
  return methods as unknown as Info;
}

/** Partial fake of the SDK exchange client. */
export function fakeExchange(methods: Record<string, unknown>): Exchange {
  return methods as unknown as Exchange;
}

export async function mockedClient(): Promise<InstanceType<typeof HlClient>> {
  const c = new HlClient();
  c.info = fakeInfo({
    spotClearinghouseState: async () => ({ balances: [] }),
    // szDecimals per coin: HL rejects sizes with more decimals, and the
    // executor throws rather than guess when it is missing.
    meta: async () => ({
      universe: [
        { name: 'ETH', szDecimals: 4 },
        { name: 'BNB', szDecimals: 3 },
      ],
    }),
    // Empty userFills: fee lookups fall back to the rate estimate, which
    // keeps the per-test fee assertions deterministic.
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
  });
  c.accountAddress = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  c.agentAccount = FAKE_AGENT;
  // Placeholder exchange to satisfy _requireConnected during the index
  // warm-up; individual tests overwrite this with a behavior-asserting stub.
  c.exchange = fakeExchange({});
  // Pre-warm asset index so tests don't depend on lazy refresh order.
  await (c as unknown as { _refreshAssetIndex: () => Promise<void> })._refreshAssetIndex();
  return c;
}

export async function makerMockedClient(): Promise<InstanceType<typeof HlClient>> {
  const c = await mockedClient();
  // Tight defaults so unit tests don't sleep for 4 minutes.
  c.makerWaitMs = 90;
  c.makerPollMs = 10;
  c.makerSteps = 3;
  return c;
}

// Mocked client whose on-chain position size is read from a mutable
// holder, so tests can simulate partial fills between polls.
export async function dynamicPositionClient(
  coin: 'ETH' | 'BNB',
  initial: number,
): Promise<{ c: InstanceType<typeof HlClient>; pos: { size: number } }> {
  const c = await makerMockedClient();
  const pos = { size: initial };
  const baseInfo = c.info;
  c.info = fakeInfo({
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
  });
  return { c, pos };
}

