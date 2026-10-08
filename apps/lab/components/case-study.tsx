/**
 * "The backtest said +87%": the findings that reshaped the live bot,
 * as percentages (no account sizes, no strategy parameters).
 */

type Bar = { label: string; value: number; note?: string; tone: "ink" | "faint" | "gain" | "loss" };

function Bars({ bars, max, unit }: { bars: Bar[]; max: number; unit: (v: number) => string }) {
  return (
    <ul className="space-y-3">
      {bars.map((b) => {
        const width = (Math.abs(b.value) / max) * 100;
        const color =
          b.tone === "gain" ? "bg-gain" : b.tone === "loss" ? "bg-loss" : b.tone === "faint" ? "bg-grid-strong" : "bg-ink";
        return (
          <li key={b.label}>
            <div className="flex items-baseline justify-between gap-4 text-sm">
              <span className="text-ink-soft">{b.label}</span>
              <span className="font-display text-lg font-semibold">{unit(b.value)}</span>
            </div>
            <div className="mt-1 h-2.5 w-full bg-white ring-1 ring-grid">
              <div className={`h-full ${color}`} style={{ width: `${Math.max(width, 0.8)}%` }} />
            </div>
            {b.note && <p className="mt-1 text-xs text-ink-faint">{b.note}</p>}
          </li>
        );
      })}
    </ul>
  );
}

const signed = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}%`;

export function CaseStudy() {
  return (
    <div className="grid gap-x-14 gap-y-12 lg:grid-cols-2">
      <div className="max-w-[64ch] space-y-4 text-[17px] leading-relaxed">
        <p>
          The bot had run on Hyperliquid for four months. Over the same window, its own backtest engine
          predicted <strong>+87%</strong>. The account had made <strong>+6%</strong>.
        </p>
        <p>
          Matching trades one by one showed the two were not even trading the same strategy: only
          9 of 53 backtest entries had a live counterpart. The engine read spot-exchange volume,
          while the bot trades perpetuals, and its 30-minute bars were built by counting rows of
          1-minute data, so every gap in the data shifted them off the clock. The strategy&apos;s
          signals are volume-gated, so both differences mattered.
        </p>
        <p>
          I built a replay that drives the bot&apos;s real signal code over the venue&apos;s own historical
          candles. It reproduces 46 of 48 live entries, and it became the only test I trust.
        </p>
        <p>
          On that replay, the most optimised strategy (143 tuned parameters, fitted on all available
          history) lost money out of sample. Removing two of its noisiest signals turned it positive
          and was confirmed on years it had never been tuned on. The trend ensemble in the Lab above
          went the other way entirely: six textbook parameters, none fitted, and identical results on
          two different data sources.
        </p>
      </div>

      <div className="space-y-10">
        <figure>
          <figcaption className="mb-3 font-medium">Four months of live trading, predicted and real</figcaption>
          <Bars
            max={90}
            unit={signed}
            bars={[
              { label: "Old backtest engine", value: 87.2, tone: "faint" },
              { label: "Live account", value: 6.3, tone: "ink", note: "20 May to 24 Sep 2026, net of fees and funding" },
            ]}
          />
        </figure>
        <figure>
          <figcaption className="mb-3 font-medium">Backtest entries that match a real one</figcaption>
          <Bars
            max={100}
            unit={(v) => `${Math.round(v)}%`}
            bars={[
              { label: "Old engine, 9 of 53", value: (9 / 53) * 100, tone: "faint" },
              { label: "Replay of the live code, 46 of 48", value: (46 / 48) * 100, tone: "ink" },
            ]}
          />
        </figure>
        <figure>
          <figcaption className="mb-3 font-medium">Out of sample, on the replay (22 Jun to 24 Sep 2026)</figcaption>
          <Bars
            max={12}
            unit={signed}
            bars={[
              { label: "Heavily optimised version", value: -2.4, tone: "loss" },
              { label: "Same strategy, two noisy signals removed", value: 11.4, tone: "gain", note: "Return on equity, one strategy slot" },
            ]}
          />
        </figure>
      </div>
    </div>
  );
}
