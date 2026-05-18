import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  DaytonaAuthenticationError,
  DaytonaAuthorizationError,
  DaytonaConflictError,
  DaytonaError,
  DaytonaNotFoundError,
  DaytonaRateLimitError,
  DaytonaTimeoutError,
  DaytonaValidationError,
} from "@daytona/sdk";

import { isRetriable, TEST_INTERNALS, withDaytonaRetry } from "./daytonaRetry";

/**
 * Construct a `DaytonaRateLimitError` with the headers object the helper
 * actually looks at. The real SDK populates `error.headers` with an
 * AxiosHeaders instance whose `.get(name)` is case-insensitive; our mock
 * mirrors only that surface so we don't have to depend on AxiosHeaders
 * internals in tests.
 */
function makeRateLimitError(headers?: Record<string, string>): DaytonaRateLimitError {
  const lookup = headers
    ? {
        get: (name: string) => headers[name.toLowerCase()] ?? headers[name] ?? null,
      }
    : undefined;
  return new DaytonaRateLimitError("rate limited", 429, lookup as never, "rate_limited");
}

function makeServerError(status: number): DaytonaError {
  return new DaytonaError(`server error ${status}`, status, undefined, "server_error");
}

function makeNetworkError(code: string): Error {
  const err = new Error(`network error: ${code}`);
  (err as Error & { code: string }).code = code;
  return err;
}

describe("isRetriable", () => {
  test("rate-limit error is retriable", () => {
    expect(isRetriable(makeRateLimitError())).toBe(true);
  });

  test("DaytonaError with 5xx status is retriable", () => {
    expect(isRetriable(makeServerError(500))).toBe(true);
    expect(isRetriable(makeServerError(502))).toBe(true);
    expect(isRetriable(makeServerError(599))).toBe(true);
  });

  test("DaytonaError with 4xx status is NOT retriable", () => {
    // Each maps to a dedicated subclass — covering them by class also pins the
    // contract that 4xx never retries regardless of which subclass the SDK chose.
    expect(isRetriable(new DaytonaValidationError("bad request", 400))).toBe(false);
    expect(isRetriable(new DaytonaAuthenticationError("unauthenticated", 401))).toBe(false);
    expect(isRetriable(new DaytonaAuthorizationError("forbidden", 403))).toBe(false);
    expect(isRetriable(new DaytonaNotFoundError("missing", 404))).toBe(false);
    expect(isRetriable(new DaytonaConflictError("conflict", 409))).toBe(false);
  });

  test("DaytonaTimeoutError is NOT retriable by this helper", () => {
    // Timeouts at the SDK level are caller-decidable. Tool-call adapters
    // already translate them into structured envelopes; we don't want to
    // smear that semantic by transparently retrying.
    expect(isRetriable(new DaytonaTimeoutError("timed out", undefined))).toBe(false);
  });

  test.each(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "EPIPE"])(
    "network error %s is retriable",
    (code) => {
      expect(isRetriable(makeNetworkError(code))).toBe(true);
    },
  );

  test("ENOTFOUND (likely-misconfigured) is NOT retriable", () => {
    expect(isRetriable(makeNetworkError("ENOTFOUND"))).toBe(false);
  });

  test("unknown plain Error is NOT retriable", () => {
    expect(isRetriable(new Error("something else"))).toBe(false);
  });

  test.each([null, undefined, "string error", 42, true, {}])("non-Error value %p is NOT retriable", (value) => {
    expect(isRetriable(value)).toBe(false);
  });
});

