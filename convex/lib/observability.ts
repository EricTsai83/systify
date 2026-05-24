type SerializableValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | SerializableValue[]
  | { [key: string]: SerializableValue };

/**
 * Plan 13 — metrics scope. Distinct from the per-feature `chat` /
 * `daytona` / etc. scopes so a downstream telemetry pipeline can
 * subscribe to "everything that's a metric" by filtering log lines
 * starting with `[metrics]` without parsing the body.
 *
 * Lifting it to a constant keeps {@link emitMetric} from drifting
 * apart from the runbook's grep recipes — when ops looks up
 * "sandbox_session_finished cost_usd > 0.50" they'll filter on the
 * literal `[metrics]` prefix.
 */
export const METRIC_SCOPE = "metrics";

/**
 * Plan 13 — metric tag value type. Tighter than the ambient log-detail
 * type because tags drive dashboards: a serialized object inside a tag
 * would be treated as one giant high-cardinality string by most
 * aggregation backends. Numbers / strings / booleans / `undefined`
 * cover every real use we have today (mode, status, error code, model
 * name, tool name, bucket).
 *
 * `null` is intentionally included alongside `undefined` for symmetry —
 * downstream pipelines that consume the JSON output cannot distinguish
 * the two anyway, so the type is permissive at the call site to keep
 * `someMaybeUndefined ?? null` patterns working without ceremony.
 */
export type MetricTagValue = string | number | boolean | null | undefined;

function normalizeScope(scope: string) {
  return (
    scope
      .replace(/[^a-z0-9]+/gi, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase() || "event"
  );
}

/**
 * Maximum depth to walk the `cause` chain when serializing an error.
 *
 * Cause chains are short in practice (typically 1-2 wraps), but a runaway
 * library that wraps eagerly could produce arbitrarily deep nesting. The
 * cap keeps log records bounded; cycle detection via `seen` is the second
 * guard for the case where `error.cause === error` (or a deeper loop).
 */
const ERROR_CAUSE_MAX_DEPTH = 4;

function serializeError(error: unknown, depth = 0, seen?: WeakSet<object>): SerializableValue {
  if (error instanceof Error) {
    const visited = seen ?? new WeakSet<object>();
    if (visited.has(error)) {
      return { name: error.name, message: "[cause-cycle-detected]" };
    }
    visited.add(error);

    const serialized: { [key: string]: SerializableValue } = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };

    // Daytona SDK errors carry `statusCode` (number) and `errorCode` (string)
    // as own properties. Surfacing them as structured log fields — rather
    // than relying on the message — lets ops query "all Daytona 4xx clones
    // in the last hour" without regex-parsing free-form text. Duck-typed
    // because observability.ts is shared across v8 and node runtimes and
    // cannot import `@daytona/sdk` (Node-only).
    const indexed = error as unknown as Record<string, unknown>;
    if (typeof indexed.statusCode === "number") {
      serialized.statusCode = indexed.statusCode;
    }
    if (typeof indexed.errorCode === "string") {
      serialized.errorCode = indexed.errorCode;
    }

    // `Error.cause` is ES2022; the frontend tsconfig still ships an ES2020
    // `lib` so we read the property through a localised cast rather than
    // bumping global config. The cast is type-only — the value is a real
    // property on every modern V8 runtime the Convex / Vite stack targets.
    const causeValue = (error as Error & { cause?: unknown }).cause;
    if (causeValue !== undefined && depth < ERROR_CAUSE_MAX_DEPTH) {
      serialized.cause = serializeError(causeValue, depth + 1, visited);
    }

    return serialized;
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "number" || typeof error === "boolean" || error == null) {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "[unserializable-error]";
  }
}

export function createOpaqueErrorId(scope: string) {
  const normalizedScope = normalizeScope(scope);
  const randomSuffix = Math.random().toString(36).slice(2, 8);
  return `${normalizedScope}_${Date.now().toString(36)}_${randomSuffix}`;
}

export function logInfo(scope: string, event: string, details: Record<string, SerializableValue> = {}) {
  console.log(`[${scope}] ${event}`, details);
}

export function logWarn(scope: string, event: string, details: Record<string, SerializableValue> = {}) {
  console.warn(`[${scope}] ${event}`, details);
}

