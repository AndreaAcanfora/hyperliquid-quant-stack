/**
 * A replay of how HyperliquidExecutor buys: post-only limit orders that
 * step one tick closer to the ask, then a taker order for whatever is
 * still unfilled. Each scenario is a scripted sequence of frames that
 * mirrors a unit-tested path in packages/hl-exec.
 */

export const TICK = 0.1;
export const BID = 2450.3;
export const ASK = 2450.8;

export type Frame = {
  /** Our resting buy price, or null when nothing rests. */
  order: number | null;
  /** Share of the target size filled so far (0..1). */
  filled: number;
  /** Price a taker order sweeps at, when one fires. */
  taker?: number;
  outcome?: "done" | "failed";
  log: string;
};

export type Scenario = { key: string; label: string; summary: string; frames: Frame[] };

export const SCENARIOS: Scenario[] = [
  {
    key: "patient",
    label: "Patient fill",
    summary: "Joins the best bid, steps up once, and fills entirely as a maker: lowest fee, no spread paid.",
    frames: [
      { order: BID, filled: 0, log: "Post-only buy at the best bid, $2,450.30" },
      { order: BID, filled: 0, log: "80 s pass without a fill" },
      { order: BID + TICK, filled: 0, log: "Cancel and repost one tick higher, $2,450.40" },
      { order: BID + TICK, filled: 0.35, log: "A seller hits us: 35% filled" },
      { order: BID + TICK, filled: 1, log: "Rest of the order fills" },
      { order: null, filled: 1, outcome: "done", log: "Done: 100% filled at maker fee (0.015%)" },
    ],
  },
  {
    key: "partial",
    label: "Partial, then taker",
    summary: "Fills 40% patiently, times out, and crosses the spread for the remaining 60% only. An older version re-sent the full size here and doubled the position.",
    frames: [
      { order: BID, filled: 0, log: "Post-only buy at the best bid, $2,450.30" },
      { order: BID, filled: 0.4, log: "40% fills while resting" },
      { order: BID + TICK, filled: 0.4, log: "Step 2: repost the remaining 60%, one tick higher" },
      { order: BID + 2 * TICK, filled: 0.4, log: "Step 3: repost the remaining 60%, two ticks higher" },
      { order: null, filled: 0.4, log: "240 s ladder over: cancel what is still resting" },
      { order: null, filled: 1, taker: ASK * 1.0025, log: "Taker order for the 60% left, priced past the ask" },
      { order: null, filled: 1, outcome: "done", log: "Done: exactly 100%, no double fill" },
    ],
  },
  {
    key: "rejected",
    label: "Close rejected",
    summary: "The exchange keeps refusing the closing order. Instead of forgetting the position, the client reports it as still open, so it stays protected and is retried.",
    frames: [
      { order: null, filled: 0, log: "Exit signal: send a reduce-only taker order" },
      { order: null, filled: 0, log: "Rejected by the exchange (attempt 1 of 3)" },
      { order: null, filled: 0, log: "Rejected (attempt 2 of 3)" },
      { order: null, filled: 0, log: "Rejected (attempt 3 of 3)" },
      { order: null, filled: 0, log: "Check the venue: position still open" },
      { order: null, filled: 0, outcome: "failed", log: "CloseFailedError: stop-loss and take-profit stay in place, retry next tick" },
    ],
  },
];
