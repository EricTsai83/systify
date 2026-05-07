import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { METRIC_SCOPE, emitMetric } from "./observability";

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
    emitMetric("sandbox_session_finished", { value: 1234, tags: { mode: "sandbox" } });
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
      tags: { mode: "sandbox" },
      details: { jobId: "j_xyz", model: "gpt-5" },
    });
    const [, payload] = logSpy.mock.calls[0];
    expect(payload).toMatchObject({
      metric: "sandbox_session_finished",
      tags: { mode: "sandbox" },
      details: { jobId: "j_xyz", model: "gpt-5" },
    });
  });

  test("omits `details` when not provided", () => {
    // Symmetric to the `value` omission: a metric with no forensic
    // payload should not surface a stale `details: {}` in the body,
    // so JSON pipelines that test on `details` presence stay
    // deterministic.
    emitMetric("sandbox_session_finished", { tags: { mode: "sandbox" } });
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
        tags: { mode: "sandbox" },
        details: { exploding } as never,
      });
    }).not.toThrow();
    expect(logSpy).toHaveBeenCalledTimes(1);
  });
});
