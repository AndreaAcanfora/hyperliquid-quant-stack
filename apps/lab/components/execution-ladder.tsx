"use client";

import { useEffect, useRef, useState } from "react";
import { ASK, SCENARIOS, TICK, type Scenario } from "@/lib/ladder-scenarios";

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
