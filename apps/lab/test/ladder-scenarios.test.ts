import { describe, expect, test } from "vitest";
import { ASK, BID, SCENARIOS } from "../lib/ladder-scenarios";

describe("execution ladder scenarios", () => {
  test.each(SCENARIOS.map((s) => [s.key, s] as const))("%s: fills only grow and the last frame has the outcome", (_key, s) => {
    for (let i = 1; i < s.frames.length; i++) {
      expect(s.frames[i]!.filled).toBeGreaterThanOrEqual(s.frames[i - 1]!.filled);
    }
    expect(s.frames.at(-1)!.outcome).toBeDefined();
    expect(s.frames.slice(0, -1).every((f) => f.outcome === undefined)).toBe(true);
  });

  test("post-only orders rest between the bid and the ask, never crossing", () => {
    const resting = SCENARIOS.flatMap((s) => s.frames.map((f) => f.order)).filter((p): p is number => p !== null);
    expect(resting.length).toBeGreaterThan(0);
    for (const p of resting) {
      expect(p).toBeGreaterThanOrEqual(BID);
      expect(p).toBeLessThan(ASK);
    }
  });

  test("the taker fallback prices past the ask and never overfills", () => {
    const partial = SCENARIOS.find((s) => s.key === "partial")!;
    const taker = partial.frames.find((f) => f.taker !== undefined)!;
    expect(taker.taker).toBeGreaterThan(ASK);
    expect(partial.frames.at(-1)).toMatchObject({ filled: 1, outcome: "done" });
  });

  test("a rejected close ends as failed with nothing filled", () => {
    const rejected = SCENARIOS.find((s) => s.key === "rejected")!;
    expect(rejected.frames.at(-1)).toMatchObject({ filled: 0, outcome: "failed" });
  });
});
