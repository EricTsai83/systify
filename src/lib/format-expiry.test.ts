import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { formatExpiry } from "@/lib/format-expiry";

describe("formatExpiry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("uses millisecond thresholds instead of rounding tiny durations up to days", () => {
    const now = Date.now();

    expect(formatExpiry(now + 1)).toBe("Expires in 1 second");
    expect(formatExpiry(now + 59_000)).toBe("Expires in 59 seconds");
    expect(formatExpiry(now + 60_000)).toBe("Expires in 1 minute");
    expect(formatExpiry(now + 60 * 60 * 1000)).toBe("Expires in 1 hour");
    expect(formatExpiry(now + 24 * 60 * 60 * 1000)).toBe("Expires in 1 day");
  });
});
