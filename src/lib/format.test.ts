import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { formatRelativeTime, formatTimeUntil } from "./format";

const FROZEN_NOW = new Date("2026-05-05T12:00:00Z").getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FROZEN_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("formatRelativeTime", () => {
  test("collapses sub-minute deltas to 'just now'", () => {
    expect(formatRelativeTime(FROZEN_NOW)).toBe("just now");
    expect(formatRelativeTime(FROZEN_NOW - 30_000)).toBe("just now");
    expect(formatRelativeTime(FROZEN_NOW - 59_000)).toBe("just now");
  });

  test("ladders through min / hour / day buckets", () => {
    expect(formatRelativeTime(FROZEN_NOW - 60_000)).toBe("1 min ago");
    expect(formatRelativeTime(FROZEN_NOW - 5 * 60_000)).toBe("5 min ago");
    expect(formatRelativeTime(FROZEN_NOW - 60 * 60_000)).toBe("1h ago");
    expect(formatRelativeTime(FROZEN_NOW - 24 * 60 * 60_000)).toBe("1d ago");
  });
});

describe("formatTimeUntil", () => {
  test("non-positive deltas collapse to 'soon'", () => {
    expect(formatTimeUntil(FROZEN_NOW)).toBe("soon");
    expect(formatTimeUntil(FROZEN_NOW - 1)).toBe("soon");
    expect(formatTimeUntil(FROZEN_NOW - 60_000)).toBe("soon");
  });

  test("sub-minute futures render as 'in <1 min'", () => {
    expect(formatTimeUntil(FROZEN_NOW + 1_000)).toBe("in <1 min");
    expect(formatTimeUntil(FROZEN_NOW + 59_000)).toBe("in <1 min");
  });

  test("ladders through min / hour / day buckets", () => {
    expect(formatTimeUntil(FROZEN_NOW + 60_000)).toBe("in 1 min");
    expect(formatTimeUntil(FROZEN_NOW + 23 * 60_000)).toBe("in 23 min");
    expect(formatTimeUntil(FROZEN_NOW + 60 * 60_000)).toBe("in 1h");
    expect(formatTimeUntil(FROZEN_NOW + 24 * 60 * 60_000)).toBe("in 1d");
  });
});