export function logErrorWithId(
  scope: string,
  event: string,
  error: unknown,
  details: Record<string, SerializableValue> = {},
) {
  const errorId = createOpaqueErrorId(scope);
  console.error(`[${scope}] ${event}`, {
    errorId,
    ...details,
    error: serializeError(error),
  });
  return errorId;
}

/**
 * Plan 13 — emit a structured metric line.
 *
 * **Format contract**:
 * ```
 * [metrics] <metric> { metric, value?, tags: {...}, details?: {...} }
 * ```
 * where `metric` is duplicated into both the human-readable prefix
 * (left of the JSON body) AND inside the body. The prefix is what
 * `grep`-friendly tooling slices on; the body is what a JSON-aware
 * pipeline parses. Both views agree, which keeps the runbook recipes
 * resilient as the downstream tooling evolves.
 *
 * **Why a thin wrapper around `console.log`**: the existing project
 * convention is "structured-JSON-via-console". A dedicated metrics
 * emitter could add buffering, sampling, or a dedicated transport,
 * but every one of those is premature without a real bottleneck. The
 * wrapper standardises the *shape* (so dashboards that filter on
 * `tags.mode === "lab"` keep working as we add new metrics)
 * without committing to a particular transport.
 *
 * **Envelope isolation**: tags ride inside `tags: {...}` and details
 * inside `details: {...}` rather than at the top level so the metric
 * envelope is unambiguous — a future runtime field on the envelope
 * itself (timestamp, host, deployment) can never collide with a
 * user-supplied tag or detail key named the same thing. Nesting
 * `details` also matches the runbook's `details.X` query notation.
 *
 * **Duration / value semantics**: an optional numeric `value` sits at
 * the top level for the dominant "this metric IS a number"
 * (counter-with-amount, gauge, histogram). `details` carries
 * everything else — token counts, byte counts, intermediate measures
 * that don't merit promotion to "the value of the metric".
 *
 * The function never throws: a metric emit failure must not destroy
 * the surrounding logic (a chat reply that fails to log a metric
 * should still finalise to the user).
 */
export function emitMetric(
  metric: string,
  args: {
    /**
     * Optional primary numeric value of the metric. For session-level
     * metrics this is the duration in ms; for per-tool metrics the
     * tool's measured `durationMs`. Leave undefined for pure
     * counters where the call itself is the increment.
     */
    value?: number;
    /**
     * Low-cardinality categorical fields that downstream backends
     * group / filter on. Keep the count small and the value space
     * small — `mode: "lab"` is a good tag, `assistantMessageId:
     * <opaque-id>` is not (would explode dashboard cardinality).
     */
    tags?: Record<string, MetricTagValue>;
    /**
     * High-cardinality fields that come along for the ride but
     * shouldn't drive dashboards. `assistantMessageId`, `jobId`,
     * model identifier strings — useful for ad-hoc forensic
     * grepping, not for time-series aggregation.
     */
    details?: Record<string, SerializableValue>;
  } = {},
): void {
  try {
    const payload: Record<string, SerializableValue> = {
      metric,
      ...(args.value !== undefined ? { value: args.value } : {}),
      tags: serializeTagsForLog(args.tags),
      ...(args.details ? { details: args.details } : {}),
    };
    console.log(`[${METRIC_SCOPE}] ${metric}`, payload);
  } catch {
    // Fall back to a plain log so a serializer crash on the tag /
    // details map cannot bubble into the surrounding chat reply.
    // Lossy by design — better than failing the user-facing flow.
    console.log(`[${METRIC_SCOPE}] ${metric}`, { metric, tags_serialization_failed: true });
  }
}

/**
 * Convert the tag map into a `SerializableValue`-typed object so
 * `console.log`'s structured payload stays consistent with the rest of
 * the observability output. `undefined` tags are dropped entirely —
 * downstream JSON serializers that omit `undefined` keys wouldn't see
 * them anyway, and dropping them here keeps the runbook's grep
 * patterns ("`tags.mode === 'lab'`") deterministic.
 */
function serializeTagsForLog(tags: Record<string, MetricTagValue> | undefined): Record<string, SerializableValue> {
  if (!tags) {
    return {};
  }
  const out: Record<string, SerializableValue> = {};
  for (const [key, value] of Object.entries(tags)) {
    if (value === undefined) {
      continue;
    }
    out[key] = value;
  }
  return out;
}
