/**
 * `HyperliquidExecutor`: production order execution for Hyperliquid perps.
 *
 * What it does on top of the raw SDK:
 *   - Maker-first entries/exits: a post-only ladder anchored on the L2
 *     best bid/offer that steps one tick more aggressive per step, then a
 *     taker IOC for whatever is still unfilled (never the full size again).
 *   - Close safety: reduce-only IOC retried on the on-chain remainder;
 *     `CloseFailedError` when a share stays open, so callers never drop a
 *     live position from their books.
 *   - Native TP/SL triggers, with oids resolved from the open-orders book
 *     (HL acks triggers as "waitingForTrigger" without an oid).
 *   - Fill accounting from `userFills` (WS cache + REST poll), funding
 *     history, per-coin cross-leverage, sub-account (vault) signing.
 *
 * Signing model: an **agent wallet** approved by the main account
 * (`ApproveAgent`) signs every action; state queries target the account
 * address (or the sub-account when `vaultAddress` is set).
 *
 * Markets are addressed as `ETH-USD`; bot-style spot symbols such as
 * `ETHUSDC` are accepted and mapped.
 */
import * as hl from '@nktkas/hyperliquid';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type {
  ExchangeClient,
  ExchangeBalance,
  ExchangePositionInfo,
  ExchangeTradeResult,
  OrderCallContext,
  OrderFill,
  OrderFillsAggregate,
  OpenOrderInfo,
  OrderStateValue,
  TpSlOrders,
} from './types.js';

/** Minimal logger; the bot passes its own, the default is silent. */
export interface ExecutorLogger {
  log(level: 'info' | 'warning' | 'error', message: string): void;
}

/**
 * Optional sink for in-flight maker order state (e.g. a cache key a UI
 * reads to lock a manual "close" button). Failures must not throw.
 */
export interface OrderStateSink {
  publish(namespace: string, market: string, value: OrderStateValue, ttlSec: number): Promise<void>;
  clear(namespace: string, market: string): Promise<void>;
}

export interface ExecutorCredentials {
  /** Agent wallet private key (0x + 64 hex), approved by the account. */
  agentPrivateKey: string;
  /** Account (master) address the agent trades for (0x + 40 hex). */
  accountAddress: string;
  /** Sub-account to trade and query instead of the master account. */
  vaultAddress?: string;
}

export interface ExecutorOptions {
  /** Use HL testnet endpoints. Default false (mainnet). */
  testnet?: boolean;
  logger?: ExecutorLogger;
  orderStateSink?: OrderStateSink;
  /** Total maker-ladder wait before the taker fallback. Default 240s. */
  makerWaitMs?: number;
  /** Cross leverage set once per coin before its first entry. Default 5. */
  crossLeverage?: number;
  /** Credentials used by `connect()`; or call `connectWithCredentials`. */
  credentials?: ExecutorCredentials;
}

const SILENT: ExecutorLogger = { log: () => undefined };

// HL fee tiers: maker 0.020% (Alo), taker 0.045% (Ioc/FrontendMarket).
const HL_MAKER_FEE_RATE = 0.0002;
const HL_TAKER_FEE_RATE = 0.00045;

// `ETH-USD` → HL-native coin. Callers pass `ETH-USD`; the HL SDK wants the bare coin (`ETH`, `SOL`, `BNB`, ...).
function stripUsdSuffix(market: string): string {
  return market.replace(/-USD$/, '');
}

// Spot-style symbols accepted as aliases for `<COIN>-USD` markets.
const SYMBOL_TO_MARKET: Record<string, string> = {
  ETHUSDC: 'ETH-USD',
  ETHUSDT: 'ETH-USD',
  SOLUSDC: 'SOL-USD',
  SOLUSDT: 'SOL-USD',
  BNBUSDC: 'BNB-USD',
  BNBUSDT: 'BNB-USD',
  BTCUSDC: 'BTC-USD',
  BTCUSDT: 'BTC-USD',
};

// Resolution names (`4HOURS`, `1DAY`, ...) → HL `candleSnapshot` interval.
const RESOLUTION_MAP: Record<string, hl.CandleSnapshotParameters['interval']> = {
  '1MIN': '1m',
  '5MINS': '5m',
  '15MINS': '15m',
  '30MINS': '30m',
  '1HOUR': '1h',
  '2HOURS': '2h',
  '4HOURS': '4h',
  '1DAY': '1d',
};

/**
 * Thrown by `closePosition` when the venue did not flatten the caller's
 * share: the IOC was rejected / returned nothing / only partially
 * filled after every retry. Distinct from the `null` return, which
 * means "stale local state, nothing to close" and is safe to clear.
 * On this error the position is STILL OPEN, so the caller must keep
 * its local record (and its TP/SL) and retry later.
 */
export class CloseFailedError extends Error {
  readonly filledSize: number;
  readonly remainingSize: number;
  constructor(message: string, filledSize: number, remainingSize: number) {
    super(message);
    this.name = 'CloseFailedError';
    this.filledSize = filledSize;
    this.remainingSize = remainingSize;
  }
}

// Remainders worth less than this (USD) are treated as fully filled:
// HL rounding dust that no order can express.
const DUST_NOTIONAL_USD = 1;
const CLOSE_IOC_ATTEMPTS = 3;

function resolutionToInterval(res: string): hl.CandleSnapshotParameters['interval'] {
  return RESOLUTION_MAP[res] ?? '4h';
}

/**
 * Coerce HL's stringly-typed fill record into the bot's `OrderFill`. HL
 * encodes numbers as strings to avoid float-precision drift on the
 * wire; we parse here once. Anything that fails coercion is silently
 * coerced to 0 / "" — never throws (these helpers are called inside the
 * trading loop and must not crash the runner on a malformed fill).
 */
function normalizeHlFill(raw: {
  oid: number;
  px: string;
  sz: string;
  side: 'B' | 'A';
  fee: string;
  closedPnl: string;
  crossed: boolean;
  time: number;
  hash: string;
  coin?: string;
}): OrderFill {
  return {
    oid: raw.oid,
    px: Number(raw.px) || 0,
    sz: Number(raw.sz) || 0,
    side: raw.side,
    fee: Number(raw.fee) || 0,
    closedPnl: Number(raw.closedPnl) || 0,
    crossed: !!raw.crossed,
    time: raw.time,
    hash: raw.hash ?? '',
    ...(raw.coin ? { coin: raw.coin } : {}),
  };
}

/**
 * Aggregate one or more fills for a single order id into a summary
 * suitable for `ExchangeTradeResult` / trade logging.
 *
 * Returns null on empty input so the caller can distinguish "no fills
 * yet" from "this order had ~0 size" (we always pass ≥1 fill in
 * production, but keep the guard for tests).
 */
function aggregateOrderFills(
  oid: number,
  rawFills: Array<{
    oid: number;
    px: string;
    sz: string;
    side: 'B' | 'A';
    fee: string;
    closedPnl: string;
    crossed: boolean;
    time: number;
    hash: string;
    coin?: string;
  }>,
): OrderFillsAggregate | null {
  if (rawFills.length === 0) return null;
  const fills = rawFills.map(normalizeHlFill);
  let totalSize = 0;
  let totalNotional = 0; // Σ(px × sz) for weighted average
  let totalFee = 0;
  let totalClosedPnl = 0;
  let wasTaker = false;
  let firstFillTime = Number.POSITIVE_INFINITY;
  let lastFillTime = 0;
  const hashSet = new Set<string>();
  for (const f of fills) {
    totalSize += f.sz;
    totalNotional += f.px * f.sz;
    totalFee += f.fee;
    totalClosedPnl += f.closedPnl;
    if (f.crossed) wasTaker = true;
    if (f.time < firstFillTime) firstFillTime = f.time;
    if (f.time > lastFillTime) lastFillTime = f.time;
    if (f.hash) hashSet.add(f.hash);
  }
  return {
    oid,
    fills,
    totalSize,
    avgPrice: totalSize > 0 ? totalNotional / totalSize : 0,
    totalFee,
    totalClosedPnl,
    wasTaker,
    firstFillTime: firstFillTime === Number.POSITIVE_INFINITY ? 0 : firstFillTime,
    lastFillTime,
    txHashes: Array.from(hashSet),
  };
}

/**
 * Collapse the orders of one close (maker ladder + taker remainder) into
 * a single result: summed size and fee, size-weighted price, and the
 * last order's id (the runner's fill sweep aggregates across oids).
 */
function mergeTradeResults(
  results: ExchangeTradeResult[],
  market: string,
  side: 'BUY' | 'SELL',
  reason: string,
): ExchangeTradeResult | null {
  if (results.length === 0) return null;
  if (results.length === 1) return results[0] ?? null;
  const size = results.reduce((s, r) => s + r.size, 0);
  const notional = results.reduce((s, r) => s + r.size * r.price, 0);
  const last = results[results.length - 1];
  return {
    orderId: last?.orderId ?? 0,
    market,
    side,
    size,
    price: size > 0 ? notional / size : (last?.price ?? 0),
    fee: results.reduce((s, r) => s + r.fee, 0),
    reason,
    timestamp: new Date().toISOString(),
  };
}

