import type { BacktestStats, TrendEnsembleParams } from "@andreaaca/trend-ensemble";

/** public/data/daily.json, written by scripts/fetch-data.mjs at build time. */
export interface DailyData {
  updatedAt: string;
  days: number[];
  closes: Record<string, Array<number | null>>;
}

/** What the user can change in the Lab. */
export interface LabSettings {
  /** Multiplier on the 14/28/56/112-day lookbacks. */
  horizon: number;
  /** Target annualised volatility per coin, before dividing by N. */
  volTarget: number;
  /** Cap on total exposure as a multiple of equity. */
  grossCap: number;
  /** No-trade band as a fraction of each target weight. */
  band: number;
  longOnly: boolean;
  coins: string[];
  startYear: number;
}

export const BASE_LOOKBACKS = [14, 28, 56, 112];

export const DEFAULT_SETTINGS: LabSettings = {
  horizon: 1,
  volTarget: 0.6,
  grossCap: 1.5,
  band: 0.2,
  longOnly: true,
  coins: ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "LINK", "AVAX", "ADA", "LTC", "SUI", "NEAR", "HYPE"],
  startYear: 2021,
};

export function toParams(s: LabSettings): TrendEnsembleParams {
  return {
    lookbacks: BASE_LOOKBACKS.map((l) => Math.max(2, Math.round(l * s.horizon))),
    volLookback: 30,
    volTarget: s.volTarget,
    grossCap: s.grossCap,
    band: s.band,
    longOnly: s.longOnly,
  };
}

/** Messages exchanged with the backtest Web Worker. */
export interface WorkerRequest {
  id: number;
  data: DailyData;
  settings: LabSettings;
}

export interface CurvePoint {
  t: number;
  equity: number;
  benchmark: number;
  drawdown: number;
}

export interface WorkerResponse {
  id: number;
  curve: CurvePoint[];
  stats: BacktestStats;
  benchmarkReturn: number;
  /** Per-day weight per coin, downsampled to keep the payload small. */
  positions: { t: number; weights: Record<string, number> }[];
  ms: number;
}

export const pct = (x: number, digits = 1) =>
  `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(digits)}%`;
