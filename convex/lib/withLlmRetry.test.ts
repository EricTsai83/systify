import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { APICallError } from "ai";

import { isRetriable, TEST_INTERNALS, withLlmRetry } from "./withLlmRetry";

/**
 * Build an `APICallError` that the retry helper sees on a real
 * provider 4xx/5xx. The AI SDK constructor wants a fairly large
 * options bag — we fill the essential bits and leave the rest
 * default. `responseHeaders` is honored by `extractRetryAfterMs`.
 */
function makeApiCallError(opts: {
  statusCode?: number;
  responseHeaders?: Record<string, string>;
  cause?: unknown;
  isRetryable?: boolean;
}): APICallError {
  return new APICallError({
    message: `provider error ${opts.statusCode ?? "unknown"}`,
    url: "https://example.com/v1/chat",
    requestBodyValues: {},
    statusCode: opts.statusCode,
    responseHeaders: opts.responseHeaders,
    cause: opts.cause,
    isRetryable: opts.isRetryable,
  });
}

function makeNetworkError(code: string): Error {
  const err = new Error(`network error: ${code}`);
  (err as Error & { code: string }).code = code;
  return err;
}

describe("isRetriable", () => {
  test.each(["openai", "anthropic"] as const)("provider %s: 429 is retriable", (provider) => {
    expect(isRetriable(makeApiCallError({ statusCode: 429 }), provider)).toBe(true);
  });

  test.each(["openai", "anthropic"] as const)("provider %s: 5xx is retriable", (provider) => {
    expect(isRetriable(makeApiCallError({ statusCode: 500 }), provider)).toBe(true);
    expect(isRetriable(makeApiCallError({ statusCode: 502 }), provider)).toBe(true);
    expect(isRetriable(makeApiCallError({ statusCode: 599 }), provider)).toBe(true);
  });

  test.each(["openai", "anthropic"] as const)("provider %s: 4xx (non-429) fails fast", (provider) => {
    expect(isRetriable(makeApiCallError({ statusCode: 400 }), provider)).toBe(false);
    expect(isRetriable(makeApiCallError({ statusCode: 401 }), provider)).toBe(false);
    expect(isRetriable(makeApiCallError({ statusCode: 403 }), provider)).toBe(false);
    expect(isRetriable(makeApiCallError({ statusCode: 404 }), provider)).toBe(false);
    expect(isRetriable(makeApiCallError({ statusCode: 422 }), provider)).toBe(false);
  });

  test.each(["openai", "anthropic"] as const)(
    "provider %s: transport-layer fault (no statusCode) is retriable",
    (provider) => {
      expect(isRetriable(makeApiCallError({ statusCode: undefined }), provider)).toBe(true);
    },
  );

  test.each(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "EPIPE"])(
    "network error %s is retriable for both providers",
    (code) => {
      expect(isRetriable(makeNetworkError(code), "openai")).toBe(true);
      expect(isRetriable(makeNetworkError(code), "anthropic")).toBe(true);
    },
  );

  test("ENOTFOUND (likely misconfigured) is NOT retriable", () => {
    expect(isRetriable(makeNetworkError("ENOTFOUND"), "openai")).toBe(false);
    expect(isRetriable(makeNetworkError("ENOTFOUND"), "anthropic")).toBe(false);
  });

  test("unknown plain Error is NOT retriable", () => {
    expect(isRetriable(new Error("something else"), "openai")).toBe(false);
  });
});

describe("withLlmRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("returns on first success without sleeping", async () => {
    const op = vi.fn().mockResolvedValue("ok");
    const result = await withLlmRetry(op, { operation: "test.ok", provider: "openai", modelName: "gpt-5" });
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
  });

  test("retries on 429 with backoff and eventually returns success", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const op = vi
      .fn()
      .mockRejectedValueOnce(makeApiCallError({ statusCode: 429 }))
      .mockRejectedValueOnce(makeApiCallError({ statusCode: 429 }))
      .mockResolvedValue("ok");
    const promise = withLlmRetry(op, { operation: "test.retry", provider: "openai", modelName: "gpt-5" });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");
    expect(op).toHaveBeenCalledTimes(3);
  });

  test("retry-after header overrides exponential backoff", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const op = vi
      .fn()
      .mockRejectedValueOnce(makeApiCallError({ statusCode: 429, responseHeaders: { "retry-after": "7" } }))
      .mockResolvedValue("ok");
    const promise = withLlmRetry(op, { operation: "test.header", provider: "anthropic", modelName: "claude-opus-4-8" });

    await vi.advanceTimersByTimeAsync(6_999);
    expect(op).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe("ok");
    expect(op).toHaveBeenCalledTimes(2);
  });

  test("server hint above MAX_DELAY_MS is capped", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const op = vi
      .fn()
      .mockRejectedValueOnce(makeApiCallError({ statusCode: 429, responseHeaders: { "retry-after": "300" } }))
      .mockResolvedValue("ok");
    const promise = withLlmRetry(op, { operation: "test.cap", provider: "openai", modelName: "gpt-5" });

    await vi.advanceTimersByTimeAsync(TEST_INTERNALS.MAX_DELAY_MS - 1);
    expect(op).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe("ok");
  });

  test("fast-fails on non-retriable 4xx without sleeping", async () => {
    const badRequest = makeApiCallError({ statusCode: 400 });
    const op = vi.fn().mockRejectedValue(badRequest);
    await expect(withLlmRetry(op, { operation: "test.4xx", provider: "openai", modelName: "gpt-5" })).rejects.toBe(
      badRequest,
    );
    expect(op).toHaveBeenCalledTimes(1);
  });

  test("re-throws original error after MAX_RETRIES exhaustion", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const finalError = makeApiCallError({ statusCode: 429 });
    const op = vi.fn().mockRejectedValue(finalError);
    const promise = withLlmRetry(op, {
      operation: "test.exhaust",
      provider: "anthropic",
      modelName: "claude-opus-4-8",
    });
    const rejection = expect(promise).rejects.toBe(finalError);
    await vi.runAllTimersAsync();
    await rejection;
    expect(op).toHaveBeenCalledTimes(TEST_INTERNALS.MAX_RETRIES);
  });

  test("retries on 5xx and succeeds", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const op = vi
      .fn()
      .mockRejectedValueOnce(makeApiCallError({ statusCode: 503 }))
      .mockResolvedValue("ok");
    const promise = withLlmRetry(op, { operation: "test.5xx", provider: "openai", modelName: "gpt-5" });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");
    expect(op).toHaveBeenCalledTimes(2);
  });

  test("retries on network ECONNRESET and succeeds", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const op = vi.fn().mockRejectedValueOnce(makeNetworkError("ECONNRESET")).mockResolvedValue("ok");
    const promise = withLlmRetry(op, {
      operation: "test.network",
      provider: "anthropic",
      modelName: "claude-opus-4-8",
    });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");
    expect(op).toHaveBeenCalledTimes(2);
  });
});
