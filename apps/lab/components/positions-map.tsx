"use client";

import { useMemo, useState } from "react";
import { useWidth } from "@/lib/use-width";

const ROW = 18;
const LABEL = 52;

/**
 * What the strategy held, week by week: one row per coin, each cell's
 * strength is the share of equity in that coin (green long, red short).
 * Trend-following shows up as long unbroken bands; chop as speckle.
 */
export function PositionsMap({
  positions,
  coins,
}: {
  positions: { t: number; weights: Record<string, number> }[];
  coins: string[];
}) {
  const [hover, setHover] = useState<{ coin: string; i: number } | null>(null);
  const [boxRef, W] = useWidth<HTMLElement>();
  const { maxW, years } = useMemo(() => {
    let m = 0;
    for (const p of positions) for (const v of Object.values(p.weights)) m = Math.max(m, Math.abs(v));
    const ys: { i: number; y: number }[] = [];
    positions.forEach((p, i) => {
      const y = new Date(p.t).getUTCFullYear();
      if (i === 0 || new Date(positions[i - 1]!.t).getUTCFullYear() !== y) ys.push({ i, y });
    });
    return { maxW: m || 1, years: ys };
  }, [positions]);

  if (positions.length === 0) return null;
  const cw = (W - LABEL) / positions.length;
  const h = coins.length * ROW + 22;
  const hovered = hover ? positions[hover.i] : null;

  return (
    <section ref={boxRef} className="mt-12" aria-labelledby="held-heading">
      <h3 id="held-heading" className="font-display text-xl font-semibold">What it held</h3>
      <p className="mt-1 max-w-[62ch] text-ink-soft">
        Each row is a coin, each column a week. The darker the cell, the larger the position. Long trends
        read as unbroken bands; sideways markets as scattered, short-lived holdings.
      </p>
      <svg
        viewBox={`0 0 ${W} ${h}`}
        width={W}
        height={h}
        className="mt-4 block"
        role="img"
        aria-label="Weekly position size per coin"
        onPointerLeave={() => setHover(null)}
      >
        {coins.map((coin, r) => (
          <g key={coin} transform={`translate(0 ${r * ROW})`}>
            <text x={0} y={ROW - 5} className="fill-ink-soft text-[12px]">{coin}</text>
            <rect x={LABEL} y={1} width={W - LABEL} height={ROW - 2} className="fill-white" />
            {positions.map((p, i) => {
              const w = p.weights[coin] ?? 0;
              if (w === 0) return null;
              return (
                <rect
                  key={i}
                  x={LABEL + i * cw}
                  y={1}
                  width={Math.max(cw, 0.6)}
                  height={ROW - 2}
                  className={w > 0 ? "fill-gain" : "fill-loss"}
                  fillOpacity={0.15 + 0.85 * Math.min(1, Math.abs(w) / maxW)}
                  onPointerEnter={() => setHover({ coin, i })}
                />
              );
            })}
          </g>
        ))}
        {years.map(({ i, y }) => (
          <g key={y}>
            <line x1={LABEL + i * cw} x2={LABEL + i * cw} y1={0} y2={coins.length * ROW} className="stroke-ink-faint" strokeWidth={0.75} />
            <text x={LABEL + i * cw + 3} y={h - 6} className="fill-ink-faint text-[12px]">{y}</text>
          </g>
        ))}
      </svg>
      <p className="mt-1 min-h-6 text-sm text-ink-soft" aria-live="polite">
        {hover && hovered
          ? `${hover.coin}, week of ${new Date(hovered.t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}: ${((hovered.weights[hover.coin] ?? 0) * 100).toFixed(1)}% of equity`
          : "Point at a cell to see the position size."}
      </p>
    </section>
  );
}
