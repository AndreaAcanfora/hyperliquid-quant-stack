/**
 * Tests for src/shadow.ts (paper runner).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_UNIVERSE, runShadowDay, type ShadowClient } from '../src/shadow.js';


const DAY = 86_400_000;
const T0 = Date.parse('2026-09-25T00:30:00Z'); // 30 min after the UTC close

/** Daily candles ending with the in-progress day of `now`. */
function makeClient(series: Record<string, (i: number) => number>, now: () => number, mark: Record<string, number>): ShadowClient {
  return {
    getCandles: async (market: string, _res?: string, limit = 150) => {
      const coin = market.replace('-USD', '');
      const f = series[coin];
      if (!f) throw new Error('unknown coin');
      const today = Math.floor(now() / DAY) * DAY;
      const out = [];
      for (let k = limit; k >= 0; k--) {
        const t = today - k * DAY;
        out.push({ startedAt: new Date(t).toISOString(), close: f(limit - k) });
      }
      return out;
    },
    getOraclePrice: async (market: string) => mark[market.replace('-USD', '')] ?? 0,
  };
}

describe('runShadowDay', () => {

test('buys the uptrending coin, skips the downtrend, persists state and logs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-'));
  let now = T0;
  // UP: steady +0.5%/day with small noise; DOWN: mirror.
  const up = (i: number) => 100 * Math.pow(1.005, i) * (1 + (i % 2 ? 0.01 : -0.01));
  const down = (i: number) => 100 * Math.pow(0.995, i) * (1 + (i % 2 ? 0.01 : -0.01));
  const client = makeClient({ UP: up, DOWN: down }, () => now, { UP: 180, DOWN: 55 });
  const reports: string[] = [];
  const r = await runShadowDay({ client, dir, capital: 1000, universe: ['UP', 'DOWN'], now: () => now, report: async (t) => { reports.push(t); } });
  assert.ok(r, 'ran');
  assert.equal(r!.orders.length, 1);
  assert.equal(r!.orders[0]!.coin, 'UP');
  assert.equal(r!.orders[0]!.side, 'BUY');
  assert.ok(r!.equity < 1000 && r!.equity > 999, `only fees/slippage lost, got ${r!.equity}`);
  const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  assert.ok(state.positions.UP > 0 && !state.positions.DOWN);
  assert.equal(state.lastRunDay, '2026-09-25');
  assert.ok(existsSync(join(dir, 'trades.jsonl')) && existsSync(join(dir, 'daily.jsonl')));
  assert.equal(reports.length, 1);
  assert.match(reports[0]!, /shadow \(no real orders\)/);

  // Same day again -> no-op; next day with UP collapsing -> sells to flat.
  assert.equal(await runShadowDay({ client, dir, capital: 1000, universe: ['UP', 'DOWN'], now: () => now }), null);
  now = T0 + DAY;
  const crash = makeClient({ UP: (i) => (i > 100 ? 40 : up(i)), DOWN: down }, () => now, { UP: 40, DOWN: 55 });
  const r2 = await runShadowDay({ client: crash, dir, capital: 1000, universe: ['UP', 'DOWN'], now: () => now });
  assert.ok(r2);
  assert.equal(r2!.orders[0]?.side, 'SELL');
  const s2 = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  assert.equal(s2.positions.UP, undefined, 'closed to flat');
});

test('waits until 10 minutes after the UTC close', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-'));
  const now = Date.parse('2026-09-25T00:05:00Z');
  const client = makeClient({ UP: (i) => 100 + i }, () => now, { UP: 200 });
  assert.equal(await runShadowDay({ client, dir, capital: 1000, universe: ['UP'], now: () => now }), null);
});

test('skips the day instead of trading when a held coin has no price', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-'));
  let now = T0;
  const up = (i: number) => 100 * Math.pow(1.005, i) * (1 + (i % 2 ? 0.01 : -0.01));
  await runShadowDay({ client: makeClient({ UP: up }, () => now, { UP: 180 }), dir, capital: 1000, universe: ['UP'], now: () => now });
  now = T0 + DAY;
  const broken = makeClient({ UP: up }, () => now, { UP: 0 });
  assert.equal(await runShadowDay({ client: broken, dir, capital: 1000, universe: ['UP'], now: () => now }), null);
  const s = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  assert.equal(s.lastRunDay, '2026-09-25', 'day not consumed');
});

test('charges funding on the held book since the previous run (longs pay positive rates)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-'));
  let now = T0;
  const up = (i: number) => 100 * Math.pow(1.005, i) * (1 + (i % 2 ? 0.01 : -0.01));
  const base = makeClient({ UP: up }, () => now, { UP: 180 });
  let window: [number, number] | null = null;
  const client: ShadowClient = {
    ...base,
    getFundingRates: async (_m, start, end) => { window = [start, end]; return Array.from({ length: 24 }, (_, h) => ({ time: start + h * 3_600_000, rate: 0.0000125 })); },
  };
  await runShadowDay({ client, dir, capital: 1000, universe: ['UP'], now: () => now });
  const s1 = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  assert.equal(s1.fundingPaid ?? 0, 0, 'no funding before any position was held');
  now = T0 + DAY;
  const r = await runShadowDay({ client, dir, capital: 1000, universe: ['UP'], now: () => now });
  const expected = s1.positions.UP * 180 * 24 * 0.0000125;
  assert.ok(r && Math.abs(r.funding - expected) < 1e-9, `funding ${r?.funding} vs ${expected}`);
  assert.deepEqual(window, [T0, T0 + DAY], 'accrual window = previous run -> now');
  const s2 = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  assert.ok(Math.abs(s2.fundingPaid - expected) < 1e-9);
});

test('resumes a book written by an older release and uses the label', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-'));
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    version: 'v8-shadow-1', startedAt: '2026-09-01T00:00:00.000Z', capitalStart: 500,
    cash: 500, positions: {}, feesPaid: 0, lastRunDay: '2026-09-24',
  }));
  const up = (i: number) => 100 * Math.pow(1.005, i) * (1 + (i % 2 ? 0.01 : -0.01));
  const client = makeClient({ UP: up }, () => T0, { UP: 180 });
  const logs: string[] = [];
  const reports: string[] = [];
  const r = await runShadowDay({
    client, dir, capital: 1000, universe: ['UP'], now: () => T0, label: 'paper',
    log: (_l, m) => { logs.push(m); }, report: async (t) => { reports.push(t); },
  });
  assert.ok(r);
  assert.ok(r!.equityBefore === 500, 'kept the stored capital, not the new one');
  assert.match(logs.at(-1)!, /^\[paper\] 2026-09-25/);
  assert.match(reports[0]!, /^paper \(no real orders\)/);
  assert.ok(DEFAULT_UNIVERSE.includes('BTC'));
});
});
