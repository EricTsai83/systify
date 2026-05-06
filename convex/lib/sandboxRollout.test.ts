import { describe, expect, test } from "vitest";
import {
  bucketForTokenIdentifier,
  bucketIsInRollout,
  fnv1a32,
  isViewerInRollout,
  parseRolloutPercent,
} from "./sandboxRollout";

describe("fnv1a32", () => {
  test("is deterministic across calls", () => {
    // The whole rollout design rests on stability — pin it directly.
    expect(fnv1a32("user|alice")).toBe(fnv1a32("user|alice"));
    expect(fnv1a32("")).toBe(fnv1a32(""));
  });

  test("produces different hashes for different inputs (avalanche)", () => {
    // FNV-1a's avalanche property is enough to keep typo-adjacent inputs
    // in different buckets. We don't need cryptographic avalanche, just
    // "sequential identifiers don't all collapse into the same bucket".
    const hashes = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      hashes.add(fnv1a32(`user|tester-${i}`));
    }
    // 1000 distinct inputs should hash to roughly 1000 distinct values
    // (collisions in 32-bit space are rare). 990 is a wide tolerance
    // that still catches a "stuck-on-one-value" regression.
    expect(hashes.size).toBeGreaterThan(990);
  });

  test("returns an unsigned 32-bit integer", () => {
    // A regression here would mean future bucket arithmetic could
    // produce negative buckets or doubles — both would silently exclude
    // viewers from the rollout.
    for (const input of ["", "a", "user|alice", "0".repeat(64)]) {
      const hash = fnv1a32(input);
      expect(Number.isInteger(hash)).toBe(true);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThan(2 ** 32);
    }
  });

  test("matches the known FNV-1a 32-bit reference output for empty input", () => {
    // Standard FNV-1a "offset basis" for the empty string is the offset
    // basis itself (`0x811c9dc5`). Pinning the well-known reference
    // value protects against a subtle regression in the loop seed.
    expect(fnv1a32("")).toBe(0x811c9dc5);
  });
});

describe("bucketForTokenIdentifier", () => {
  test("always returns a bucket in [0, 100)", () => {
    for (let i = 0; i < 200; i++) {
      const bucket = bucketForTokenIdentifier(`user|stable-${i}`);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(100);
      expect(Number.isInteger(bucket)).toBe(true);
    }
  });

  test("is stable across calls for the same identifier", () => {
    // The single most important property of the rollout: a viewer's
    // bucket must not flap between calls, otherwise raising the rollout
    // percentage could *kick out* viewers who currently have access.
    const id = "user|alice";
    const first = bucketForTokenIdentifier(id);
    for (let i = 0; i < 100; i++) {
      expect(bucketForTokenIdentifier(id)).toBe(first);
    }
  });

  test("distributes ~uniformly across 100 buckets", () => {
    // Statistical-shape check: 10,000 synthetic identifiers should
    // populate every bucket and stay reasonably close to expected
    // (~100 per bucket). A wide tolerance (50–200) catches "everybody
    // ends up in bucket 0" / "half the buckets are empty" regressions
    // without becoming flaky on legitimate FNV-1a variance.
    const counts = new Array<number>(100).fill(0);
    for (let i = 0; i < 10_000; i++) {
      counts[bucketForTokenIdentifier(`user|sample-${i}`)] += 1;
    }
    for (const count of counts) {
      expect(count).toBeGreaterThan(50);
      expect(count).toBeLessThan(200);
    }
  });
});

