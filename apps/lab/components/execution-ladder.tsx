"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A replay of how HyperliquidExecutor buys: post-only limit orders that
 * step one tick closer to the ask, then a taker order for whatever is
 * still unfilled. Each scenario is a scripted sequence of frames that
 * mirrors a unit-tested path in packages/hl-exec.
 */

const TICK = 0.1;
const BID = 2450.3;
const ASK = 2450.8;

type Frame = {
  /** Our resting buy price, or null when nothing rests. */
  order: number | null;
  /** Share of the target size filled so far (0..1). */
  filled: number;
  /** Price a taker order sweeps at, when one fires. */
  taker?: number;
  outcome?: "done" | "failed";
  log: string;
};

type Scenario = { key: string; label: string; summary: string; frames: Frame[] };

const SCENARIOS: Scenario[] = [
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

const LEVELS = 10;
const STEP_MS = 900;

export function ExecutionLadder() {
  const [scenario, setScenario] = useState(SCENARIOS[1]!);
  const [frame, setFrame] = useState(-1);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const play = (s: Scenario) => {
    if (timer.current) clearTimeout(timer.current);
    setScenario(s);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setFrame(s.frames.length - 1);
      return;
    }
    let i = 0;
    setFrame(0);
    const tick = () => {
      i += 1;
      if (i >= s.frames.length) return;
      setFrame(i);
      timer.current = setTimeout(tick, STEP_MS);
    };
    timer.current = setTimeout(tick, STEP_MS);
  };

  const f = frame >= 0 ? scenario.frames[frame]! : null;
  const prices = Array.from({ length: LEVELS }, (_, i) => +(ASK + (LEVELS / 2 - 1 - i) * TICK).toFixed(1));

  return (
    <div className="grid gap-8 md:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
      <div>
        <div role="radiogroup" aria-label="Scenario" className="flex flex-col gap-2">
          {SCENARIOS.map((s) => (
            <button
              key={s.key}
              type="button"
              role="radio"
              aria-checked={scenario.key === s.key}
              onClick={() => play(s)}
              className={`rounded-sm border px-4 py-3 text-left transition-colors ${
                scenario.key === s.key ? "border-ink bg-white" : "border-grid-strong hover:border-ink"
              }`}
            >
              <span className="block font-medium">{s.label}</span>
              <span className="mt-1 block text-sm text-ink-soft">{s.summary}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => play(scenario)}
          className="mt-4 rounded-sm bg-ink px-4 py-2 font-medium text-paper hover:bg-ink-soft"
        >
          {frame < 0 ? "Play" : "Replay"} {scenario.label.toLowerCase()}
        </button>
      </div>

      <div className="grid gap-6 sm:grid-cols-[180px_minmax(0,1fr)]">
        <ol aria-label="Order book around the spread" className="graph-paper self-start rounded-sm border border-grid-strong p-2 font-display text-sm">
          {prices.map((p) => {
            const isAsk = p >= ASK;
            const ours = f?.order !== null && f?.order !== undefined && Math.abs(f.order - p) < 1e-6;
            return (
              <li key={p} className={`flex items-center justify-between px-2 py-1 ${ours ? "bg-marker" : ""}`}>
                <span className={isAsk ? "text-loss" : "text-gain"}>{p.toFixed(1)}</span>
                <span className="text-xs text-ink-faint">{ours ? "our bid" : isAsk ? "ask" : "bid"}</span>
              </li>
            );
          })}
        </ol>

        <div>
          <div className="text-sm text-ink-soft">Filled</div>
          <div className="mt-1 h-3 w-full overflow-hidden rounded-full bg-white ring-1 ring-grid-strong">
            <div
              className={`h-full transition-[width] duration-500 ${f?.outcome === "failed" ? "bg-loss" : "bg-ink"}`}
              style={{ width: `${(f?.filled ?? 0) * 100}%` }}
            />
          </div>
          <div className="mt-1 font-display text-2xl font-semibold">{Math.round((f?.filled ?? 0) * 100)}%</div>
          <ol className="mt-4 space-y-2 text-sm" aria-live="polite">
            {scenario.frames.slice(0, frame + 1).map((fr, i) => (
              <li
                key={i}
                className={`border-l-2 pl-3 ${
                  fr.outcome === "failed" ? "border-loss text-loss" : fr.outcome === "done" ? "border-gain text-gain" : i === frame ? "border-ink text-ink" : "border-grid-strong text-ink-soft"
                }`}
              >
                {fr.log}
                {fr.taker ? ` (limit $${fr.taker.toFixed(2)})` : ""}
              </li>
            ))}
            {frame < 0 && <li className="text-ink-soft">Pick a scenario to watch the order work the book.</li>}
          </ol>
        </div>
      </div>
    </div>
  );
}
