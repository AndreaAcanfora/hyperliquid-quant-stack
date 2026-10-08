/**
 * Venue-agnostic exchange contract. `HyperliquidExecutor` implements it so
 * strategy code can hold one interface and stay testable with fakes.
 * Markets are addressed as `ETH-USD`; spot-style symbols (`ETHUSDC`) are
 * accepted and mapped by the implementation.
 */
export interface ExchangePositionInfo {
  side: 'LONG' | 'SHORT';
  size: string;
  entryPrice: string;
}

export interface ExchangeBalance {
  equity: number;
  freeCollateral: number;
  positions: Record<string, ExchangePositionInfo>;
  /**
   * Venue-specific raw asset positions blob. Exposed for diagnostics
   * (e.g. for logging); strategy code should
   * read `positions` instead.
   */
  assetPositions: Record<string, unknown>;
}

export interface ExchangeTradeResult {
  orderId: number;
  market: string;
  side: 'BUY' | 'SELL';
  /** Total filled size (sum of partials). */
  size: number;
  /** Weighted-average fill price across all partials. */
  price: number;
  /**
   * Total fee paid across all partials. On Hyperliquid this is populated
   * from the venue's `userFills` response (real fee, fee-token = USDC),
   * not from a maker/taker rate × notional model. Negative = rebate.
   */
  fee: number;
  reason: string;
  timestamp: string;
  /**
   * Venue-reported realized PnL from these fills, in quote currency
   * (USDC). Only meaningful for closing fills — opening fills always
   * report 0 here. When set we treat this as the authoritative PnL for
   * the close (it already includes fees, slippage and any partial
   * funding settlement). Absent on adapters that don't query a fills
   * endpoint.
   */
  closedPnl?: number;
  /**
   * True if any underlying fill crossed the book (taker). For mixed
   * maker/taker partial fills we report true so audit logs flag the
   * non-pure-maker outcome.
   */
  wasTaker?: boolean;
  /** How many partial fills make up this aggregate. ≥1 when populated. */
  fillCount?: number;
  /** L1 transaction hashes for audit / blockchain inspection. */
  fillTxHashes?: string[];
}

/**
 * One concrete fill reported by the venue. Hyperliquid surfaces these
 * via `userFills` / `userFillsByTime`.
 */
export interface OrderFill {
  /** Order ID this fill belongs to (multiple fills can share an oid). */
  oid: number;
  /** Fill price. */
  px: number;
  /** Fill size in base asset. */
  sz: number;
  /** "B" = bought, "A" = sold (HL convention; we preserve it as-is). */
  side: 'B' | 'A';
  /** Fee paid on this fill, in quote currency. Negative = rebate. */
  fee: number;
  /** Realized PnL on this fill — zero for opening fills. */
  closedPnl: number;
  /** True if this fill crossed the book (taker), false if maker. */
  crossed: boolean;
  /** Fill timestamp (ms since epoch, venue clock). */
  time: number;
  /** L1 tx hash for the bundle that included this fill. */
  hash: string;
  /**
   * Bare coin symbol (e.g. `"ETH"`, `"BNB"`) — the venue's primary
   * asset identifier. HL returns it as `coin`. Optional so existing callers that don't populate
   * it stay compatible.
   */
  coin?: string;
}

/**
 * Aggregated view of all fills that belong to a single order id. Use
 * `OrderFillsAggregate` to read what an order *actually did* — fee paid,
 * realized PnL, true average fill price (slippage-included), maker vs
 * taker outcome, audit-grade tx hashes. Returns `null` when the order
 * had no fills (cancelled before any partial executed).
 */
export interface OrderFillsAggregate {
  oid: number;
  fills: OrderFill[];
  /** Sum of all `fills[i].sz`. */
  totalSize: number;
  /** Weighted-average price: Σ(px × sz) / Σ(sz). */
  avgPrice: number;
  /** Sum of all `fills[i].fee`. */
  totalFee: number;
  /** Sum of all `fills[i].closedPnl`. Zero for opens. */
  totalClosedPnl: number;
  /** True iff any underlying fill crossed the book. */
  wasTaker: boolean;
  firstFillTime: number;
  lastFillTime: number;
  /** Unique L1 hashes covering these fills. */
  txHashes: string[];
}

export interface OpenOrderInfo {
  oid: number;
  isTrigger: boolean;
  reduceOnly: boolean;
  /** 'tp' for Take Profit triggers, 'sl' for Stop triggers, else 'other'. */
  kind: 'tp' | 'sl' | 'other';
  triggerPx: number;
}

export interface TpSlClientId {
  clientId: number;
  goodTilSec: number;
}

export interface TpSlOrders {
  tp: TpSlClientId | null;
  sl: TpSlClientId | null;
}

/**
 * Optional per-call context the runner passes into open/close so the
 * exchange client can publish its in-flight maker state to a store a UI
 * reads. `namespace` is e.g.
 * `user:<userId>:crypto-bot-v6.4` — same prefix the runner already uses
 * for flip-positions / cmd:close keys. Skip publishing when omitted.
 */