describe("bucketIsInRollout", () => {
  test("admits buckets strictly less than the rollout percent", () => {
    // 10% rollout admits buckets 0..9 (10 buckets out of 100).
    expect(bucketIsInRollout(0, 10)).toBe(true);
    expect(bucketIsInRollout(9, 10)).toBe(true);
    expect(bucketIsInRollout(10, 10)).toBe(false);
    expect(bucketIsInRollout(99, 10)).toBe(false);
  });

  test("admits nobody when rollout percent is 0", () => {
    for (let bucket = 0; bucket < 100; bucket++) {
      expect(bucketIsInRollout(bucket, 0)).toBe(false);
    }
  });

  test("admits everybody when rollout percent is 100", () => {
    for (let bucket = 0; bucket < 100; bucket++) {
      expect(bucketIsInRollout(bucket, 100)).toBe(true);
    }
  });

  test("clamps out-of-range rollout percents (negative → 0, >100 → 100)", () => {
    // Operator typos must never widen the cohort beyond 100% and must
    // never wrap around into negative space.
    expect(bucketIsInRollout(50, -10)).toBe(false);
    expect(bucketIsInRollout(50, 200)).toBe(true);
    // Non-finite inputs are treated as "garbage, fail closed" — same
    // direction as `parseRolloutPercent` falling back to 0 on unparsable
    // values. We deliberately *don't* map `Infinity` to 100: the more
    // conservative interpretation of an invalid percent is "rollout off"
    // because rolling everyone out on a typo is much harder to revert
    // than rolling no one out.
    expect(bucketIsInRollout(50, Number.NaN)).toBe(false);
    expect(bucketIsInRollout(50, Number.POSITIVE_INFINITY)).toBe(false);
  });

  test("rejects malformed buckets (out of range, fractional, NaN)", () => {
    // A buggy hashing layer must not silently promote a viewer with a
    // garbage bucket value into the cohort. The rollout returns false
    // and the upstream gate then falls through to the "not in cohort"
    // branch.
    expect(bucketIsInRollout(-1, 50)).toBe(false);
    expect(bucketIsInRollout(100, 50)).toBe(false);
    expect(bucketIsInRollout(50.5, 100)).toBe(false);
    expect(bucketIsInRollout(Number.NaN, 100)).toBe(false);
  });

  test("rounds fractional percents to the nearest integer", () => {
    // A fractional percent like `33.5` is treated as 34 — a stable
    // integer cohort size. The alternative (float comparison) would
    // make `bucketIsInRollout(33, 33.5)` and similar inputs depend on
    // IEEE-754 rounding, which is exactly what we want to avoid.
    expect(bucketIsInRollout(33, 33.5)).toBe(true);
    expect(bucketIsInRollout(34, 33.5)).toBe(false);
  });
});

describe("isViewerInRollout (composition)", () => {
  test("expanding the rollout never kicks out viewers (monotone)", () => {
    // The most important rollout property: ramping from 10% to 50%
    // must strictly *expand* the cohort. Anyone admitted at 10% is
    // still admitted at 50%, and so on up to 100%.
    const viewers = Array.from({ length: 200 }, (_, i) => `user|monotone-${i}`);
    let priorCohort = new Set<string>();
    for (const percent of [0, 10, 25, 50, 75, 100]) {
      const cohort = new Set(viewers.filter((v) => isViewerInRollout(v, percent)));
      for (const member of priorCohort) {
        expect(cohort.has(member)).toBe(true);
      }
      priorCohort = cohort;
    }
  });

  test("a 50% rollout admits roughly half of synthetic viewers", () => {
    // Wide tolerance (40–60%) catches "the gate is broken / nobody
    // gets in / everybody gets in" regressions while staying well
    // away from FNV-1a's natural variance for synthetic inputs.
    const sampleSize = 5_000;
    let admitted = 0;
    for (let i = 0; i < sampleSize; i++) {
      if (isViewerInRollout(`user|halfway-${i}`, 50)) {
        admitted += 1;
      }
    }
    const ratio = admitted / sampleSize;
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(0.6);
  });
});

describe("parseRolloutPercent", () => {
  test.each([undefined, "", "  ", "abc", "1e", "NaN", "Infinity", "-0.5", "-100"])(
    "treats %j as 0 (rollout off / invalid)",
    (rawValue) => {
      // Anything we can't parse to a finite, non-negative value falls
      // to 0. This is symmetric with `bucketIsInRollout`'s fail-closed
      // behavior on non-finite percents — operator typos must never
      // silently roll everyone out.
      expect(parseRolloutPercent(rawValue)).toBe(0);
    },
  );

  test("parses canonical integer values", () => {
    expect(parseRolloutPercent("0")).toBe(0);
    expect(parseRolloutPercent("10")).toBe(10);
    expect(parseRolloutPercent("100")).toBe(100);
  });

  test("clamps above 100 / below 0", () => {
    expect(parseRolloutPercent("150")).toBe(100);
  });

  test("trims surrounding whitespace", () => {
    // Operators commonly paste env values from spreadsheets; we accept
    // the resulting whitespace just like the allowlist parser does.
    expect(parseRolloutPercent("  25  ")).toBe(25);
  });

  test("rounds fractional percents to the nearest integer", () => {
    expect(parseRolloutPercent("33.4")).toBe(33);
    expect(parseRolloutPercent("33.5")).toBe(34);
  });
});
