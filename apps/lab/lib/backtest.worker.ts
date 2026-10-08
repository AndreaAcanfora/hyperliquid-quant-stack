/// <reference lib="webworker" />
// Runs the trend-ensemble backtest off the main thread so the sliders stay
// responsive while ~2,000 days x 13 coins are simulated.
import { runBacktest } from "@andreaaca/trend-ensemble";
import { toParams, type CurvePoint, type WorkerRequest, type WorkerResponse } from "./lab";

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const started = performance.now();
  const { id, data, settings } = e.data;
  const closes = Object.fromEntries(settings.coins.map((c) => [c, data.closes[c] ?? []]));
  const startMs = Date.UTC(settings.startYear, 0, 1);
  const res = runBacktest({ days: data.days, closes }, toParams(settings), { startMs, recordWeights: true });

  // Benchmark: buy and hold BTC from the same start.
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

  const msg: WorkerResponse = {
    id,
    curve,
    stats: res.stats,
    benchmarkReturn: lastBench ? lastBench.benchmark - 1 : 0,
    positions,
    ms: performance.now() - started,
  };
  self.postMessage(msg);
};
