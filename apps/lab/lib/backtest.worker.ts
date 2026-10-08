/// <reference lib="webworker" />
// Runs the trend-ensemble backtest off the main thread so the sliders stay
// responsive while ~2,000 days x 13 coins are simulated.
import type { WorkerRequest, WorkerResponse } from "./lab";
import { simulate } from "./simulate";

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const started = performance.now();
  const { id, data, settings } = e.data;
  const msg: WorkerResponse = { id, ...simulate(data, settings), ms: performance.now() - started };
  self.postMessage(msg);
};