function intervalToMs(interval: hl.CandleSnapshotParameters['interval']): number {
  switch (interval) {
    case '1m': return 60_000;
    case '3m': return 180_000;
    case '5m': return 300_000;
    case '15m': return 900_000;
    case '30m': return 1_800_000;
    case '1h': return 3_600_000;
    case '2h': return 7_200_000;
    case '4h': return 14_400_000;
    case '8h': return 28_800_000;
    case '12h': return 43_200_000;
    case '1d': return 86_400_000;
    case '3d': return 259_200_000;
    case '1w': return 604_800_000;
    case '1M': return 2_592_000_000;
  }
}

// Loose shape of one entry inside `clearinghouseState.assetPositions`.
type RawAssetPosition = {
  type: 'oneWay';
  position: {
    coin: string;
    szi: string;
    entryPx?: string | null;
  };
};

export class HyperliquidExecutor implements ExchangeClient {
  protected readonly logger: ExecutorLogger;
  protected readonly testnet: boolean;
  protected readonly orderStateSink: OrderStateSink | null;
  private readonly defaultCredentials: ExecutorCredentials | null;

  constructor(options: ExecutorOptions = {}) {
    this.logger = options.logger ?? SILENT;
    this.testnet = options.testnet ?? false;
    this.orderStateSink = options.orderStateSink ?? null;
    this.defaultCredentials = options.credentials ?? null;
    if (options.makerWaitMs !== undefined) this.makerCloseMaxWaitMs = options.makerWaitMs;
    if (options.crossLeverage !== undefined) this.targetLeverage = options.crossLeverage;
  }

  // Signing state.
  agentAccount: PrivateKeyAccount | null = null;
  mainAddress: `0x${string}` | null = null;
  userId: string | null = null;
  /** Where the credentials came from (set by subclasses that resolve them). */
  credentialSource: string | null = null;

  // SDK clients (set in connect()).
  exchange: hl.ExchangeClient | null = null;
  info: hl.InfoClient | null = null;
  // WS subscription client for low-latency fill detection. Optional —
  // when subscribe fails, _resolveFillFee falls through to the userFills
  // poll as before. Tests overwrite `subClient` directly with a stub.
  subClient: hl.SubscriptionClient | null = null;
  private wsTransport: hl.WebSocketTransport | null = null;
  private fillsSubscription: hl.ISubscription | null = null;

  // Cache of raw fills keyed by oid, populated by the WS userFills handler.
  // Maps oid → array of partial fills so aggregateOrderFills() can sum them
  // exactly as the poll path does. FIFO eviction at fillCacheMaxSize keeps
  // memory bounded; no TTL because oids never repeat (a stale entry can
  // only matter if looked up, and lookups are by-oid). At HL's observed
  // bot rate (~3 fills/min) the cache turns over in hours, not seconds.
  private fillCacheByOid: Map<number, Array<hl.UserFillsWsEvent['fills'][number]>> = new Map();
  private fillCacheMaxSize: number = 1000;

  // Asset-index cache: HL orders use a numeric asset index (`a`), looked
  // up from `info.meta().universe`. Refreshed lazily; the universe order
  // is stable on HL.
  private assetIndex: Map<string, number> = new Map();
  // Per-coin size-decimal limit from `info.meta().universe[i].szDecimals`.
  // HL rejects orders whose `sz` field exceeds this precision with
  // "Order has invalid size". Values observed in production:
  //   BTC=5, ETH=4, BNB=3, SOL=2. The bot was rounding everything to
  //   8 decimals before the smoke test surfaced the mismatch.
  private szDecimalsByCoin: Map<string, number> = new Map();
  private maxLeverageByCoin: Map<string, number> = new Map();
  // Coins whose cross leverage we already set this process lifetime.
  private leverageSet: Set<string> = new Set();
  // Cross leverage applied before the first entry on each coin. Notional
  // is decided by the strategy sizing, so this only sets how much
  // initial margin each position locks: HL's per-coin default (1x on
  // BNB) locked the full notional as margin and starved the sibling
  // strategy's free collateral. Clamped to the coin's maxLeverage.
  targetLeverage: number = 5;

  // Patient maker fields — step-aggressive repricing inside the wait
  // window. The bot posts 3 LIMIT `Alo` (post-only) orders in sequence:
  //
  //   step 1 (0–t1):  price = oracle (joins queue at touch)
  //   step 2 (t1–t2): cancel + repost at oracle ± 1 tick (more aggressive)
  //   step 3 (t2–t3): cancel + repost at oracle ± 2 ticks
  //   t3+:            cancel + MARKET IOC fallback (caller-side)
  //
  // Each step waits `MaxWaitMs / 3` (default ~80s) before reprice. If
  // postOnly rejects at step 2/3 because the new price would cross
  // (rare — spread tightened during the wait), we jump ahead to the
  // next step rather than going straight to taker. Final cancel still
  // happens before fallback so the resting limit isn't double-filled.
  //
  // Defaults tuned for HL BNB observed flow (median trade ~$500, ~3
  // trades/min): 240s × 3-step repricing → estimated ~98% maker fill
  // rate for sub-$5k orders. Override with `makerWaitMs`.
  makerCloseMaxWaitMs: number = 240_000;
  makerCloseFillCheckIntervalMs: number = 3_000;
  makerCloseStepCount: number = 3;
  // GoodTilSec is the on-chain TTL (HL auto-cancels resting orders
  // older than this even if we don't). Set above MaxWaitMs so our
  // explicit cancel always fires first under normal conditions; HL's
  // TTL only kicks in on bot crash / restart mid-attempt.
  makerCloseGoodTilSec: number = 5 * 60;

  /**
   * Connect with the credentials passed to the constructor. Subclasses
   * that resolve credentials elsewhere (a database, a vault) override this
   * and call `connectWithCredentials`.
   */
  async connect(_userId?: string): Promise<this> {
    if (!this.defaultCredentials) {
      throw new Error('HyperliquidExecutor: no credentials; pass `credentials` or call connectWithCredentials()');
    }
    return this.connectWithCredentials(this.defaultCredentials);
  }

