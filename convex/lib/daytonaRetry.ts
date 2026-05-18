"use node";

/**
 * Retry helper for Daytona SDK calls.
 *
 * Wraps an arbitrary Daytona SDK call with exponential backoff + jitter
 * for transient failures. The policy is informed by Daytona's documented
 * "Create Sandbox with retry" pattern
 * (https://www.daytona.io/docs/en/limits/) and extends it with three
 * production-grade additions:
 *
 *   1. Jitter — pure `2^n` backoff causes thundering herd when concurrent
 *      callers all retry at the same intervals. ±20% randomised jitter
 *      desynchronises them so the second wave doesn't pile back onto the
 *      same 429.
 *   2. Max-delay cap — pure exponential reaches 32s / 64s, which can
 *      outlive the surrounding Convex action's lease (default 60s for
 *      most jobs) and cause stale-recovery to kick in mid-retry. Capping
 *      at 30s keeps total wall-clock bounded.
 *   3. Retriable classification — Daytona's sample only handles 429. We
 *      additionally retry 5xx transient errors and connection-level blips
 *      (ECONNRESET, ECONNREFUSED, ETIMEDOUT, EAI_AGAIN, EPIPE). 4xx
 *      (validation / auth / not-found / conflict) and SDK-level timeouts
 *      fail fast — retrying won't change the outcome and would waste the
 *      lease budget.
 *
 * Operations the LLM observes directly (`read_file` / `list_dir` /
 * `run_shell` tool calls in `getSandboxFsClient`) are deliberately NOT
 * wrapped here. The LLM is expected to see tool errors and adapt;
 * transparent retries would change that contract. Wrapping is for
 * infrastructure-level calls (provisioning, deletion, lookup, listing,
 * network policy, setup commands, repo walker).
 *
 * The helper preserves the original error on final throw so caller-side
 * `instanceof DaytonaNotFoundError` / `wrapDaytonaCloneError` chains keep
 * working — retry is invisible on the happy path and on the give-up path.
 */

import { DaytonaError, DaytonaRateLimitError } from "@daytona/sdk";
import { emitMetric, logInfo, logWarn } from "./observability";

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
const JITTER_RATIO = 0.2;

/**
 * Header names that may carry a server-provided wait hint, checked in
 * priority order. The throttler-specific names (sandbox-create,
 * sandbox-lifecycle, general) match Daytona's per-throttler rate-limit
 * scheme; the bare `retry-after` is the HTTP/1.1 fallback.
 */
const RETRY_AFTER_HEADER_NAMES = [
  "retry-after-sandbox-create",
  "retry-after-sandbox-lifecycle",
  "retry-after-general",
  "retry-after",
] as const;

/**
 * Network-level error codes we treat as transient. Sourced from common
 * Node / axios / undici codes that indicate a connection issue rather
 * than a server-side rejection. Codes outside this set (e.g. `ENOTFOUND`,
 * `ECONNABORTED`) are not retried — they typically indicate a
 * configuration error (wrong host, request aborted by caller) that a
 * retry would only mask.
 */
const RETRIABLE_NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "EPIPE"]);

export interface DaytonaRetryContext {
  /**
   * Stable low-cardinality identifier of the operation being wrapped.
   * Emitted as a `tags.operation` value on retry metrics so dashboards
   * can slice retry rate by call site (`sandbox.create`,
   * `sandbox.delete`, `sandbox.fs.listFiles`, …).
   */
  operation: string;
  /**
   * Optional resource identifier (sandbox remote id, sandbox name, path).
   * Forwarded into the structured log `details` for forensic grep but
   * NOT promoted to a metric tag — too high cardinality for time-series
   * aggregation.
   */
  resourceId?: string;
}

/**
 * Execute `op`, retrying on transient Daytona / network failures with
 * exponential backoff + jitter. Returns the eventual successful result;
 * re-throws the *original* error on non-retriable failures or after
 * `MAX_RETRIES` attempts.
 *
 * Logs every retry attempt and the final exhaustion as structured
 * events; emits `daytona_retry_attempted` / `daytona_retry_succeeded` /
 * `daytona_retry_exhausted` metrics so ops can chart retry pressure.
 */
