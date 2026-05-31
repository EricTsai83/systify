import { describe, expect, test } from "vitest";
import { TEST_INTERNALS } from "./report";

const { makeBucket, addRun, finalizeBucket } = TEST_INTERNALS;

describe("report bucket arithmetic", () => {
  test("makeBucket starts at zero everywhere", () => {
    const bucket = makeBucket();
    expect(bucket).toMatchObject({
      totalRuns: 0,
      succeededRuns: 0,
      failedRuns: 0,
      cachedHitRuns: 0,
      qualityRejectedRuns: 0,
      meanSteps: 0,
      totalSteps: 0,
      totalCostUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCachedInputTokens: 0,
      totalCacheWriteTokens: 0,
      totalReasoningTokens: 0,
      totalDurationMs: 0,
    });
  });

  test("addRun sums tokens / cost / steps / duration and counts by status", () => {
    const bucket = makeBucket();
    addRun(bucket, {
      status: "succeeded",
      actualSteps: 4,
      totalCostUsd: 0.12,
      inputTokens: 1_000,
      outputTokens: 500,
      cachedInputTokens: 200,
      cacheWriteTokens: 0,
      reasoningTokens: 100,
      durationMs: 12_345,
    });
    addRun(bucket, {
      status: "failed",
      actualSteps: 2,
      totalCostUsd: 0.04,
      inputTokens: 300,
      outputTokens: 50,
      durationMs: 5_000,
    });
    addRun(bucket, {
      status: "cached_hit",
      actualSteps: 0,
      durationMs: 0,
    });

    expect(bucket.totalRuns).toBe(3);
    expect(bucket.succeededRuns).toBe(1);
    expect(bucket.failedRuns).toBe(1);
    expect(bucket.cachedHitRuns).toBe(1);
    expect(bucket.qualityRejectedRuns).toBe(0);
    expect(bucket.totalSteps).toBe(6);
    expect(bucket.totalCostUsd).toBeCloseTo(0.16, 5);
    expect(bucket.totalInputTokens).toBe(1_300);
    expect(bucket.totalOutputTokens).toBe(550);
    expect(bucket.totalCachedInputTokens).toBe(200);
    expect(bucket.totalReasoningTokens).toBe(100);
    expect(bucket.totalDurationMs).toBe(17_345);
  });

  test("addRun skips non-finite / negative cost without exploding the bucket", () => {
    const bucket = makeBucket();
    addRun(bucket, {
      status: "succeeded",
      actualSteps: 1,
      totalCostUsd: Number.NaN,
      durationMs: 100,
    });
    addRun(bucket, {
      status: "succeeded",
      actualSteps: 1,
      totalCostUsd: -1,
      durationMs: 100,
    });
    expect(bucket.totalCostUsd).toBe(0);
    expect(bucket.totalRuns).toBe(2);
  });

  test("finalizeBucket computes meanSteps and stays zero on empty buckets", () => {
    const empty = makeBucket();
    finalizeBucket(empty);
    expect(empty.meanSteps).toBe(0);

    const full = makeBucket();
    addRun(full, { status: "succeeded", actualSteps: 3, durationMs: 100 });
    addRun(full, { status: "succeeded", actualSteps: 5, durationMs: 100 });
    finalizeBucket(full);
    expect(full.meanSteps).toBe(4);
  });
});
