import type { CandleSnapshotParameters } from '@nktkas/hyperliquid';

export type CandleInterval = CandleSnapshotParameters['interval'];

/** `ETH-USD` -> `ETH`, the coin name the HL API expects. */
export function coinOf(market: string): string {
  return market.replace(/-USD$/, '');
}

// Spot-style symbols accepted as aliases for `<COIN>-USD` markets.
const SYMBOL_TO_MARKET: Record<string, string> = {
  ETHUSDC: 'ETH-USD',
  ETHUSDT: 'ETH-USD',
  SOLUSDC: 'SOL-USD',
  SOLUSDT: 'SOL-USD',
  BNBUSDC: 'BNB-USD',
  BNBUSDT: 'BNB-USD',
  BTCUSDC: 'BTC-USD',
  BTCUSDT: 'BTC-USD',
};

/** `ETHUSDC` / `ETH-USD` / `DOGEUSDT` -> `ETH-USD` / `ETH-USD` / `DOGE-USD`; unknown formats pass through. */
export function toMarket(symbol: string): string {
  const known = SYMBOL_TO_MARKET[symbol];
  if (known) return known;
  if (symbol.includes('-')) return symbol;
  const m = symbol.match(/^([A-Z0-9]+?)USD[CT]?$/);
  return m && m[1] ? `${m[1]}-USD` : symbol;
}

// Resolution names (`4HOURS`, `1DAY`, ...) -> HL `candleSnapshot` interval.
const RESOLUTION_MAP: Record<string, CandleInterval> = {
  '1MIN': '1m',
  '5MINS': '5m',
  '15MINS': '15m',
  '30MINS': '30m',
  '1HOUR': '1h',
  '2HOURS': '2h',
  '4HOURS': '4h',
  '1DAY': '1d',
};

/** Accepts `4HOURS`-style names or native HL intervals; unknown values fall back to 4h. */
export function toInterval(resolution: string): CandleInterval {
  return RESOLUTION_MAP[resolution] ?? (isInterval(resolution) ? resolution : '4h');
}

const INTERVAL_MS: Record<CandleInterval, number> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '8h': 28_800_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
  '3d': 259_200_000,
  '1w': 604_800_000,
  '1M': 2_592_000_000,
};

export function intervalMs(interval: CandleInterval): number {
  return INTERVAL_MS[interval];
}

function isInterval(s: string): s is CandleInterval {
  return s in INTERVAL_MS;
}
