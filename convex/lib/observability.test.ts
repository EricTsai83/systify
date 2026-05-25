import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { METRIC_SCOPE, emitMetric, logErrorWithId } from "./observability";

/**
 * Plan 13 — emitMetric contract tests.
 *
 * The function is purely a structured wrapper around `console.log`,
 * so the tests assert the *shape* of what landed on the console. A
 * downstream telemetry pipeline subscribing to `[metrics]` log lines
 * depends on this shape — every regression here would silently
 * corrupt dashboards.
 */
describe("emitMetric", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Quietly capture the structured payloads. We intentionally do
    // *not* let them bleed into the test runner output (no `mockReturnValue`
    // override) — the calls are what we're asserting on, the lines
    // themselves are noise.
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  test("writes a `[metrics]` prefix on the console line", () => {
    // The prefix is the cheap grep target the runbook leans on. If
    // the scope drifts ("[metric]", "[telemetry]"), every recipe
    // breaks — pin it.
    emitMetric("sandbox_session_finished", { value: 1234, tags: { mode: "discuss" } });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const [prefix] = logSpy.mock.calls[0];
    expect(prefix).toBe(`[${METRIC_SCOPE}] sandbox_session_finished`);
  });

  test("payload includes `metric`, `value`, and tags inside `tags: {...}`", () => {
    // Three contracts at once: the metric name is duplicated inside
    // the body (so a JSON pipeline that ignores the prefix still
    // identifies the metric); `value` is at the top level; tags are
    // nested under `tags`.
    emitMetric("sandbox_tool_invoked", {
      value: 42,
      tags: { tool: "read_file", ok: true },
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const [, payload] = logSpy.mock.calls[0];
    expect(payload).toMatchObject({
      metric: "sandbox_tool_invoked",
      value: 42,
      tags: { tool: "read_file", ok: true },
    });
  });

  test("omits `value` when not provided", () => {
    // A pure counter (`incremented by 1, no associated number`) must
    // not show up with a stale `value: undefined` in the body.
    // Time-series backends that treat `value` as the numeric measure
    // would otherwise log "0" for every counter increment.
    emitMetric("sandbox_session_failed", { tags: { reason: "tool_error" } });
    const [, payload] = logSpy.mock.calls[0];
    expect(payload).not.toHaveProperty("value");
    expect(payload).toMatchObject({ metric: "sandbox_session_failed" });
  });

  test("drops `undefined` tags so dashboards see deterministic keys", () => {
    // Optional tags should disappear entirely when undefined, not
    // surface as `key: undefined`. Downstream backends that filter on
    // `tags.error_code !== null` would otherwise miss the "no error"
    // case.
    emitMetric("sandbox_tool_invoked", {
      tags: { tool: "list_dir", ok: true, error_code: undefined },
    });
    const [, payload] = logSpy.mock.calls[0];
    expect(payload).toMatchObject({
      tags: { tool: "list_dir", ok: true },
    });
    expect((payload as { tags: Record<string, unknown> }).tags).not.toHaveProperty("error_code");
  });

  test("nests `details` under a `details: {...}` key alongside the envelope", () => {
    // High-cardinality forensic fields ride inside `details: {...}`
    // (separate from `tags`) so they don't drive dashboard cardinality
    // but stay grep-discoverable. Nesting also isolates them from
    // envelope keys (`metric`, `value`, `tags`) — a caller-supplied
    // `details.metric` can never overwrite the envelope's metric name.
    emitMetric("sandbox_session_finished", {
      tags: { mode: "discuss" },
      details: { jobId: "j_xyz", model: "gpt-5" },
    });
    const [, payload] = logSpy.mock.calls[0];
    expect(payload).toMatchObject({
      metric: "sandbox_session_finished",
      tags: { mode: "discuss" },
      details: { jobId: "j_xyz", model: "gpt-5" },
    });
  });

  test("omits `details` when not provided", () => {
    // Symmetric to the `value` omission: a metric with no forensic
    // payload should not surface a stale `details: {}` in the body,
    // so JSON pipelines that test on `details` presence stay
    // deterministic.
    emitMetric("sandbox_session_finished", { tags: { mode: "discuss" } });
    const [, payload] = logSpy.mock.calls[0];
    expect(payload).not.toHaveProperty("details");
  });

  test("never throws — falls back to a minimal payload on serializer crash", () => {
    // Defense-in-depth: a buggy upstream that hands us an object with
    // a getter that throws must not tear down the surrounding chat
    // reply. The fallback writes a minimal envelope so the metric
    // is at least *recorded*, even if the tags are lost.
    const exploding = {
      get oops() {
        throw new Error("intentional");
      },
    };
    expect(() => {
      emitMetric("sandbox_session_finished", {
        tags: { mode: "discuss" },
        details: { exploding } as never,
      });
    }).not.toThrow();
    expect(logSpy).toHaveBeenCalledTimes(1);
  });
});

/**
 * `serializeError` contract — exercised via `logErrorWithId` which is
 * the public surface that uses it. Two reasons to test through the
 * public API rather than exporting the helper:
 *
 *   1. The shape we care about is *what lands in the log*, not the
 *      intermediate value. Pinning the helper directly would let a
 *      future refactor that bypasses it slip through.
 *   2. `logErrorWithId` is what every node-runtime module already
 *      reaches for; the integration is the contract.
 *
 * The extensions tested here exist so Daytona SDK errors (which carry
 * `statusCode` / `errorCode` as own properties) and wrapped errors
 * (`new Error(msg, { cause: ... })`) produce structured log records
 * — turning a generic "Request failed with status code 400" into a
 * queryable `statusCode: 400` plus the wrapped cause's fields.
 */
describe("logErrorWithId — structured error serialization", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  function getLoggedErrorPayload(): Record<string, unknown> {
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [, payload] = errorSpy.mock.calls[0];
    return (payload as { error: Record<string, unknown> }).error;
  }

  test("surfaces `statusCode` (number) as a top-level structured field", () => {
    // Daytona SDK errors carry `statusCode` as an own property. Lifting it
    // out of the freeform message lets ops query "all Daytona 4xx clones
    // in the last hour" without regex-parsing.
    class DaytonaLikeError extends Error {
      readonly statusCode = 400;
      constructor(message: string) {
        super(message);
        this.name = "DaytonaValidationError";
      }
    }
    logErrorWithId("import", "clone_failed", new DaytonaLikeError("Request failed"));
    expect(getLoggedErrorPayload()).toMatchObject({
      name: "DaytonaValidationError",
      message: "Request failed",
      statusCode: 400,
    });
  });

  test("surfaces `errorCode` (string) when present", () => {
    class DaytonaLikeError extends Error {
      readonly statusCode = 400;
      readonly errorCode = "GIT_CLONE_FAILED";
      constructor(message: string) {
        super(message);
        this.name = "DaytonaValidationError";
      }
    }
    logErrorWithId("import", "clone_failed", new DaytonaLikeError("Request failed"));
    expect(getLoggedErrorPayload()).toMatchObject({
      statusCode: 400,
      errorCode: "GIT_CLONE_FAILED",
    });
  });

  test("ignores `statusCode` / `errorCode` of the wrong shape (defensive duck-typing)", () => {
    // A library that happens to set `statusCode` to a string ("404") or
    // `errorCode` to a number must not pollute the log record's shape —
    // dashboards that key on `statusCode: number` would otherwise break
    // silently. The extractor is strictly typed.
    class WeirdError extends Error {
      readonly statusCode = "400" as unknown as number;
      readonly errorCode = 42 as unknown as string;
    }
    logErrorWithId("import", "clone_failed", new WeirdError("weird"));
    const payload = getLoggedErrorPayload();
    expect(payload).not.toHaveProperty("statusCode");
    expect(payload).not.toHaveProperty("errorCode");
  });

  test("walks the `cause` chain so wrapped errors expose the original SDK fields", () => {
    // The clone wrapper in `daytona.ts` chains the original Daytona error
    // via `cause`. Without recursion, the structured fields would only
    // appear if the outer error happened to mirror them — defeating the
    // point of wrapping. Recursion makes the chain self-describing.
    class DaytonaLikeError extends Error {
      readonly statusCode = 400;
      readonly errorCode = "GIT_CLONE_FAILED";
      constructor(message: string) {
        super(message);
        this.name = "DaytonaValidationError";
      }
    }
    const inner = new DaytonaLikeError("Request failed");
    const outer = new Error("Sandbox git clone failed", { cause: inner });
    logErrorWithId("import", "clone_failed", outer);
    expect(getLoggedErrorPayload()).toMatchObject({
      message: "Sandbox git clone failed",
      cause: {
        name: "DaytonaValidationError",
        statusCode: 400,
        errorCode: "GIT_CLONE_FAILED",
      },
    });
  });

  test("caps recursion depth so a runaway library cannot blow the log record up", () => {
    // Construct a chain deeper than the documented cap (4) and confirm
    // the serializer stops descending. The exact depth boundary isn't
    // user-visible — what matters is that recursion is bounded.
    let chain: Error = new Error("root");
    for (let i = 0; i < 10; i += 1) {
      chain = new Error(`wrap-${i}`, { cause: chain });
    }
    logErrorWithId("import", "clone_failed", chain);
    const payload = getLoggedErrorPayload();
    let depth = 0;
    let cursor: unknown = payload;
    while (cursor && typeof cursor === "object" && "cause" in cursor) {
      cursor = (cursor as { cause: unknown }).cause;
      depth += 1;
      // Bail out if we ever exceed any plausible cap — failure mode is
      // unbounded recursion, which would have hung the test runner
      // already, so this is just a hard safety net.
      if (depth > 20) {
        throw new Error("serializer descended too far");
      }
    }
    expect(depth).toBeLessThanOrEqual(4);
  });

  test("breaks cause cycles instead of recursing forever", () => {
    // A pathological caller could set `error.cause = error` (or build a
    // longer cycle). The serializer must not loop; it marks the
    // revisited error with a sentinel `cause-cycle-detected` message.
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(() => logErrorWithId("import", "clone_failed", a)).not.toThrow();
    const serialized = JSON.stringify(getLoggedErrorPayload());
    expect(serialized).toContain("cause-cycle-detected");
  });
});