  async connectWithCredentials(creds: ExecutorCredentials, source = 'options'): Promise<this> {
    const { agentPrivateKey, accountAddress, vaultAddress } = creds;
    if (!/^0x[0-9a-fA-F]{64}$/.test(agentPrivateKey)) {
      throw new Error('HyperliquidExecutor: agent private key must be 0x-prefixed 64-hex (32 bytes)');
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(accountAddress)) {
      throw new Error('HyperliquidExecutor: account address must be 0x-prefixed 40-hex');
    }
    if (vaultAddress !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(vaultAddress)) {
      throw new Error('HyperliquidExecutor: vault address must be 0x-prefixed 40-hex');
    }
    this.agentAccount = privateKeyToAccount(agentPrivateKey as `0x${string}`);
    // Queries target the sub-account when trading one; orders are signed by
    // the agent on its behalf via `defaultVaultAddress`.
    this.mainAddress = (vaultAddress ?? accountAddress) as `0x${string}`;
    this.credentialSource = source;

    const transport = new hl.HttpTransport({ isTestnet: this.testnet });
    this.exchange = new hl.ExchangeClient({
      transport,
      wallet: this.agentAccount,
      ...(vaultAddress ? { defaultVaultAddress: vaultAddress as `0x${string}` } : {}),
    });
    this.info = new hl.InfoClient({ transport });

    // Warm the asset-index cache.
    await this._refreshAssetIndex();

    // WS subscription for low-latency fill detection. The userFills
    // poll in _resolveFillFee remains as fallback — if the subscribe call
    // throws or the stream lags, the cache stays empty and the poll path
    // covers it. Snapshot frame (`isSnapshot: true`) is included by HL on
    // subscribe but its fills are typically pre-existing — we cache all
    // events uniformly because oid lookups are exact-match and stale
    // entries can't accidentally match a new order.
    try {
      this.wsTransport = new hl.WebSocketTransport({ isTestnet: this.testnet });
      this.subClient = new hl.SubscriptionClient({ transport: this.wsTransport });
      this.fillsSubscription = await this.subClient.userFills(
        { user: this.mainAddress },
        (data) => this._onUserFillsEvent(data),
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.log(
        'warning',
        `HlClient WS subscription failed: ${msg} — fill detection falls back to poll`,
      );
      this.wsTransport = null;
      this.subClient = null;
      this.fillsSubscription = null;
    }

    this.logger.log(
      'info',
      `HlClient connected: account=${this.mainAddress} agent=${this.agentAccount.address} testnet=${this.testnet} source=${source}`,
    );
    return this;
  }

  private _requireConnected(): {
    exchange: hl.ExchangeClient;
    info: hl.InfoClient;
    agent: PrivateKeyAccount;
    main: `0x${string}`;
  } {
    if (!this.exchange || !this.info || !this.agentAccount || !this.mainAddress) {
      throw new Error('HlClient not connected; call connect() first');
    }
    return {
      exchange: this.exchange,
      info: this.info,
      agent: this.agentAccount,
      main: this.mainAddress,
    };
  }

  private async _refreshAssetIndex(): Promise<void> {
    const { info } = this._requireConnected();
    const meta = await info.meta();
    this.assetIndex.clear();
    this.szDecimalsByCoin.clear();
    this.maxLeverageByCoin.clear();
    meta.universe.forEach((u, idx) => {
      this.assetIndex.set(u.name, idx);
      this.szDecimalsByCoin.set(u.name, u.szDecimals);
      if (typeof u.maxLeverage === 'number') this.maxLeverageByCoin.set(u.name, u.maxLeverage);
    });
  }

  /**
   * Set cross leverage on `coin` once per process, before its first
   * entry. Never throws: a failure leaves HL's current setting in place,
   * which is how the bot always ran.
   */
  private async _ensureLeverage(coin: string): Promise<void> {
    if (this.leverageSet.has(coin)) return;
    const { exchange } = this._requireConnected();
    const idx = await this._assetIdxFor(coin);
    const max = this.maxLeverageByCoin.get(coin) ?? this.targetLeverage;
    const leverage = Math.max(1, Math.min(Math.floor(this.targetLeverage), max));
    try {
      await exchange.updateLeverage({ asset: idx, isCross: true, leverage });
      this.leverageSet.add(coin);
      this.logger.log('info', `HlClient ${coin}: cross leverage set to ${leverage}x`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.log('warning', `HlClient ${coin}: updateLeverage(${leverage}x) failed: ${msg}`);
    }
  }

  /**
   * Resting orders on `market`, including trigger TP/SL orders. Used at
   * boot to verify recovered positions are still protected on-chain.
   */
  async getOpenOrders(market: string): Promise<OpenOrderInfo[]> {
    const { info, main } = this._requireConnected();
    const coin = stripUsdSuffix(this.toMarketKey(market));
    const orders = await info.frontendOpenOrders({ user: main });
    return orders
      .filter((o) => o.coin === coin)
      .map((o) => ({
        oid: o.oid,
        isTrigger: o.isTrigger,
        reduceOnly: o.reduceOnly,
        kind: o.orderType.startsWith('Take Profit') ? 'tp' as const
          : o.orderType.startsWith('Stop') ? 'sl' as const : 'other' as const,
        triggerPx: Number(o.triggerPx) || 0,
      }));
  }

  /**
   * Best-effort final sweep of a maker ladder: cancel any of `oids` that
   * are still resting. A step cancel that failed, or a >=90% fill
   * detected by position polling, can leave the last order live; on the
   * entry side a late fill would silently oversize the position.
   */
  private async _cancelIfResting(idx: number, coin: string, oids: number[]): Promise<void> {
    if (oids.length === 0) return;
    const { exchange, info, main } = this._requireConnected();
    try {
      const open = new Set(
        (await info.frontendOpenOrders({ user: main })).filter((o) => o.coin === coin).map((o) => o.oid),
      );
      const live = oids.filter((o) => open.has(o));
      if (live.length === 0) return;
      await exchange.cancel({ cancels: live.map((o) => ({ a: idx, o })) });
      this.logger.log('info', `HlClient ${coin}: cancelled ${live.length} leftover maker order(s) ${live.join(',')}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.log('warning', `HlClient ${coin}: leftover maker order sweep failed: ${msg}`);
    }
  }

  /**
   * Hourly funding rates for `market` in [startMs, endMs] (public data,
   * paginated 500 rows per call). Positive rate = longs pay shorts.
   */
  async getFundingRates(market: string, startMs: number, endMs: number): Promise<Array<{ time: number; rate: number }>> {
    const { info } = this._requireConnected();
    const coin = stripUsdSuffix(this.toMarketKey(market));
    const out: Array<{ time: number; rate: number }> = [];
    let from = startMs;
    for (let page = 0; page < 50; page++) {
      const rows = await info.fundingHistory({ coin, startTime: from, endTime: endMs });
      for (const r of rows) out.push({ time: r.time, rate: Number(r.fundingRate) || 0 });
      if (rows.length < 500) break;
      from = rows[rows.length - 1]!.time + 1;
    }
    return out;
  }

  /**
   * Net funding paid (negative) or received (positive) on `market` since
   * `startMs`, in USDC. `closedPnl` on HL fills excludes funding, so the
   * runner adds this to a trade's net PnL at close.
   */
  async getFundingSince(market: string, startMs: number, endMs?: number): Promise<number> {
    const { info, main } = this._requireConnected();
    const coin = stripUsdSuffix(this.toMarketKey(market));
    const rows = await info.userFunding({
      user: main,
      startTime: startMs,
      ...(endMs !== undefined ? { endTime: endMs } : {}),
    });
    let total = 0;
    for (const r of rows) {
      if (r.delta.coin === coin) total += Number(r.delta.usdc) || 0;
    }
    return total;
  }

  private async _assetIdxFor(coin: string): Promise<number> {
    if (!this.assetIndex.has(coin)) await this._refreshAssetIndex();
    const idx = this.assetIndex.get(coin);
    if (idx === undefined) throw new Error(`HlClient: unknown coin ${coin}`);
    return idx;
  }

  toMarketKey(spotSymbol: string): string {
    if (SYMBOL_TO_MARKET[spotSymbol]) return SYMBOL_TO_MARKET[spotSymbol];
    if (spotSymbol.includes('-')) return spotSymbol;
    // Best-effort fallback for unknown symbols matching `<BASE>USD[CT]?`.
    const m = spotSymbol.match(/^([A-Z0-9]+?)USD[CT]?$/);
    return m && m[1] ? `${m[1]}-USD` : spotSymbol;
  }

  async getBalance(): Promise<ExchangeBalance> {
    const { info, main } = this._requireConnected();
    // HL has 2 collateral views depending on the account configuration:
    //   - `clearinghouseState`: perp-specific equity. Returns 0 when the
    //     user has the newer unified-margin mode enabled (USDC sits in
    //     spot but is implicitly available to perp).
    //   - `spotClearinghouseState.balances[USDC]`: spot USDC, which on
    //     a unified account is the actual collateral the perp matcher
    //     pulls from at fill time. `usdClassTransfer` is also rejected
    //     with "Action disabled when unified account is active" on
    //     these accounts, so the perp endpoint never sees the funds.
    //
    // We query both in parallel and combine: equity = perp + spot,
    // freeCollateral = perp.withdrawable + spot USDC. This is the
    // correct sizing input regardless of whether the user is on a
    // unified or legacy account — on legacy accounts the spot USDC is
    // typically zero (funds explicitly transferred to perp), so the
    // combined value equals the legacy perp-only value. On unified
    // accounts the spot USDC becomes visible to the bot.
    const [state, spot] = await Promise.all([
      info.clearinghouseState({ user: main }),
      info.spotClearinghouseState({ user: main }).catch(() => null),
    ]);
    const positions: Record<string, ExchangePositionInfo> = {};
    const assetPositions: Record<string, unknown> = {};
    for (const raw of state.assetPositions) {
      const ap = raw as unknown as RawAssetPosition;
      const sz = Number(ap.position.szi);
      const market = `${ap.position.coin}-USD`;
      const entryPx = ap.position.entryPx ?? '0';
      if (sz !== 0) {
        positions[market] = {
          side: sz > 0 ? 'LONG' : 'SHORT',
          size: Math.abs(sz).toString(),
          entryPrice: entryPx,
        };
      }
      assetPositions[market] = raw;
    }
    const perpEquity = Number(state.marginSummary.accountValue);
    const perpFree = Number(state.withdrawable);
    const spotUsdcStr = spot?.balances.find((b) => b.coin === 'USDC')?.total;
    const spotUsdc = spotUsdcStr ? Number(spotUsdcStr) : 0;

    // HL unified margin:
    // on a unified account the spot USDC wallet IS the perp collateral,
    // and `clearinghouseState.marginSummary.accountValue` reports only the
    // cross-pulled slice of that SAME spot (held margin ± perp uPnL). So
    // `perpEquity + spotUsdc` DOUBLE-COUNTS the locked portion — it
    // inflated equity (by about 40% on a typical book) and, since unlimited-cap
    // accounts size off `bal.equity`, over-sized every entry. Use
    // spot.total as the account equity and HL's
    // tokenToAvailableAfterMaintenance (withdrawable after maintenance —
    // already nets out margin locked by open positions) as free
    // collateral. The SDK doesn't type that field, so read it defensively.
    // Fall back to the perp figures only on legacy accounts that keep
    // funds in the perp wallet (spot USDC == 0), preserving prior
    // behaviour there.
    let equity: number;
    let freeCollateral: number;
    if (spotUsdc > 0) {
      const availEntry = (
        spot as { tokenToAvailableAfterMaintenance?: Array<[number, string]> } | null
      )?.tokenToAvailableAfterMaintenance?.find(([tokenId]) => tokenId === 0);
      const avail = availEntry ? Number(availEntry[1]) : NaN;
      equity = spotUsdc;
      freeCollateral = Number.isFinite(avail) && avail >= 0 ? avail : spotUsdc;
    } else {
      equity = perpEquity;
      freeCollateral = perpFree;
    }
    return {
      equity,
      freeCollateral,
      positions,
      assetPositions,
    };
  }

  async getPositions(): Promise<Record<string, ExchangePositionInfo>> {
    return (await this.getBalance()).positions;
  }

  /**
   * Look up fills for an order id and return an aggregated view. Polls
   * `userFills` (recent ~2000 fills) until at least one fill matching
   * `oid` shows up, or `pollMaxMs` elapses. Returns `null` when the
   * order had no fills (cancelled before any partial executed).
   *
   * HL's order endpoint returns `oid` synchronously, but the `userFills`
   * propagation lags by a few hundred ms on average — so we poll. The
   * caller passes the oid harvested from `order()` or
   * `_openMakerAttempt`/`_closeMakerAttempt` return values.
   */
  async getFillsForOrder(
    oid: number,
    options?: { pollMaxMs?: number; pollIntervalMs?: number },
  ): Promise<OrderFillsAggregate | null> {
    const { info, main } = this._requireConnected();
    const maxMs = options?.pollMaxMs ?? 5_000;
    const intervalMs = options?.pollIntervalMs ?? 500;
    const deadline = Date.now() + maxMs;
    let lastErr: unknown = null;

    while (true) {
      try {
        // aggregateByTime=false → return one row per partial fill so we
        // see the maker/taker mix correctly when an order straddles
        // both. Aggregate later, client-side.
        const fills = await info.userFills({
          user: main,
          aggregateByTime: false,
        });
        const matched = fills.filter((f) => f.oid === oid);
        if (matched.length > 0) {
          return aggregateOrderFills(oid, matched);
        }
      } catch (err) {
        lastErr = err;
      }
      if (Date.now() >= deadline) {
        if (lastErr) {
          const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
          this.logger.log(
            'warning',
            `HlClient.getFillsForOrder(${oid}): poll deadline reached; last error: ${msg}`,
          );
        }
        return null;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  /**
   * Range query of fills, used by the historical-fee backfill script
   * and by audit tooling. `endMs` defaults to `now`. Returns up to
   * 10,000 fills per HL's documented page size — the caller is
   * responsible for additional time-window chunking when ranges are
   * very large.
   */
  async getFillsByTime(startMs: number, endMs?: number): Promise<OrderFill[]> {
    const { info, main } = this._requireConnected();
    const raw = await info.userFillsByTime({
      user: main,
      startTime: startMs,
      ...(endMs !== undefined ? { endTime: endMs } : {}),
      aggregateByTime: false,
    });
    return raw.map(normalizeHlFill);
  }

  async getOraclePrice(market: string): Promise<number> {
    const { info } = this._requireConnected();
    const coin = stripUsdSuffix(market);
    const [, assetCtxs] = await info.metaAndAssetCtxs();
    const idx = await this._assetIdxFor(coin);
    const ctx = assetCtxs[idx];
    if (!ctx) throw new Error(`HlClient: no asset context for ${coin}`);
    return Number(ctx.markPx);
  }

  /**
   * Format a price string that HL accepts. The rules (from the HL API
   * docs + observed rejections during the 2026-05-20 smoke test):
   *   1. Integer prices are always OK regardless of precision.
   *   2. Non-integer prices must have at most **5 significant figures**.
   *   3. AND at most `MAX_DECIMALS - szDecimals` decimal places, where
   *      `MAX_DECIMALS = 6` for perps. So a coin with szDecimals=2
   *      (SOL) gets 4 max decimals on its price; ETH (szDecimals=4)
   *      gets 2; BNB (szDecimals=3) gets 3.
   * Both constraints must hold simultaneously — we pick the more
   * restrictive of the two.
   */
  private _formatPrice(coin: string, px: number): string {
    if (!Number.isFinite(px) || px <= 0) throw new Error(`HlClient: invalid price ${px} for ${coin}`);
    if (Number.isInteger(px)) return String(px);
    const szDecimals = this.szDecimalsByCoin.get(coin);
    const maxDecimalsByPrecision = szDecimals !== undefined ? Math.max(0, 6 - szDecimals) : 8;
    // 5 significant figures via toPrecision(5), then re-round to the
    // max decimals derived from szDecimals to satisfy rule 3 as well.
    const sigFigs = Number(px.toPrecision(5));
    return Number(sigFigs.toFixed(maxDecimalsByPrecision)).toString();
  }

  /**
   * Format a size string that HL accepts. HL rejects sizes with more
   * decimal places than the coin's `szDecimals` (e.g. SOL=2, ETH=4).
   *
   * Throws on cache miss instead of guessing a 4-decimal default —
   * a wrong precision is silently rejected by HL as "Order has
   * invalid size" and would loop the strategy on that coin until the
   * next discovery refresh. Every call site already awaits
   * `_assetIdxFor(coin)` immediately before, which guarantees the
   * cache is populated; if it isn't, that's a real invariant
   * violation we want surfaced in Sentry rather than masked.
   */
  private _formatSize(coin: string, sz: number): string {
    if (!Number.isFinite(sz) || sz <= 0) throw new Error(`HlClient: invalid size ${sz} for ${coin}`);
    const szDecimals = this.szDecimalsByCoin.get(coin);
    if (szDecimals === undefined) {
      throw new Error(
        `HlClient: szDecimals cache miss for ${coin} — call _assetIdxFor(${coin}) before _formatSize`,
      );
    }
    return sz.toFixed(szDecimals);
  }

  /**
   * HL price tick derived from the 5-significant-figures rule applied
   * to non-integer perp prices. For BNB at ~$640 the tick is $0.01;
   * SOL at ~$200 also $0.01; ETH at ~$4,000 is $0.1; BTC at ~$100k is
   * $10. Used by step-aggressive maker repricing to nudge an order one
   * tick closer to crossing the spread each step.
   *
   * Falls back to $0.01 for tiny prices to avoid sub-cent ticks that
   * HL rejects.
   */
  private _priceTick(price: number): number {
    if (!Number.isFinite(price) || price <= 0) return 0.01;
    const magnitude = Math.floor(Math.log10(price));
    const tick = Math.pow(10, magnitude - 4);
    return Math.max(tick, 0.000001);
  }

  /**
   * Resolve the authoritative fee for a known oid by polling `userFills`
   * for a short window. Falls back to the estimated `size × px × rate`
   * if HL's userFills feed hasn't propagated within the poll window OR
   * the oid isn't valid (= 0, which the maker placement path uses to
   * signal "no oid harvested yet").
   *
   * Used by the maker close polling path where a position-size shrink
   * could in theory come from a non-bot source (manual close, liquidation,
   * concurrent reduce-only order) — anchoring the fee to the actual
   * fill record avoids accruing a wrong-side rate into bot accounting.
   */
  private _onUserFillsEvent(data: hl.UserFillsWsEvent): void {
    for (const fill of data.fills) {
      const oid = fill.oid;
      if (!Number.isFinite(oid)) continue;
      const existing = this.fillCacheByOid.get(oid);
      if (existing) {
        existing.push(fill);
      } else {
        this.fillCacheByOid.set(oid, [fill]);
        // FIFO eviction on insert. Map iteration order = insertion order,
        // so the first key is the oldest. Cheap: one delete on overflow.
        if (this.fillCacheByOid.size > this.fillCacheMaxSize) {
          const oldest = this.fillCacheByOid.keys().next().value;
          if (oldest !== undefined) this.fillCacheByOid.delete(oldest);
        }
      }
    }
  }

  private async _resolveFillFee(
    oid: number,
    fillSize: number,
    fillPx: number,
    estimatedRate: number,
  ): Promise<number> {
    const estimate = fillSize * fillPx * estimatedRate;
    if (!oid || !Number.isFinite(oid)) return estimate;

    // Fast path: check the WS-populated fill cache for ≤200ms before
    // falling back to the userFills poll. HL WS typically propagates
    // fills within ~50ms; 4 × 50ms keeps the worst case bounded while
    // covering the common case at sub-poll latency.
    // Skip entirely when the WS subscription is not active — the cache
    // will never populate, and burning 200ms before the REST fallback
    // would delay every _resolveFillFee call after a failed connect().
    if (this.subClient !== null) {
      const cacheDeadline = Date.now() + 200;
      while (true) {
        const cached = this.fillCacheByOid.get(oid);
        if (cached && cached.length > 0) {
          const agg = aggregateOrderFills(oid, cached);
          if (agg && agg.totalFee > 0) return agg.totalFee;
        }
        if (Date.now() >= cacheDeadline) break;
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    try {
      const agg = await this.getFillsForOrder(oid, { pollMaxMs: 2_000, pollIntervalMs: 300 });
      if (agg && agg.totalFee > 0) return agg.totalFee;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.log('warning', `HlClient _resolveFillFee oid=${oid} failed: ${msg} — using estimate`);
    }
    return estimate;
  }

  /**
   * Tear down the WS subscription and close the WebSocket transport.
   * Safe to call multiple times; safe to call before connect(). Wired
   * into user teardown so per-user clients don't leak open sockets.
   */
  async disconnect(): Promise<void> {
    try {
      await this.fillsSubscription?.unsubscribe();
    } catch {
      // best-effort cleanup; sub may already be disconnected
    }
    this.fillsSubscription = null;
    try {
      await this.wsTransport?.close();
    } catch {
      // best-effort
    }
    this.wsTransport = null;
    this.subClient = null;
    this.fillCacheByOid.clear();
  }

  /**
   * Read the current best-bid / best-ask from the HL L2 order book. Used
   * by the maker step logic to anchor LIMIT prices to *our* side of the
   * book so `tif: 'Alo'` post-only doesn't cross — the oracle sits in
   * the middle of the spread and on tight markets (e.g. SOL with a
   * 1-tick spread) anchoring at oracle gets rejected as "Post only
   * order would have immediately matched".
   *
   * Returns `null` on any failure / empty book / crossed book; callers
   * fall back to the legacy oracle-based step formula in that case.
   */
  private async _getBbo(coin: string): Promise<{ bestBid: number; bestAsk: number } | null> {
    const { info } = this._requireConnected();
    try {
      const book = await info.l2Book({ coin });
      if (!book || !book.levels) return null;
      const [bids, asks] = book.levels;
      const bestBidStr = bids?.[0]?.px;
      const bestAskStr = asks?.[0]?.px;
      if (!bestBidStr || !bestAskStr) return null;
      const bestBid = Number(bestBidStr);
      const bestAsk = Number(bestAskStr);
      if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return null;
      if (bestBid <= 0 || bestAsk <= 0) return null;
      if (bestBid >= bestAsk) return null;
      return { bestBid, bestAsk };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.log('warning', `HlClient _getBbo(${coin}) failed: ${msg} — will fall back to oracle`);
      return null;
    }
  }

  /**
   * Compute the maker limit price for a given step (1..N).
   *
   * When BBO is available (the normal case):
   *   - Step 1 (most patient): BUY @ bestBid, SELL @ bestAsk — strictly
   *     on our side of the book, guaranteed not to cross.
   *   - Step N (more aggressive): BUY @ bestBid + (N-1)·tick, capped at
   *     bestAsk - 1·tick so we never cross. SELL is the mirror.
   *   - On a 1-tick spread all steps collapse to step 1 (correct: any
   *     more aggressive price would cross).
   *
   * When BBO is `null` (l2Book failed): fall back to the legacy
   * oracle-based formula. Same monotonic step direction as before so
   * callers see no behaviour drift on the fallback path.
   */
  private _stepPrice(
    bbo: { bestBid: number; bestAsk: number } | null,
    oraclePrice: number,
    side: 'BUY' | 'SELL',
    step: number,
  ): number {
    const tick = this._priceTick(oraclePrice);
    const delta = Math.max(0, step - 1) * tick;
    if (bbo) {
      if (side === 'BUY') {
        const cap = bbo.bestAsk - tick;
        return Math.min(bbo.bestBid + delta, cap);
      }
      const floor = bbo.bestBid + tick;
      return Math.max(bbo.bestAsk - delta, floor);
    }
    return side === 'BUY'
      ? oraclePrice + delta
      : oraclePrice - delta;
  }

  private async _placeMarketIoc(
    spotSymbol: string,
    side: 'BUY' | 'SELL',
    sizeBase: number,
    reduceOnly: boolean,
    reason: string,
  ): Promise<ExchangeTradeResult | null> {
    const { exchange } = this._requireConnected();
    const market = this.toMarketKey(spotSymbol);
    const coin = stripUsdSuffix(market);
    const idx = await this._assetIdxFor(coin);
    const mark = await this.getOraclePrice(market);
    // Compute an aggressive limit price that's guaranteed to cross the
    // spread. Two-stage strategy:
    //   1. Prefer the actual best-ask (BUY) / best-bid (SELL) from the
    //      L2 book, then add a 0.25% buffer to absorb in-flight book
    //      moves. This works on illiquid markets (BNB perp on HL)
    //      where a fixed `mark ± 0.5%` may not be enough to clear the
    //      far side of the spread.
    //   2. Fall back to `mark ± 0.5%` (the legacy formula) when the
    //      L2 book is empty / crossed / unreachable. Same behaviour as
    //      before so we don't regress on the happy path.
    const bbo = await this._getBbo(coin);
    const buffer = 0.0025;
    let px: number;
    if (bbo) {
      px = side === 'BUY' ? bbo.bestAsk * (1 + buffer) : bbo.bestBid * (1 - buffer);
    } else {
      const slippage = 0.005;
      px = side === 'BUY' ? mark * (1 + slippage) : mark * (1 - slippage);
    }

    const res = await exchange.order({
      orders: [
        {
          a: idx,
          b: side === 'BUY',
          p: this._formatPrice(coin, px),
          s: this._formatSize(coin, sizeBase),
          r: reduceOnly,
          t: { limit: { tif: 'Ioc' } },
        },
      ],
      grouping: 'na',
    });
    const status = res.response?.data?.statuses?.[0];
    if (!status) {
      this.logger.log('warning', `HlClient ${side} ${spotSymbol}: empty response — ${reason}`);
      return null;
    }
    if (typeof status === 'string') {
      // "waitingForFill" | "waitingForTrigger" — treat as resting with no oid.
      this.logger.log('info', `HlClient ${side} ${spotSymbol}: ${status} — ${reason}`);
      return null;
    }
    if ('error' in status) {
      this.logger.log('error', `HlClient ${side} ${spotSymbol} rejected: ${status.error} — ${reason}`);
      return null;
    }
    let oid = 0;
    let fillPx = px;
    let fillSize = sizeBase;
    if ('filled' in status) {
      oid = status.filled.oid;
      fillPx = Number(status.filled.avgPx);
      fillSize = Number(status.filled.totalSz);
    } else if ('resting' in status) {
      oid = status.resting.oid;
    }
    const feeRate = HL_TAKER_FEE_RATE; // HL Tier 0 taker (0.045%); IOC = taker.
    return {
      orderId: oid,
      market,
      side,
      size: fillSize,
      price: fillPx,
      fee: fillSize * fillPx * feeRate,
      reason,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Publish the in-flight maker order state through the optional sink
   * (no-op without a sink or a namespace). Never throws: the order must
   * not be blocked by an unreachable store.
   */
  private async _publishOrderState(
    ctx: OrderCallContext | undefined,
    market: string,
    value: OrderStateValue,
  ): Promise<void> {
    const ns = ctx?.namespace;
    if (!ns || !this.orderStateSink) return;
    const ttl = Math.ceil(this.makerCloseMaxWaitMs / 1000) + 30;
    try {
      await this.orderStateSink.publish(ns, market, value, ttl);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.log('warning', `HlClient order-state publish ${ns} ${market} failed: ${msg}`);
    }
  }

  private async _clearOrderState(
    ctx: OrderCallContext | undefined,
    market: string,
  ): Promise<void> {
    const ns = ctx?.namespace;
    if (!ns || !this.orderStateSink) return;
    try {
      await this.orderStateSink.clear(ns, market);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.log('warning', `HlClient order-state clear ${ns} ${market} failed: ${msg}`);
    }
  }

  /**
   * Patient maker close with step-aggressive repricing. Posts LIMIT
   * `Alo` (post-only) reduce-only at `_stepPrice(oracle, side, step)`,
   * polls positions every `FillCheckIntervalMs` until either the
   * position shrinks below 10% of `initialSize` (filled) or the
   * step's slice of `MaxWaitMs` elapses. On step timeout, cancels and
   * reposts one tick more aggressive (closer to crossing). After all
   * `StepCount` steps elapse → final cancel, return null so caller
   * falls back to MARKET IOC.
   *
   * postOnly rejection at step N skips ahead to step N+1 rather than
   * abandoning to taker — keeps the maker chance alive when the spread
   * tightens mid-attempt.
   *
   * Returns null on any unrecoverable failure — never throws so the
   * caller can always rely on the taker fallback.
   */
  private async _closeMakerAttempt(
    spotSymbol: string,
    closeSide: 'BUY' | 'SELL',
    initialSize: number,
    positionSide: 'LONG' | 'SHORT',
    reason: string,
    ctx?: OrderCallContext,
  ): Promise<ExchangeTradeResult | null> {
    const { exchange } = this._requireConnected();
    const market = this.toMarketKey(spotSymbol);
    const coin = stripUsdSuffix(market);
    const idx = await this._assetIdxFor(coin);
    const oraclePrice = await this.getOraclePrice(market);
    const bbo = await this._getBbo(coin);
    // Measure fills against the on-chain size before we start, so the
    // filled amount is ours even if the aggregate is larger.
    const preSize = Math.abs(
      Number((await this.getPositions())[market]?.size ?? initialSize),
    );

    const startedAt = Date.now();
    const totalWait = this.makerCloseMaxWaitMs;
    const overallDeadline = startedAt + totalWait;
    const stepCount = Math.max(1, this.makerCloseStepCount);
    const stepWindowMs = Math.floor(totalWait / stepCount);

    const anchor = bbo
      ? `bid=$${bbo.bestBid} ask=$${bbo.bestAsk}`
      : `oracle=$${oraclePrice} (no BBO)`;
    this.logger.log(
      'info',
      `HlClient MAKER ${closeSide} ${market}: size=${initialSize} ${anchor} close ${positionSide}: ${reason} (${stepCount}-step × ${stepWindowMs}ms, wait=${totalWait}ms)`,
    );

    const placedOids: number[] = [];
    try {
      for (let step = 1; step <= stepCount; step++) {
        const stepDeadline = Math.min(
          startedAt + step * stepWindowMs,
          overallDeadline,
        );
        const stepPrice = this._stepPrice(bbo, oraclePrice, closeSide, step);

        let res: Awaited<ReturnType<typeof exchange.order>>;
        try {
          res = await exchange.order({
            orders: [
              {
                a: idx,
                b: closeSide === 'BUY',
                p: this._formatPrice(coin, stepPrice),
                s: this._formatSize(coin, initialSize),
                r: true,
                t: { limit: { tif: 'Alo' } },
              },
            ],
            grouping: 'na',
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.log(
            'warning',
            `HlClient MAKER close step${step} placeOrder threw: ${msg} — advancing to next step`,
          );
          continue;
        }

        const status = res.response?.data?.statuses?.[0];
        if (!status || typeof status === 'string' || 'error' in status) {
          const detail = typeof status === 'string'
            ? status
            : status && 'error' in status ? status.error : 'empty';
          // postOnly reject (crossed spread) or other rejection: skip
          // ahead to next step. On the LAST step a reject means we
          // can't get maker at all → fall back to taker.
          if (step < stepCount) {
            this.logger.log(
              'info',
              `HlClient MAKER close step${step} not accepted: ${detail} — advancing to step${step + 1}`,
            );
            continue;
          }
          this.logger.log(
            'warning',
            `HlClient MAKER close step${step} not accepted: ${detail} — falling back to taker`,
          );
          return null;
        }

        let oid = 0;
        if ('filled' in status) {
          oid = status.filled.oid;
          const fillPx = Number(status.filled.avgPx);
          const fillSize = Number(status.filled.totalSz);
          const fee = await this._resolveFillFee(oid, fillSize, fillPx, HL_MAKER_FEE_RATE);
          this.logger.log(
            'info',
            `HlClient MAKER close filled instantly step${step}: ${closeSide} ${market} @ $${fillPx} (fee $${fee.toFixed(4)})`,
          );
          return {
            orderId: oid, market, side: closeSide, size: fillSize,
            price: fillPx, fee, reason: `close ${positionSide}: ${reason}`,
            timestamp: new Date().toISOString(),
          };
        }
        if ('resting' in status) { oid = status.resting.oid; placedOids.push(oid); }

        await this._publishOrderState(ctx, market, {
          state: step === 1 ? 'maker-waiting' : step === 2 ? 'maker-step2' : 'maker-step3',
          startedAt,
          deadlineAt: overallDeadline,
          reason,
          currentStep: Math.min(step, 3) as 1 | 2 | 3,
          oid,
        });

        // Poll until step deadline or fill.
        while (Date.now() < stepDeadline) {
          await new Promise((r) => setTimeout(r, this.makerCloseFillCheckIntervalMs));
          const positions = await this.getPositions();
          const cur = positions[market];
          const curSize = cur ? Math.abs(Number(cur.size)) : 0;
          // ≥90% of our share gone counts as filled; closePosition sweeps
          // the leftover with a reduce-only IOC so no dust stays open.
          if (curSize <= preSize - initialSize * 0.9) {
            const fillPx = await this.getOraclePrice(market).catch(() => stepPrice);
            const filledSize = Math.min(initialSize, preSize - curSize);
            const fee = await this._resolveFillFee(oid, filledSize, fillPx, HL_MAKER_FEE_RATE);
            this.logger.log(
              'info',
              `HlClient MAKER close filled step${step}: ${closeSide} ${market} @ ~$${fillPx.toFixed(2)} (fee $${fee.toFixed(4)})`,
            );
            return {
              orderId: oid, market, side: closeSide, size: filledSize,
              price: fillPx, fee, reason: `close ${positionSide}: ${reason}`,
              timestamp: new Date().toISOString(),
            };
          }
        }

        // Step timeout — cancel before reprice (or final fallback).
        if (oid) {
          try {
            await exchange.cancel({ cancels: [{ a: idx, o: oid }] });
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.log('warning', `HlClient MAKER step${step} cancel oid=${oid} failed: ${msg}`);
          }
        }

        if (step < stepCount) {
          this.logger.log(
            'info',
            `HlClient MAKER close step${step} timeout — repricing one tick more aggressive (step${step + 1})`,
          );
        }
      }
    } finally {
      await this._cancelIfResting(idx, coin, placedOids);
      await this._clearOrderState(ctx, market);
    }

    this.logger.log(
      'info',
      `HlClient MAKER close all ${stepCount} steps timeout (${totalWait}ms) — falling back to taker`,
    );
    // Final settle window so any race-fill from the last cancel is
    // observed by the "position-still-open" recheck below.
    await new Promise((r) => setTimeout(r, 1500));
    return null;
  }

  /**
   * Patient maker entry with step-aggressive repricing. Mirrors
   * `_closeMakerAttempt` but detects fill via position GROWTH instead
   * of shrinkage. On step timeout: cancel + repost one tick more
   * aggressive (closer to crossing). On postOnly rejection at non-final
   * step: skip ahead. On final timeout: cancel + return null so caller
   * falls back to MARKET IOC.
   */
  private async _openMakerAttempt(
    spotSymbol: string,
    side: 'BUY' | 'SELL',
    sizeBase: number,
    reason: string,
    ctx?: OrderCallContext,
  ): Promise<ExchangeTradeResult | null> {
    const { exchange } = this._requireConnected();
    const market = this.toMarketKey(spotSymbol);
    const coin = stripUsdSuffix(market);
    const idx = await this._assetIdxFor(coin);
    const oraclePrice = await this.getOraclePrice(market);
    const bbo = await this._getBbo(coin);
    const beforeSize = Math.abs(
      Number((await this.getPositions())[market]?.size ?? 0),
    );
    const placedOids: number[] = [];

    const startedAt = Date.now();
    const totalWait = this.makerCloseMaxWaitMs;
    const overallDeadline = startedAt + totalWait;
    const stepCount = Math.max(1, this.makerCloseStepCount);
    const stepWindowMs = Math.floor(totalWait / stepCount);

    const anchor = bbo
      ? `bid=$${bbo.bestBid} ask=$${bbo.bestAsk}`
      : `oracle=$${oraclePrice} (no BBO)`;
    this.logger.log(
      'info',
      `HlClient MAKER ${side} ${market}: size=${sizeBase} ${anchor} open: ${reason} (${stepCount}-step × ${stepWindowMs}ms, wait=${totalWait}ms)`,
    );

    try {
      for (let step = 1; step <= stepCount; step++) {
        const stepDeadline = Math.min(
          startedAt + step * stepWindowMs,
          overallDeadline,
        );
        const stepPrice = this._stepPrice(bbo, oraclePrice, side, step);

        // Re-post only what is still unfilled: a partial fill on an
        // earlier step followed by a full-size repost used to stack up
        // to ~2x the intended position.
        let stepSize = sizeBase;
        if (step > 1) {
          const nowSize = Math.abs(Number((await this.getPositions())[market]?.size ?? 0));
          const filledSoFar = Math.max(0, nowSize - beforeSize);
          stepSize = sizeBase - filledSoFar;
          if (stepSize * oraclePrice < DUST_NOTIONAL_USD || stepSize < sizeBase * 0.1) {
            const fillPx = Number((await this.getPositions())[market]?.entryPrice ?? stepPrice) || stepPrice;
            return {
              orderId: 0, market, side, size: filledSoFar,
              price: fillPx, fee: filledSoFar * fillPx * HL_MAKER_FEE_RATE,
              reason, timestamp: new Date().toISOString(),
            };
          }
        }

        let res: Awaited<ReturnType<typeof exchange.order>>;
        try {
          res = await exchange.order({
            orders: [
              {
                a: idx,
                b: side === 'BUY',
                p: this._formatPrice(coin, stepPrice),
                s: this._formatSize(coin, stepSize),
                r: false,
                t: { limit: { tif: 'Alo' } },
              },
            ],
            grouping: 'na',
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.log(
            'warning',
            `HlClient MAKER open step${step} placeOrder threw: ${msg} — advancing to next step`,
          );
          continue;
        }

        const status = res.response?.data?.statuses?.[0];
        if (!status || typeof status === 'string' || 'error' in status) {
          const detail = typeof status === 'string'
            ? status
            : status && 'error' in status ? status.error : 'empty';
          if (step < stepCount) {
            this.logger.log(
              'info',
              `HlClient MAKER open step${step} not accepted: ${detail} — advancing to step${step + 1}`,
            );
            continue;
          }
          this.logger.log(
            'warning',
            `HlClient MAKER open step${step} not accepted: ${detail} — falling back to taker`,
          );
          return null;
        }

        let oid = 0;
        if ('filled' in status) {
          oid = status.filled.oid;
          const fillPx = Number(status.filled.avgPx);
          const fillSize = Number(status.filled.totalSz);
          const fee = await this._resolveFillFee(oid, fillSize, fillPx, HL_MAKER_FEE_RATE);
          this.logger.log(
            'info',
            `HlClient MAKER open filled instantly step${step}: ${side} ${market} @ $${fillPx} (fee $${fee.toFixed(4)})`,
          );
          return {
            orderId: oid, market, side, size: fillSize,
            price: fillPx, fee, reason, timestamp: new Date().toISOString(),
          };
        }
        if ('resting' in status) { oid = status.resting.oid; placedOids.push(oid); }

        await this._publishOrderState(ctx, market, {
          state: step === 1 ? 'maker-waiting' : step === 2 ? 'maker-step2' : 'maker-step3',
          startedAt,
          deadlineAt: overallDeadline,
          reason: reason || 'entry',
          currentStep: Math.min(step, 3) as 1 | 2 | 3,
          oid,
        });

        while (Date.now() < stepDeadline) {
          await new Promise((r) => setTimeout(r, this.makerCloseFillCheckIntervalMs));
          const positions = await this.getPositions();
          const cur = positions[market];
          const curSize = cur ? Math.abs(Number(cur.size)) : 0;
          if (curSize >= beforeSize + sizeBase * 0.9) {
            const fillPx = cur && cur.entryPrice
              ? Number(cur.entryPrice) || stepPrice
              : stepPrice;
            const filledSize = Math.max(curSize - beforeSize, sizeBase);
            const fee = await this._resolveFillFee(oid, filledSize, fillPx, HL_MAKER_FEE_RATE);
            this.logger.log(
              'info',
              `HlClient MAKER open filled step${step}: ${side} ${market} @ ~$${fillPx.toFixed(2)} (fee $${fee.toFixed(4)})`,
            );
            return {
              orderId: oid, market, side, size: filledSize,
              price: fillPx, fee, reason, timestamp: new Date().toISOString(),
            };
          }
        }

        if (oid) {
          try {
            await exchange.cancel({ cancels: [{ a: idx, o: oid }] });
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.log('warning', `HlClient MAKER step${step} cancel oid=${oid} failed: ${msg}`);
          }
        }

        if (step < stepCount) {
          this.logger.log(
            'info',
            `HlClient MAKER open step${step} timeout — repricing one tick more aggressive (step${step + 1})`,
          );
        }
      }
    } finally {
      await this._cancelIfResting(idx, coin, placedOids);
      await this._clearOrderState(ctx, market);
    }

    this.logger.log(
      'info',
      `HlClient MAKER open all ${stepCount} steps timeout (${totalWait}ms) — falling back to taker`,
    );
    await new Promise((r) => setTimeout(r, 1500));
    return null;
  }

  async openLong(
    spotSymbol: string,
    usdAmount: number,
    reason = '',
    ctx?: OrderCallContext,
  ): Promise<ExchangeTradeResult | null> {
    return this._open(spotSymbol, 'BUY', usdAmount, reason, ctx);
  }

  async openShort(
    spotSymbol: string,
    usdAmount: number,
    reason = '',
    ctx?: OrderCallContext,
  ): Promise<ExchangeTradeResult | null> {
    return this._open(spotSymbol, 'SELL', usdAmount, reason, ctx);
  }

  /**
   * Maker-first entry (postOnly ladder for makerCloseMaxWaitMs), then a
   * taker IOC for whatever the ladder left unfilled. Sizing the IOC to
   * the remainder, not the full order, keeps a partial maker fill from
   * doubling the position.
   */
  private async _open(
    spotSymbol: string,
    side: 'BUY' | 'SELL',
    usdAmount: number,
    reason: string,
    ctx?: OrderCallContext,
  ): Promise<ExchangeTradeResult | null> {
    const market = this.toMarketKey(spotSymbol);
    await this._ensureLeverage(stripUsdSuffix(market));
    const mark = await this.getOraclePrice(market);
    const size = usdAmount / mark;
    const beforeSize = Math.abs(Number((await this.getPositions())[market]?.size ?? 0));
    const makerResult = await this._openMakerAttempt(spotSymbol, side, size, reason, ctx);
    if (makerResult) return makerResult;
    const filledByMaker = Math.max(
      0,
      Math.abs(Number((await this.getPositions())[market]?.size ?? 0)) - beforeSize,
    );
    const remaining = size - filledByMaker;
    if (remaining * mark < DUST_NOTIONAL_USD) {
      this.logger.log('info', `HlClient ${side} ${market}: maker ladder filled ${filledByMaker} before timeout, no taker needed`);
      return {
        orderId: 0, market, side, size: filledByMaker, price: mark,
        fee: filledByMaker * mark * HL_MAKER_FEE_RATE, reason,
        timestamp: new Date().toISOString(),
      };
    }
    if (filledByMaker > 0) {
      this.logger.log('info', `HlClient ${side} ${market}: maker ladder partially filled ${filledByMaker}/${size}, taker IOC for remaining ${remaining}`);
    }
    return this._placeMarketIoc(spotSymbol, side, remaining, false, reason);
  }

  async closePosition(
    spotSymbol: string,
    reason = '',
    ctx?: OrderCallContext,
  ): Promise<ExchangeTradeResult | null> {
    const market = this.toMarketKey(spotSymbol);
    const positions = await this.getPositions();
    const pos = positions[market];

    // Pre-close reconciliation: when the caller provides `expectedSize`
    // + `expectedSide`, validate the on-chain aggregate satisfies its
    // claimed share before placing any order. Stale local state must
    // NOT rug the actual on-chain position (which may belong to a
    // sibling strategy under unified margin). See OrderCallContext.
    const expectedSide = ctx?.expectedSide;
    const expectedSize = ctx?.expectedSize;
    const reconciling =
      expectedSide !== undefined && expectedSize !== undefined;
    if (reconciling) {
      if (!pos) {
        this.logger.log(
          'warning',
          `HlClient closePosition ${spotSymbol}: stale local state (on-chain flat, expected ${expectedSide} ${expectedSize}) — skipping close [${reason}]`,
        );
        return null;
      }
      if (pos.side !== expectedSide) {
        this.logger.log(
          'warning',
          `HlClient closePosition ${spotSymbol}: stale local state (on-chain ${pos.side}, expected ${expectedSide}) — skipping close [${reason}]`,
        );
        return null;
      }
      // Float-tolerant size compare: HL rounds to coin-specific szDecimals,
      // so a stored expectedSize like 1.536 may compare slightly above an
      // on-chain `1.5360000001` after re-quantisation. Tolerate 1e-6.
      if (Number(pos.size) + 1e-6 < expectedSize) {
        this.logger.log(
          'warning',
          `HlClient closePosition ${spotSymbol}: stale local state (on-chain ${pos.size}, expected ${expectedSize}) — skipping close [${reason}]`,
        );
        return null;
      }
    } else if (!pos) {
      this.logger.log('warning', `HlClient closePosition ${spotSymbol}: no open position — ${reason}`);
      return null;
    }

    const refSide = expectedSide ?? pos!.side;
    const closeSide: 'BUY' | 'SELL' = refSide === 'LONG' ? 'SELL' : 'BUY';
    // Partial close to the caller's claimed share when reconciling;
    // otherwise legacy "flatten everything on-chain" semantics.
    const size = reconciling ? expectedSize : Number(pos!.size);
    // Gate: FLAT and MH use patient maker close — they're non-urgent
    // expiry-style exits. CLOSE_OPP is explicitly excluded: it's a
    // signal-driven flip and the follow-on entry fires within milliseconds.
    // Routing CLOSE_OPP through the maker ladder would hold the flipOpening
    // mutex for up to makerCloseMaxWaitMs (~240s), causing the entry signal
    // to be silently dropped. Other reasons — TP/SL/RE/EL/AR/ADMIN/flip —
    // stay taker because they're time-critical (risk reduction).
    const preSize = Number(pos!.size);
    const mark = await this.getOraclePrice(market).catch(() => Number(pos?.entryPrice) || 0);
    // How much of our share the venue has closed so far, from the
    // on-chain size (a maker ladder that times out after partial fills
    // returns null but has still reduced the position).
    const closedOnChain = async (): Promise<number> => {
      const cur = (await this.getPositions())[market];
      const curSize = cur && cur.side === refSide ? Number(cur.size) : 0;
      return Math.min(size, Math.max(0, preSize - curSize));
    };

    const results: ExchangeTradeResult[] = [];
    if (reason === 'FLAT' || reason === 'MH') {
      const makerResult = await this._closeMakerAttempt(
        spotSymbol, closeSide, size, refSide, reason, ctx,
      );
      if (makerResult) {
        results.push(makerResult);
      } else {
        const partial = await closedOnChain();
        if (partial > 0) {
          results.push({
            orderId: 0, market, side: closeSide, size: partial, price: mark,
            fee: partial * mark * HL_MAKER_FEE_RATE, reason, timestamp: new Date().toISOString(),
          });
        }
      }
    }

    // Taker IOC for whatever is left (all of it on non-maker reasons,
    // the leftover of a maker ladder otherwise). An IOC that is
    // rejected or only partially fills is retried on the remainder.
    let remaining = size - results.reduce((s, r) => s + r.size, 0);
    for (let attempt = 1; attempt <= CLOSE_IOC_ATTEMPTS; attempt++) {
      if (remaining <= 0 || (mark > 0 && remaining * mark < DUST_NOTIONAL_USD)) break;
      let ioc: ExchangeTradeResult | null = null;
      try {
        ioc = await this._placeMarketIoc(spotSymbol, closeSide, remaining, true, reason);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.log('warning', `HlClient closePosition ${spotSymbol} IOC attempt ${attempt} threw: ${msg}`);
      }
      if (ioc && ioc.size > 0) {
        results.push(ioc);
        remaining -= ioc.size;
      }
    }

    let filled = results.reduce((s, r) => s + r.size, 0);
    const isDust = (x: number): boolean => x <= 0 || (mark > 0 && x * mark < DUST_NOTIONAL_USD);
    if (!isDust(remaining)) {
      // Trust the venue over our bookkeeping before declaring failure:
      // the share may be flat already (e.g. an on-chain TP/SL fired).
      const onChain = await closedOnChain().catch(() => filled);
      if (isDust(size - onChain)) {
        remaining = 0;
      } else {
        filled = Math.max(filled, onChain);
        remaining = size - filled;
      }
    }
    if (!isDust(remaining)) {
      throw new CloseFailedError(
        `HlClient closePosition ${spotSymbol} [${reason}]: ${remaining} of ${size} still open after ${CLOSE_IOC_ATTEMPTS} IOC attempts`,
        filled,
        remaining,
      );
    }
    return mergeTradeResults(results, market, closeSide, reason);
  }

  async placeTPSL(
    spotSymbol: string,
    direction: 'LONG' | 'SHORT',
    size: number,
    tpPrice: number,
    slPrice: number,
  ): Promise<TpSlOrders> {
    const { exchange } = this._requireConnected();
    const market = this.toMarketKey(spotSymbol);
    const coin = stripUsdSuffix(market);
    const idx = await this._assetIdxFor(coin);
    // Closing side is opposite of position direction.
    const closeIsBuy = direction === 'SHORT';

    const res = await exchange.order({
      orders: [
        {
          a: idx,
          b: closeIsBuy,
          p: this._formatPrice(coin, tpPrice),
          s: this._formatSize(coin, size),
          r: true,
          t: { trigger: { isMarket: false, triggerPx: this._formatPrice(coin, tpPrice), tpsl: 'tp' } },
        },
        {
          a: idx,
          b: closeIsBuy,
          // SL is market-on-trigger but HL uses `p` as the worst-price
          // limit during fill. Setting `p = slPrice` (0% slippage) makes
          // a fast move through the trigger leave the SL UNFILLED — the
          // position keeps bleeding past the intended stop. Allow 5%
          // slippage in the unfavourable direction: for a LONG close
          // (closeIsBuy=false), the worst price is BELOW slPrice; for a
          // SHORT close (closeIsBuy=true), it's ABOVE. 5% is generous
          // enough to clear any realistic candle gap on ETH/SOL/BNB
          // while still capping catastrophic slippage.
          p: this._formatPrice(coin, closeIsBuy ? slPrice * 1.05 : slPrice * 0.95),
          s: this._formatSize(coin, size),
          r: true,
          t: { trigger: { isMarket: true, triggerPx: this._formatPrice(coin, slPrice), tpsl: 'sl' } },
        },
      ],
      grouping: 'positionTpsl',
    });
    const statuses = res.response?.data?.statuses ?? [];
    const orders: TpSlOrders = { tp: null, sl: null };
    const tpStatus = statuses[0];
    const slStatus = statuses[1];
    if (tpStatus && typeof tpStatus === 'object' && 'resting' in tpStatus) {
      orders.tp = { clientId: tpStatus.resting.oid, goodTilSec: 0 };
    }
    if (slStatus && typeof slStatus === 'object' && 'resting' in slStatus) {
      orders.sl = { clientId: slStatus.resting.oid, goodTilSec: 0 };
    }
    // HL acks trigger orders as the bare string "waitingForTrigger", with
    // no oid, so the oids were never recorded and TP/SL were never
    // cancelled by id. Resolve them from the open-orders book instead.
    if (!orders.tp || !orders.sl) {
      const tpPx = Number(this._formatPrice(coin, tpPrice));
      const slPx = Number(this._formatPrice(coin, slPrice));
      for (let attempt = 0; attempt < 4 && (!orders.tp || !orders.sl); attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 500));
        try {
          const open = await this.getOpenOrders(market);
          const pick = (kind: 'tp' | 'sl', px: number): number | null => {
            const m = open.filter((o) => o.isTrigger && o.reduceOnly && o.kind === kind && Math.abs(o.triggerPx - px) <= px * 1e-6);
            return m.length > 0 ? Math.max(...m.map((o) => o.oid)) : null;
          };
          const tpOid = orders.tp ? null : pick('tp', tpPx);
          const slOid = orders.sl ? null : pick('sl', slPx);
          if (tpOid !== null) orders.tp = { clientId: tpOid, goodTilSec: 0 };
          if (slOid !== null) orders.sl = { clientId: slOid, goodTilSec: 0 };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.log('warning', `HlClient placeTPSL ${spotSymbol}: oid lookup failed: ${msg}`);
        }
      }
    }
    return orders;
  }

  async cancelTPSLOrder(
    spotSymbol: string,
    clientId: number | null | undefined,
    _type: 'tp' | 'sl',
    _goodTilSec: number,
  ): Promise<void> {
    if (!clientId) return;
    const { exchange } = this._requireConnected();
    const market = this.toMarketKey(spotSymbol);
    const coin = stripUsdSuffix(market);
    const idx = await this._assetIdxFor(coin);
    try {
      await exchange.cancel({ cancels: [{ a: idx, o: clientId }] });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.log('warning', `HlClient cancelTPSLOrder ${spotSymbol} oid=${clientId}: ${msg}`);
    }
  }

  async cancelTPSL(spotSymbol: string, orders: TpSlOrders | null | undefined): Promise<void> {
    if (orders?.tp) await this.cancelTPSLOrder(spotSymbol, orders.tp.clientId, 'tp', orders.tp.goodTilSec);
    if (orders?.sl) await this.cancelTPSLOrder(spotSymbol, orders.sl.clientId, 'sl', orders.sl.goodTilSec);
  }

  async getCandles(market: string, resolution = '4HOURS', limit = 600): Promise<unknown[]> {
    const { info } = this._requireConnected();
    const coin = stripUsdSuffix(market);
    const interval = resolutionToInterval(resolution);
    const endTime = Date.now();
    const startTime = endTime - intervalToMs(interval) * limit;
    const candles = await info.candleSnapshot({ coin, interval, startTime, endTime });
    // Map HL's t,T,o,c,h,l,v,n to `{ startedAt, open, high, low, close, ... }`.
    return candles.map((c) => ({
      startedAt: new Date(c.t).toISOString(),
      open: c.o,
      high: c.h,
      low: c.l,
      close: c.c,
      baseTokenVolume: c.v,
      usdVolume: '0',
      trades: c.n,
      resolution,
    }));
  }
}

export default HyperliquidExecutor;
