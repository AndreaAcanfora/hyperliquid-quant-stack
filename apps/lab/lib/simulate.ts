import { runBacktest } from "@andreaaca/trend-ensemble";
import { toParams, type CurvePoint, type DailyData, type LabSettings, type WorkerResponse } from "./lab";

export type Simulation = Omit<WorkerResponse, "id" | "ms">;

/** One Lab run: the strategy curve, BTC buy-and-hold from the same day, and weekly weights. */
export function simulate(data: DailyData, settings: LabSettings): Simulation {
  const closes = Object.fromEntries(settings.coins.map((c) => [c, data.closes[c] ?? []]));
  const startMs = Date.UTC(settings.startYear, 0, 1);
  const res = runBacktest({ days: data.days, closes }, toParams(settings), { startMs, recordWeights: true });

  const btc = data.closes.BTC ?? [];
  const firstIdx = data.days.findIndex((d) => d >= startMs);
  const btc0 = btc[firstIdx] ?? null;
  let peak = 1;
  const curve: CurvePoint[] = res.points.map((p, i) => {
    peak = Math.max(peak, p.equity);
    const px = btc[firstIdx + i] ?? null;
    return {
      t: p.t,
      equity: p.equity,
      benchmark: btc0 && px ? px / btc0 : NaN,
      drawdown: p.equity / peak - 1,
    };
  });
  const lastBench = [...curve].reverse().find((c) => Number.isFinite(c.benchmark));

  // Weekly samples are plenty for the positions chart.
  const positions = res.points
    .filter((_, i) => i % 7 === 0)
    .map((p) => ({ t: p.t, weights: p.weights ?? {} }));

  return {
    curve,
    stats: res.stats,
    benchmarkReturn: lastBench ? lastBench.benchmark - 1 : 0,
    positions,
  };
}
