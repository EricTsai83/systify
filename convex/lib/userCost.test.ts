import { describe, expect, it } from "vitest";
import { TEST_INTERNALS } from "./userCost";

const { makeBucket, addToBucket, utcDayKey } = TEST_INTERNALS;

describe("userCost.makeBucket", () => {
  it("seeds zero values across every field", () => {
    const bucket = makeBucket();
    expect(bucket).toEqual({
      usd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      count: 0,
    });
  });
});

describe("userCost.addToBucket", () => {
  it("sums non-zero token + cost fields and bumps count", () => {
    const bucket = makeBucket();
    addToBucket(bucket, { usd: 0.0125, inputTokens: 1000, outputTokens: 500 });
    addToBucket(bucket, { usd: 0.0075, inputTokens: 200, outputTokens: 100, cachedInputTokens: 50 });
    expect(bucket.count).toBe(2);
    expect(bucket.usd).toBeCloseTo(0.02, 5);
    expect(bucket.inputTokens).toBe(1200);
    expect(bucket.outputTokens).toBe(600);
    expect(bucket.cachedInputTokens).toBe(50);
  });

  it("ignores undefined / non-positive USD but still bumps count", () => {
    const bucket = makeBucket();
    addToBucket(bucket, { inputTokens: 100 });
    addToBucket(bucket, { usd: 0, inputTokens: 50 });
    addToBucket(bucket, { usd: -1, inputTokens: 25 });
    expect(bucket.count).toBe(3);
    expect(bucket.usd).toBe(0);
    expect(bucket.inputTokens).toBe(175);
  });

  it("treats undefined token fields as zero contribution", () => {
    const bucket = makeBucket();
    addToBucket(bucket, { usd: 1, inputTokens: undefined, outputTokens: undefined });
    expect(bucket.inputTokens).toBe(0);
    expect(bucket.outputTokens).toBe(0);
    expect(bucket.count).toBe(1);
  });
});

describe("userCost.utcDayKey", () => {
  it("produces YYYY-MM-DD aligned to UTC midnight", () => {
    expect(utcDayKey(Date.UTC(2026, 4, 31, 12, 30, 0))).toBe("2026-05-31");
    expect(utcDayKey(Date.UTC(2026, 0, 1, 0, 0, 0))).toBe("2026-01-01");
  });

  it("zero-pads month and day", () => {
    expect(utcDayKey(Date.UTC(2026, 2, 5, 12, 0, 0))).toBe("2026-03-05");
  });

  it("rolls to the next day at UTC midnight", () => {
    const justBeforeMidnight = Date.UTC(2026, 5, 1, 23, 59, 59, 999);
    const atMidnight = Date.UTC(2026, 5, 2, 0, 0, 0, 0);
    expect(utcDayKey(justBeforeMidnight)).toBe("2026-06-01");
    expect(utcDayKey(atMidnight)).toBe("2026-06-02");
  });
});
