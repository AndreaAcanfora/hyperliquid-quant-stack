// Fetch daily closes from Hyperliquid's public API into public/data/daily.json.
// Runs before every build, so the deployed Lab always backtests on data up to
// the previous UTC close. No keys needed.
import { mkdirSync, writeFileSync } from 'node:fs';

const UNIVERSE = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'LINK', 'AVAX', 'ADA', 'LTC', 'SUI', 'NEAR', 'HYPE'];
const DAY = 86_400_000;
// Six months before the first selectable start year, to warm up the 112-day lookback.
const START = Date.UTC(2020, 5, 1);

async function candles(coin) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval: '1d', startTime: START, endTime: Date.now() } }),
    });
    if (res.ok) return res.json();
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  throw new Error(`candleSnapshot ${coin} failed`);
}

const today = Math.floor(Date.now() / DAY) * DAY;
const byCoin = {};
for (const coin of UNIVERSE) {
  const rows = await candles(coin);
  // Keep closed days only (the current UTC day is still forming).
  byCoin[coin] = new Map(rows.filter((k) => k.t < today).map((k) => [k.t, Number(k.c)]));
}
const allDays = [...new Set(Object.values(byCoin).flatMap((m) => [...m.keys()]))].sort((a, b) => a - b);
const days = allDays.filter((d) => d >= START);
const closes = Object.fromEntries(
  UNIVERSE.map((c) => [c, days.map((d) => byCoin[c].get(d) ?? null)]),
);
mkdirSync('public/data', { recursive: true });
writeFileSync('public/data/daily.json', JSON.stringify({ updatedAt: new Date().toISOString(), days, closes }));
console.log(`daily.json: ${days.length} days x ${UNIVERSE.length} coins, last ${new Date(days.at(-1)).toISOString().slice(0, 10)}`);
