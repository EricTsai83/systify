import { describe, expect, test } from "vitest";
import { costUsdToCents, estimateCostUsd } from "./lib/openaiPricing";

describe("estimateCostUsd", () => {
  test("calculates cost for a priced model", () => {
    expect(estimateCostUsd("gpt-4o-mini", 1_000_000, 500_000)).toBeCloseTo(0.45);
  });

  test("returns undefined when pricing is unavailable", () => {
    expect(estimateCostUsd("unknown-model", 1_000, 2_000)).toBeUndefined();
  });

  test("returns undefined when usage is incomplete", () => {
    expect(estimateCostUsd("gpt-4o-mini", undefined, 2_000)).toBeUndefined();
    expect(estimateCostUsd("gpt-4o-mini", 1_000, undefined)).toBeUndefined();
  });

  // GPT-5 family pricing ensures the daily-cap accounting doesn't
  // silently drop model variants. The numbers should match the snapshot
  // in `lib/openaiPricing.ts`; the test exists to catch accidental
  // zeroing of either tier (e.g. a refactor that wipes the table to {}
  // would break here, not silently flow into "$0.00 cost" recordings on
  // every reply).
  test("calculates cost for the gpt-5 sandbox tier", () => {
    // 1M input @ $1.25 + 1M output @ $10 = $11.25
    expect(estimateCostUsd("gpt-5", 1_000_000, 1_000_000)).toBeCloseTo(11.25);
  });

  test("calculates cost for the gpt-5-mini docs/discuss tier", () => {
    // 1M input @ $0.25 + 1M output @ $2 = $2.25
    expect(estimateCostUsd("gpt-5-mini", 1_000_000, 1_000_000)).toBeCloseTo(2.25);
  });
});

describe("costUsdToCents", () => {
  test("ceiling-rounds positive costs so daily-cap settlement never under-charges", () => {
    // $0.001 → 1 cent (not 0). Without ceiling, ~100 sub-cent replies
    // could stack to a free dollar of sandbox spend per user.
    expect(costUsdToCents(0.001)).toBe(1);
    expect(costUsdToCents(0.04)).toBe(4);
    expect(costUsdToCents(0.045)).toBe(5);
    expect(costUsdToCents(0.05)).toBe(5);
    // Edge: exact-cent costs round to themselves, not 1 over.
    expect(costUsdToCents(1)).toBe(100);
  });

  test("returns undefined for undefined input so the settle helper can short-circuit", () => {
    expect(costUsdToCents(undefined)).toBeUndefined();
  });

  test("clamps negative / non-finite inputs to 0", () => {
    // Defensive: if a future provider returns a weird number, we don't
    // want to produce a negative `count` that the rate-limiter rejects.
    expect(costUsdToCents(-0.5)).toBe(0);
    expect(costUsdToCents(Number.NaN)).toBe(0);
    expect(costUsdToCents(Number.POSITIVE_INFINITY)).toBe(0);
  });

  test("zero cost converts to zero cents (not undefined) so the call site can distinguish heuristic from priced-zero", () => {
    expect(costUsdToCents(0)).toBe(0);
  });
});
