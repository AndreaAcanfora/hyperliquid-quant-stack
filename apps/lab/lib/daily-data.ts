import type { DailyData } from "./lab";

/** The coins the Lab can backtest. */
export const UNIVERSE = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "LINK", "AVAX", "ADA", "LTC", "SUI", "NEAR", "HYPE"];
const DAY = 86_400_000;
/** Six months before the first selectable start year, to warm up the 112-day lookback. */
export const HISTORY_START = Date.UTC(2020, 5, 1);

type HlCandle = { t: number; c: string };

async function dailyCandles(coin: string, endMs: number): Promise<HlCandle[]> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "candleSnapshot", req: { coin, interval: "1d", startTime: HISTORY_START, endTime: endMs } }),
    });
    if (res.ok) return (await res.json()) as HlCandle[];
    if (attempt === 3) throw new Error(`candleSnapshot ${coin}: HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
}

/** Closed daily closes for the universe from Hyperliquid's public API, aligned on one day axis. */
export async function fetchDailyData(nowMs = Date.now()): Promise<DailyData> {
  const today = Math.floor(nowMs / DAY) * DAY;
  const byCoin: Record<string, Map<number, number>> = {};
  for (const coin of UNIVERSE) {
    const rows = await dailyCandles(coin, nowMs);
    // The current UTC day is still forming.
    byCoin[coin] = new Map(rows.filter((k) => k.t < today).map((k) => [k.t, Number(k.c)]));
  }
  const days = [...new Set(Object.values(byCoin).flatMap((m) => [...m.keys()]))]
    .filter((d) => d >= HISTORY_START)
    .sort((a, b) => a - b);
  const closes = Object.fromEntries(UNIVERSE.map((c) => [c, days.map((d) => byCoin[c]!.get(d) ?? null)]));
  return { updatedAt: new Date(nowMs).toISOString(), days, closes };
}