export interface OrderCallContext {
  namespace?: string;
  /**
   * Pre-close reconciliation knobs. When both are provided to
   * `closePosition`, the venue client compares the caller's claimed
   * share against the live on-chain aggregate BEFORE sending the close
   * order:
   *   - on-chain has no position OR wrong side OR size < expectedSize
   *     → return `null` (stale local state) and do NOT touch the venue.
   *   - on-chain ≥ expectedSize in the right direction → place a
   *     reduce-only close for exactly `expectedSize` (partial close),
   *     not the full on-chain quantity.
   *
   * This unblocks concurrent ownership across strategy instances that
   * share the same unified-margin HL account: each strategy closes
   * only its attributed share without rugging the other strategy's
   * still-open quota.
   *
   * Omitting either field falls back to the legacy "close the full
   * on-chain position" semantics — kept for callers that intentionally
   * want to flatten everything (e.g. admin emergency button).
   */
  expectedSize?: number;
  expectedSide?: 'LONG' | 'SHORT';
}

/**
 * In-flight maker order state published through `OrderStateSink` during a
 * multi-step maker attempt (e.g. so a UI can lock a manual close button).
 */
export interface OrderStateValue {
  state: 'maker-waiting' | 'maker-step2' | 'maker-step3' | 'taker-fallback';
  startedAt: number;        // ms epoch
  deadlineAt: number;       // ms epoch
  reason: string;           // FLAT | MH | entry | …
  currentStep: 1 | 2 | 3;
  oid?: number;             // HL order id of the resting limit
}

export interface ExchangeClient {
  /**
   * User ID (cuid) on whose behalf this client signs. `null` when
   * the client is not tied to an application user.
   */
  readonly userId: string | null;

  /**
   * Resolve signing credentials + connect to the venue. `userId` opts
   * the client into per-user signing (DB-backed permissioned key);
   * omitting it uses the default credentials.
   */
  connect(userId?: string): Promise<unknown>;

  /**
   * Release any persistent resources (e.g. open WebSockets, in-memory
   * caches). Optional because legacy implementations are HTTP-only.
   */
  disconnect?(): Promise<void>;

  getBalance(): Promise<ExchangeBalance>;
  getPositions(): Promise<Record<string, ExchangePositionInfo>>;
  getOraclePrice(market: string): Promise<number>;

  /**
   * Convert a bot-internal spot symbol (e.g. `ETHUSDC`) into the
   * venue's market identifier (`ETH-USD`).
   */
  toMarketKey(spotSymbol: string): string;

  openLong(spotSymbol: string, usdAmount: number, reason?: string, ctx?: OrderCallContext): Promise<ExchangeTradeResult | null>;
  openShort(spotSymbol: string, usdAmount: number, reason?: string, ctx?: OrderCallContext): Promise<ExchangeTradeResult | null>;
  closePosition(spotSymbol: string, reason?: string, ctx?: OrderCallContext): Promise<ExchangeTradeResult | null>;

  placeTPSL(
    spotSymbol: string,
    direction: 'LONG' | 'SHORT',
    size: number,
    tpPrice: number,
    slPrice: number,
  ): Promise<TpSlOrders>;
  cancelTPSL(spotSymbol: string, orders: TpSlOrders | null | undefined): Promise<void>;
  cancelTPSLOrder(
    spotSymbol: string,
    clientId: number | null | undefined,
    type: 'tp' | 'sl',
    goodTilSec: number,
  ): Promise<void>;

  getCandles(market: string, resolution?: string, limit?: number): Promise<unknown[]>;

  /**
   * Look up the fills for a given order id. Used right after open/close
   * to get authoritative fee, fill price and realized PnL straight from
   * the venue (instead of modelling them client-side). Returns `null`
   * when the order produced no fills (cancelled before execution) or
   * when the adapter doesn't expose a fills endpoint.
   *
   * Implementations should poll briefly (~5s, every ~500ms) since fills
   * can lag the `order()` response by a few hundred milliseconds.
   */
  getFillsForOrder?(
    oid: number,
    options?: { pollMaxMs?: number; pollIntervalMs?: number },
  ): Promise<OrderFillsAggregate | null>;

  /**
   * Range query of fills, used to reconcile recorded trades
   * against the venue's canonical fill ledger. Returns all fills in [startMs, endMs?].
   */
  getFillsByTime?(
    startMs: number,
    endMs?: number,
  ): Promise<OrderFill[]>;

  /** Resting orders (incl. trigger TP/SL) on a market. */
  getOpenOrders?(market: string): Promise<OpenOrderInfo[]>;

  /**
   * Net funding on a market since `startMs`, in quote currency
   * (negative = paid). Not included in venue `closedPnl`.
   */
  getFundingSince?(market: string, startMs: number, endMs?: number): Promise<number>;

  /** Hourly funding rates (public), positive = longs pay. */
  getFundingRates?(market: string, startMs: number, endMs: number): Promise<Array<{ time: number; rate: number }>>;
}
