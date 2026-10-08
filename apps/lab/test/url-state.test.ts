import { describe, expect, test } from "vitest";
import { DEFAULT_SETTINGS, toParams } from "../lib/lab";
import { parseSettings, serializeSettings } from "../lib/url-state";

describe("URL state", () => {
  test("defaults serialize to an empty query and parse back", () => {
    expect(serializeSettings(DEFAULT_SETTINGS)).toBe("");
    expect(parseSettings("")).toEqual(DEFAULT_SETTINGS);
  });

  test("a shared link round-trips every setting", () => {
    const s = { ...DEFAULT_SETTINGS, horizon: 1.5, volTarget: 0.4, grossCap: 2, band: 0.1, longOnly: false, coins: ["BTC", "ETH"], startYear: 2023 };
    const qs = serializeSettings(s);
    expect(qs).toBe("h=1.5&vol=0.4&cap=2&band=0.1&shorts=1&coins=BTC%2CETH&from=2023");
    expect(parseSettings(`?${qs}`)).toEqual(s);
  });

  test("garbage falls back to defaults instead of breaking the page", () => {
    const s = parseSettings("?h=abc&vol=&coins=FOO,BAR&shorts=yes");
    expect(s.horizon).toBe(DEFAULT_SETTINGS.horizon);
    expect(s.volTarget).toBe(DEFAULT_SETTINGS.volTarget);
    expect(s.coins).toEqual(DEFAULT_SETTINGS.coins);
    expect(s.longOnly).toBe(true);
  });

  test("unknown coins are dropped, duplicates collapsed", () => {
    expect(parseSettings("?coins=ETH,FOO,ETH,SOL").coins).toEqual(["ETH", "SOL"]);
  });
});

describe("toParams", () => {
  test("the horizon multiplier scales every lookback, never below 2 days", () => {
    expect(toParams(DEFAULT_SETTINGS).lookbacks).toEqual([14, 28, 56, 112]);
    expect(toParams({ ...DEFAULT_SETTINGS, horizon: 0.5 }).lookbacks).toEqual([7, 14, 28, 56]);
    expect(toParams({ ...DEFAULT_SETTINGS, horizon: 0.1 }).lookbacks[0]).toBe(2);
  });
});
