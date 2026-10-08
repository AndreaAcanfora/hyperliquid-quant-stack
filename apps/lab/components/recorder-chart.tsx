"use client";

import { useMemo, useRef, useState } from "react";
import { scaleLinear, scaleLog, scaleUtc } from "d3-scale";
import { area, line } from "d3-shape";
import { bisector } from "d3-array";
import type { CurvePoint } from "@/lib/lab";
import { pct } from "@/lib/lab";
import { useWidth } from "@/lib/use-width";

const DD_H = 84;
const M = { top: 12, right: 56, bottom: 26, left: 8 };

const fmtDay = (t: number) =>
  new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/**
 * Equity curve drawn like a chart-recorder trace: strategy in ink, BTC
 * buy-and-hold as a faint dashed pen, drawdown as a red strip underneath.
 * Log scale, because multi-year compounding is unreadable on a linear one.
 */
export function RecorderChart({ curve, busy }: { curve: CurvePoint[]; busy: boolean }) {
  const [hover, setHover] = useState<CurvePoint | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [boxRef, W] = useWidth<HTMLElement>();
  const H = W < 640 ? 260 : 360;

  const g = useMemo(() => {
    if (curve.length < 2) return null;
    const x = scaleUtc()
      .domain([curve[0]!.t, curve.at(-1)!.t])
      .range([M.left, W - M.right]);
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of curve) {
      for (const v of [p.equity, p.benchmark]) {
        if (Number.isFinite(v) && v > 0) {
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
    }
    const y = scaleLog().domain([lo * 0.92, hi * 1.08]).range([H - M.bottom, M.top]);
    const minDd = Math.min(-0.05, ...curve.map((p) => p.drawdown));
    const yDd = scaleLinear().domain([minDd, 0]).range([DD_H - 4, 4]);
    const equityPath = line<CurvePoint>().x((p) => x(p.t)).y((p) => y(p.equity))(curve) ?? "";
    const benchPath =
      line<CurvePoint>()
        .defined((p) => Number.isFinite(p.benchmark) && p.benchmark > 0)
        .x((p) => x(p.t))
        .y((p) => y(p.benchmark))(curve) ?? "";
    const ddPath =
      area<CurvePoint>().x((p) => x(p.t)).y0(yDd(0)).y1((p) => yDd(p.drawdown))(curve) ?? "";
    const yTicks = y.ticks(5).filter((v) => {
      const s = String(v);
      return s.startsWith("1") || s.startsWith("2") || s.startsWith("5");
    });
    return { x, y, yDd, equityPath, benchPath, ddPath, yTicks, xTicks: x.ticks(W < 640 ? 3 : 6), minDd };
  }, [curve, W, H]);

  if (!g) return <figure ref={boxRef} className="h-[460px]" />;

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const t = g.x.invert(((e.clientX - rect.left) / rect.width) * W).getTime();
    const i = bisector<CurvePoint, number>((p) => p.t).center(curve, t);
    setHover(curve[i] ?? null);
  };

  return (
    <figure ref={boxRef} className={`relative transition-opacity duration-150 ${busy ? "opacity-60" : ""}`}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H + DD_H}`}
        width={W}
        height={H + DD_H}
        className="block touch-none select-none"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label="Strategy equity versus BTC buy and hold, with drawdown below"
      >
        {g.yTicks.map((v) => (
          <g key={v}>
            <line x1={M.left} x2={W - M.right} y1={g.y(v)} y2={g.y(v)} className="stroke-grid-strong" strokeWidth={1} />
            <text x={W - M.right + 8} y={g.y(v) + 4} className="fill-ink-faint text-[12px]">
              {v >= 1 ? `${v.toFixed(v < 10 ? 1 : 0)}×` : `${v.toFixed(2)}×`}
            </text>
          </g>
        ))}
        {g.xTicks.filter((d) => g.x(d) > M.left + 18).map((d) => (
          <text key={d.getTime()} x={g.x(d)} y={H - 6} textAnchor="middle" className="fill-ink-faint text-[12px]">
            {d.getUTCFullYear()}
          </text>
        ))}
        <path d={g.benchPath} fill="none" className="stroke-ink-faint" strokeWidth={1.25} strokeDasharray="5 4" />
        <path d={g.equityPath} fill="none" className="stroke-ink" strokeWidth={2} strokeLinejoin="round" />

        <g transform={`translate(0 ${H})`}>
          <line x1={M.left} x2={W - M.right} y1={g.yDd(0)} y2={g.yDd(0)} className="stroke-grid-strong" />
          <path d={g.ddPath} className="fill-loss/25 stroke-loss" strokeWidth={1} />
          <text x={W - M.right + 8} y={g.yDd(g.minDd) + 4} className="fill-loss text-[12px]">
            {pct(g.minDd, 0)}
          </text>
        </g>

        {hover && (
          <g pointerEvents="none">
            <line x1={g.x(hover.t)} x2={g.x(hover.t)} y1={M.top} y2={H + DD_H - 4} className="stroke-ink" strokeWidth={1} />
            <circle cx={g.x(hover.t)} cy={g.y(hover.equity)} r={4} className="fill-marker stroke-ink" strokeWidth={1.5} />
          </g>
        )}
      </svg>
      <figcaption className="mt-2 flex min-h-6 flex-wrap gap-x-6 gap-y-1 text-sm text-ink-soft">
        {hover ? (
          <>
            <span className="font-medium text-ink">{fmtDay(hover.t)}</span>
            <span>Strategy {pct(hover.equity - 1)}</span>
            {Number.isFinite(hover.benchmark) && <span>BTC held {pct(hover.benchmark - 1)}</span>}
            <span className="text-loss">Drawdown {pct(hover.drawdown)}</span>
          </>
        ) : (
          <>
            <span className="inline-flex items-center gap-2"><Swatch dashed={false} />Strategy</span>
            <span className="inline-flex items-center gap-2"><Swatch dashed />BTC bought and held</span>
            <span>Growth of 1 unit, log scale. Red strip: drawdown from the last peak.</span>
          </>
        )}
      </figcaption>
    </figure>
  );
}

function Swatch({ dashed }: { dashed: boolean }) {
  return (
    <svg width="22" height="6" aria-hidden>
      <line x1="0" x2="22" y1="3" y2="3" className={dashed ? "stroke-ink-faint" : "stroke-ink"} strokeWidth={dashed ? 1.25 : 2} strokeDasharray={dashed ? "5 4" : undefined} />
    </svg>
  );
}