export async function withDaytonaRetry<T>(op: () => Promise<T>, context: DaytonaRetryContext): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = await op();
      if (attempt > 0) {
        emitMetric("daytona_retry_succeeded", {
          tags: { operation: context.operation },
          details: { attempts: attempt + 1, resourceId: context.resourceId },
        });
      }
      return result;
    } catch (error) {
      lastError = error;
      const retriable = isRetriable(error);
      const isLast = attempt === MAX_RETRIES - 1;
      if (!retriable) {
        // Non-retriable — preserve the original error untouched. Callers
        // that branch on `instanceof DaytonaNotFoundError` / 4xx need the
        // exact reference here.
        throw error;
      }
      if (isLast) {
        logWarn("daytona", "retry_exhausted", {
          operation: context.operation,
          resourceId: context.resourceId,
          attempts: MAX_RETRIES,
          final_reason: classifyReason(error),
        });
        emitMetric("daytona_retry_exhausted", {
          tags: { operation: context.operation, reason: classifyReason(error) },
          details: { attempts: MAX_RETRIES, resourceId: context.resourceId },
        });
        throw error;
      }
      const serverHint = extractRetryAfterMs(error);
      const delayMs = computeDelay(serverHint, attempt);
      logInfo("daytona", "retry_attempt", {
        operation: context.operation,
        resourceId: context.resourceId,
        attempt: attempt + 1,
        delay_ms: delayMs,
        used_server_hint: serverHint !== null,
        reason: classifyReason(error),
      });
      emitMetric("daytona_retry_attempted", {
        tags: {
          operation: context.operation,
          reason: classifyReason(error),
          used_server_hint: serverHint !== null,
        },
      });
      await sleep(delayMs);
    }
  }
  // Unreachable: the final iteration either returns or throws inside the
  // `isLast` branch. The throw keeps TypeScript's control-flow analysis
  // honest about the return type.
  throw lastError;
}

/**
 * True when the error is worth another attempt. Conservative on purpose
 * — anything not on the documented retriable list is treated as a hard
 * failure so a real caller bug (validation error, bad token) surfaces
 * immediately instead of being masked by 5 retries.
 *
 * Exported for use by direct call sites that want to make a retry
 * decision without invoking the full helper (e.g. for tool-layer SDK
 * calls that need a single fast retry instead of the full backoff
 * schedule).
 */
export function isRetriable(error: unknown): boolean {
  if (error instanceof DaytonaRateLimitError) return true;
  if (error instanceof DaytonaError) {
    const status = error.statusCode;
    if (typeof status === "number" && status >= 500 && status < 600) return true;
    return false;
  }
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === "string" && RETRIABLE_NETWORK_CODES.has(code)) return true;
  }
  return false;
}

/**
 * Pull the most-specific `retry-after-*` header from a Daytona error
 * response, capped at `MAX_DELAY_MS`. Returns `null` when no usable
 * header is present (no `headers` object, no `.get` method, no
 * recognised header name, or unparseable value).
 *
 * The cap matters: a misbehaving upstream that returns
 * `retry-after: 300` would otherwise sleep for 5 minutes — longer than
 * the surrounding action's lease, so the work gets stale-recovered
 * before the retry even fires. The cap turns that into a 30s wait and
 * lets retry pressure surface in the `retry_exhausted` metric instead
 * of silently disappearing.
 */
function extractRetryAfterMs(error: unknown): number | null {
  if (!(error instanceof DaytonaError) || !error.headers) return null;
  const headers = error.headers as unknown as {
    get?: (name: string) => string | null | undefined;
  };
  if (typeof headers.get !== "function") return null;
  for (const name of RETRY_AFTER_HEADER_NAMES) {
    const raw = headers.get(name);
    if (typeof raw !== "string" || raw.length === 0) continue;
    const seconds = Number.parseInt(raw, 10);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, MAX_DELAY_MS);
    }
  }
  return null;
}

function computeDelay(serverHintMs: number | null, attempt: number): number {
  if (serverHintMs !== null) return serverHintMs;
  const backoff = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  // Symmetric ±JITTER_RATIO around the backoff. (Math.random()*2 - 1)
  // lives in [-1, 1); scaled by JITTER_RATIO * backoff this gives a
  // delay window of [backoff * (1 - JITTER_RATIO), backoff * (1 +
  // JITTER_RATIO)). The Math.max guards against a theoretical negative
  // due to floating-point rounding at low backoff values.
  const jitter = (Math.random() * 2 - 1) * JITTER_RATIO * backoff;
  return Math.max(0, Math.round(backoff + jitter));
}

function classifyReason(error: unknown): string {
  if (error instanceof DaytonaRateLimitError) return "rate_limited";
  if (error instanceof DaytonaError) {
    const status = error.statusCode;
    return typeof status === "number" ? `daytona_${status}` : "daytona_unknown";
  }
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === "string") return `network_${code.toLowerCase()}`;
  }
  return "unknown";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Test-only export of the tunables so unit tests can pin behaviour to
 * the same constants the runtime uses without re-importing each one.
 */
export const TEST_INTERNALS = {
  MAX_RETRIES,
  BASE_DELAY_MS,
  MAX_DELAY_MS,
  JITTER_RATIO,
} as const;
