import { describe, expect, test } from "vitest";
import { DEFAULT_SETTINGS, type DailyData } from "../lib/lab";
import { simulate } from "../lib/simulate";

const DAY = 86_400_000;
const START = Date.UTC(2020, 5, 1);

/** 900 days: BTC rises steadily with noise, ETH falls. */
function synthetic(): DailyData {
  const days = Array.from({ length: 900 }, (_, i) => START + i * DAY);
  const wiggle = (i: number) => 1 + 0.02 * Math.sin(i / 3);
  return {
    updatedAt: new Date(days.at(-1)!).toISOString(),
    days,
    closes: {
      BTC: days.map((_, i) => 100 * 1.002 ** i * wiggle(i)),
      ETH: days.map((_, i) => 100 * 0.999 ** i * wiggle(i)),
    },
  };
}

describe("simulate", () => {
  const data = synthetic();
  const settings = { ...DEFAULT_SETTINGS, coins: ["BTC", "ETH"], startYear: 2021 };
  const sim = simulate(data, settings);

  test("the curve starts at the selected year with equity and benchmark at 1", () => {
    expect(sim.curve[0]!.t).toBeGreaterThanOrEqual(Date.UTC(2021, 0, 1));
    expect(sim.curve[0]!.equity).toBeCloseTo(1, 2);
    expect(sim.curve[0]!.benchmark).toBeCloseTo(1, 10);
  });

  test("drawdown is never positive and matches the reported worst", () => {
    expect(sim.curve.every((p) => p.drawdown <= 0)).toBe(true);
    const worst = Math.min(...sim.curve.map((p) => p.drawdown));
    expect(worst).toBeCloseTo(sim.stats.maxDrawdown, 6);
  });

  test("benchmark return is BTC buy-and-hold over the same window", () => {
    const first = data.days.findIndex((d) => d >= Date.UTC(2021, 0, 1));
    const last = first + sim.curve.length - 1;
    const btc = data.closes.BTC!;
    expect(sim.benchmarkReturn).toBeCloseTo(btc[last]! / btc[first]! - 1, 10);
  });

  test("long-only: the uptrend is held, the downtrend never is", () => {
    const held = sim.positions.filter((p) => (p.weights.BTC ?? 0) > 0).length;
    expect(held).toBeGreaterThan(sim.positions.length / 2);
    expect(sim.positions.every((p) => (p.weights.ETH ?? 0) <= 0)).toBe(true);
  });

  test("positions are weekly samples of the daily curve", () => {
    expect(sim.positions.length).toBe(Math.ceil(sim.curve.length / 7));
    expect(sim.positions[1]!.t - sim.positions[0]!.t).toBe(7 * DAY);
  });

  test("allowing shorts puts the falling coin short", () => {
    const withShorts = simulate(data, { ...settings, longOnly: false });
    expect(withShorts.positions.some((p) => (p.weights.ETH ?? 0) < 0)).toBe(true);
  });
});