describe("withDaytonaRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("returns on first success without sleeping", async () => {
    const op = vi.fn().mockResolvedValue("ok");
    const result = await withDaytonaRetry(op, { operation: "test.success" });
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
  });

  test("retries on rate-limit and eventually returns success", async () => {
    // 0.5 → jitter = 0 so the test asserts on exact backoff timings.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const op = vi
      .fn()
      .mockRejectedValueOnce(makeRateLimitError())
      .mockRejectedValueOnce(makeRateLimitError())
      .mockResolvedValue("ok");
    const promise = withDaytonaRetry(op, { operation: "test.retry" });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");
    expect(op).toHaveBeenCalledTimes(3);
  });

  test("retry-after-sandbox-create header overrides exponential backoff", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    // Server hint = 7s; first-attempt backoff would be ~1s, so the header must win.
    const op = vi
      .fn()
      .mockRejectedValueOnce(makeRateLimitError({ "retry-after-sandbox-create": "7" }))
      .mockResolvedValue("ok");
    const promise = withDaytonaRetry(op, { operation: "test.header" });

    await vi.advanceTimersByTimeAsync(6_999);
    expect(op).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe("ok");
    expect(op).toHaveBeenCalledTimes(2);
  });

  test("generic retry-after header is also honored", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const op = vi
      .fn()
      .mockRejectedValueOnce(makeRateLimitError({ "retry-after": "3" }))
      .mockResolvedValue("ok");
    const promise = withDaytonaRetry(op, { operation: "test.header_generic" });

    await vi.advanceTimersByTimeAsync(2_999);
    expect(op).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe("ok");
  });

  test("server hint above MAX_DELAY_MS is capped", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    // Server tells us to wait 5 minutes; we must cap at MAX_DELAY_MS.
    const op = vi
      .fn()
      .mockRejectedValueOnce(makeRateLimitError({ "retry-after": "300" }))
      .mockResolvedValue("ok");
    const promise = withDaytonaRetry(op, { operation: "test.cap" });

    await vi.advanceTimersByTimeAsync(TEST_INTERNALS.MAX_DELAY_MS - 1);
    expect(op).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe("ok");
  });

  test("falls back to exponential backoff when no header present", async () => {
    // 0.5 → jitter term = 0, so the helper sleeps for exactly BASE_DELAY_MS,
    // then 2 * BASE_DELAY_MS on the next attempt. Pinning random eliminates
    // the otherwise-±20% timing flake.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const op = vi
      .fn()
      .mockRejectedValueOnce(makeRateLimitError())
      .mockRejectedValueOnce(makeRateLimitError())
      .mockResolvedValue("ok");
    const promise = withDaytonaRetry(op, { operation: "test.backoff" });

    // 1st retry: BASE_DELAY_MS
    await vi.advanceTimersByTimeAsync(TEST_INTERNALS.BASE_DELAY_MS - 1);
    expect(op).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(op).toHaveBeenCalledTimes(2);

    // 2nd retry: 2 * BASE_DELAY_MS
    await vi.advanceTimersByTimeAsync(2 * TEST_INTERNALS.BASE_DELAY_MS - 1);
    expect(op).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe("ok");
    expect(op).toHaveBeenCalledTimes(3);
  });

  test("fast-fails on non-retriable error without sleeping", async () => {
    const validation = new DaytonaValidationError("bad input", 400);
    const op = vi.fn().mockRejectedValue(validation);
    await expect(withDaytonaRetry(op, { operation: "test.nonretriable" })).rejects.toBe(validation);
    expect(op).toHaveBeenCalledTimes(1);
  });

  test("re-throws the original error after MAX_RETRIES retriable failures", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const finalError = makeRateLimitError();
    const op = vi.fn().mockRejectedValue(finalError);
    const promise = withDaytonaRetry(op, { operation: "test.exhaust" });
    const rejection = expect(promise).rejects.toBe(finalError);
    await vi.runAllTimersAsync();
    await rejection;
    expect(op).toHaveBeenCalledTimes(TEST_INTERNALS.MAX_RETRIES);
  });

  test("retries on 5xx and succeeds", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const op = vi.fn().mockRejectedValueOnce(makeServerError(503)).mockResolvedValue("ok");
    const promise = withDaytonaRetry(op, { operation: "test.5xx" });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");
    expect(op).toHaveBeenCalledTimes(2);
  });

  test("retries on network ECONNRESET and succeeds", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const op = vi.fn().mockRejectedValueOnce(makeNetworkError("ECONNRESET")).mockResolvedValue("ok");
    const promise = withDaytonaRetry(op, { operation: "test.network" });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");
    expect(op).toHaveBeenCalledTimes(2);
  });

  test("jitter shrinks delay toward the lower bound when random ~ 0", async () => {
    // jitter = (0*2 - 1) * 0.2 * 1000 = -200 → delay = 800
    vi.spyOn(Math, "random").mockReturnValue(0);
    const op = vi.fn().mockRejectedValueOnce(makeRateLimitError()).mockResolvedValue("ok");
    const promise = withDaytonaRetry(op, { operation: "test.jitter_low" });

    const lowerBound = Math.round(TEST_INTERNALS.BASE_DELAY_MS * (1 - TEST_INTERNALS.JITTER_RATIO));
    await vi.advanceTimersByTimeAsync(lowerBound - 1);
    expect(op).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe("ok");
  });

  test("jitter pushes delay toward the upper bound when random ~ 1", async () => {
    // 0.9999 → jitter ≈ +200 → delay ≈ 1200
    vi.spyOn(Math, "random").mockReturnValue(0.9999);
    const op = vi.fn().mockRejectedValueOnce(makeRateLimitError()).mockResolvedValue("ok");
    const promise = withDaytonaRetry(op, { operation: "test.jitter_high" });

    const upperBound = Math.round(
      TEST_INTERNALS.BASE_DELAY_MS + (0.9999 * 2 - 1) * TEST_INTERNALS.JITTER_RATIO * TEST_INTERNALS.BASE_DELAY_MS,
    );
    await vi.advanceTimersByTimeAsync(upperBound - 1);
    expect(op).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe("ok");
  });

  test("invalid retry-after header value falls back to backoff", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    // Non-numeric — should be ignored, falling back to BASE_DELAY_MS.
    const op = vi
      .fn()
      .mockRejectedValueOnce(makeRateLimitError({ "retry-after": "not-a-number" }))
      .mockResolvedValue("ok");
    const promise = withDaytonaRetry(op, { operation: "test.bad_header" });

    await vi.advanceTimersByTimeAsync(TEST_INTERNALS.BASE_DELAY_MS - 1);
    expect(op).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe("ok");
  });

  test("zero-second retry-after is ignored (falls back to backoff)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const op = vi
      .fn()
      .mockRejectedValueOnce(makeRateLimitError({ "retry-after": "0" }))
      .mockResolvedValue("ok");
    const promise = withDaytonaRetry(op, { operation: "test.zero_header" });

    await vi.advanceTimersByTimeAsync(TEST_INTERNALS.BASE_DELAY_MS - 1);
    expect(op).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe("ok");
  });
});
