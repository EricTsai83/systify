/**
 * Retry helper for AI SDK calls (`generateText`, `streamText`).
 *
 * Mirrors `convex/lib/daytonaRetry.ts` — same constants, jitter
 * scheme, server-hint precedence, and metric envelope — so retry
 * behaviour reads identically across infrastructure boundaries.
 * The only difference is the classifier: provider 429 / 5xx /
 * network blips from the AI SDK get retried, while validation
 * errors (4xx other than 429) fail fast.
 *
 * Provider dispatch is per-call: the wrapper checks `provider` to
 * route into the right `isRetriable` branch. The check is cheap
 * (string compare) and lets one wrapper serve OpenAI, Anthropic,
 * and any future provider without per-provider call sites.
 *
 * **Critical contract**: callers of the AI SDK MUST set
 * `maxRetries: 0` when wrapping with this helper. The SDK's
 * built-in retry would otherwise double-count attempts, leading to
 * effective backoff of `5 × 3 = 15 attempts` per call. Explicit
 * `maxRetries: 0` keeps the wrapper as the sole authority on
 * retry scheduling.
 *
 * Operations the LLM observes directly (its own tool calls inside
 * a `streamText` step loop) are deliberately NOT wrapped here.
 * The LLM is expected to see tool errors and adapt; transparent
 * retries would change that contract. Wrapping is for the
 * outermost `generateText` / `streamText` call only.
 */

import { APICallError } from "ai";

import type { LlmProvider } from "./llmProvider";
import { emitMetric, logInfo, logWarn } from "./observability";

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
const JITTER_RATIO = 0.2;

/**
 * Header names that may carry a server-provided wait hint, checked in
 * priority order. Both OpenAI and Anthropic emit `retry-after` on
 * 429 responses. Anthropic additionally uses
 * `anthropic-ratelimit-requests-reset` for non-429 responses near
 * the rate-limit threshold; we read it as a secondary hint so a
 * 200 OK with a tight reset hint can still slow the next retry
 * window if the SAME call later 429s.
 */
const RETRY_AFTER_HEADER_NAMES = [
  "retry-after",
  "anthropic-ratelimit-tokens-reset",
  "anthropic-ratelimit-requests-reset",
] as const;

/**
 * Network-level error codes we treat as transient. Matches the set
 * in `daytonaRetry.ts` for consistency — same operator mental model
 * across both retry boundaries.
 */
const RETRIABLE_NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "EPIPE"]);

export interface LlmRetryContext {
  /**
   * Stable low-cardinality identifier of the operation being wrapped.
   * Emitted as `tags.operation` on retry metrics so dashboards can
   * slice retry pressure by call site (`chat.stream`,
   * `systemdesign.generate`, `eval.judge`).
   */
  operation: string;
  /**
   * Provider being called. Drives the retriable classifier and rides
   * along on every metric tag for cross-provider dashboards.
   */
  provider: LlmProvider;
  /**
   * Model identifier (`gpt-5`, `claude-opus-4-8`, …). Forwarded as a
   * metric tag so a misbehaving single model surfaces independently
   * from healthy peers on the same provider.
   */
  modelName: string;
  /**
   * Optional resource identifier (jobId, threadId, messageId).
   * Forwarded into the structured log `details` for forensic grep
   * but NOT promoted to a metric tag — too high cardinality for
   * time-series aggregation.
   */
  resourceId?: string;
}

/**
 * Execute `op`, retrying on transient provider / network failures
 * with exponential backoff + jitter. Returns the eventual successful
 * result; re-throws the *original* error on non-retriable failures
 * or after `MAX_RETRIES` attempts.
 *
 * Logs every retry attempt and the final exhaustion as structured
 * events; emits `llm_retry_attempted` / `llm_retry_succeeded` /
 * `llm_retry_exhausted` metrics so ops can chart retry pressure
 * cross-provider.
 */
export async function withLlmRetry<T>(op: () => Promise<T>, context: LlmRetryContext): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = await op();
      if (attempt > 0) {
        emitMetric("llm_retry_succeeded", {
          tags: { operation: context.operation, provider: context.provider, modelName: context.modelName },
          details: { attempts: attempt + 1, resourceId: context.resourceId },
        });
      }
      return result;
    } catch (error) {
      lastError = error;
      const retriable = isRetriable(error, context.provider);
      const isLast = attempt === MAX_RETRIES - 1;
      if (!retriable) {
        // Non-retriable — preserve the original error untouched so
        // callers that branch on `error instanceof APICallError`
        // (or the gateway's `LlmRateLimitError`) keep the exact
        // reference.
        throw error;
      }
      if (isLast) {
        logWarn("llm", "retry_exhausted", {
          operation: context.operation,
          provider: context.provider,
          modelName: context.modelName,
          resourceId: context.resourceId,
          attempts: MAX_RETRIES,
          final_reason: classifyReason(error, context.provider),
        });
        emitMetric("llm_retry_exhausted", {
          tags: {
            operation: context.operation,
            provider: context.provider,
            modelName: context.modelName,
            reason: classifyReason(error, context.provider),
          },
          details: { attempts: MAX_RETRIES, resourceId: context.resourceId },
        });
        throw error;
      }
      const serverHint = extractRetryAfterMs(error);
      const delayMs = computeDelay(serverHint, attempt);
      logInfo("llm", "retry_attempt", {
        operation: context.operation,
        provider: context.provider,
        modelName: context.modelName,
        resourceId: context.resourceId,
        attempt: attempt + 1,
        delay_ms: delayMs,
        used_server_hint: serverHint !== null,
        reason: classifyReason(error, context.provider),
      });
      emitMetric("llm_retry_attempted", {
        tags: {
          operation: context.operation,
          provider: context.provider,
          modelName: context.modelName,
          reason: classifyReason(error, context.provider),
          used_server_hint: serverHint !== null,
        },
      });
      await sleep(delayMs);
    }
  }
  // Unreachable: the final iteration either returns or throws inside
  // the `isLast` branch. The throw keeps TypeScript's control-flow
  // analysis honest about the return type.
  throw lastError;
}

/**
 * True when the error is worth another attempt under `provider`'s
 * conventions. Conservative on purpose — anything not on the
 * documented retriable list is treated as a hard failure so a real
 * caller bug (validation error, invalid API key, model not found)
 * surfaces immediately instead of being masked by 5 retries.
 *
 * Both OpenAI and Anthropic surface transport errors through the
 * AI SDK's shared `APICallError`. The classifier dispatches on
 * `provider` only when the heuristic differs — today both use the
 * same status / network rules, but keeping the `provider` arg
 * lets a future provider add an idiosyncratic case (e.g. Gemini's
 * `RESOURCE_EXHAUSTED` gRPC status) without changing the call
 * site.
 */
export function isRetriable(error: unknown, _provider: LlmProvider): boolean {
  if (error instanceof APICallError) {
    const status = error.statusCode;
    if (typeof status === "number") {
      if (status === 429) return true;
      if (status >= 500 && status < 600) return true;
      return false;
    }
    // `statusCode === undefined` indicates a transport-layer fault
    // (request never reached the server). Treat as retriable —
    // identical to a network error.
    return true;
  }
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === "string" && RETRIABLE_NETWORK_CODES.has(code)) return true;
  }
  return false;
}

/**
 * Pull the most-specific `retry-after-*` header from an AI SDK
 * error response, capped at `MAX_DELAY_MS`. Returns `null` when no
 * usable header is present.
 *
 * The cap matters: a misbehaving upstream that returns
 * `retry-after: 300` would otherwise sleep for 5 minutes — longer
 * than most action leases — and trigger stale-recovery before the
 * retry fires. The cap turns that into a 30s wait and lets retry
 * pressure surface in the `llm_retry_exhausted` metric instead of
 * silently disappearing.
 */
function extractRetryAfterMs(error: unknown): number | null {
  if (!(error instanceof APICallError)) return null;
  const headers = error.responseHeaders;
  if (!headers || typeof headers !== "object") return null;
  // AI SDK `responseHeaders` is a plain `Record<string, string>`
  // with lowercase keys. Mirror the access pattern.
  const headerMap = headers as Record<string, string>;
  for (const name of RETRY_AFTER_HEADER_NAMES) {
    const raw = headerMap[name];
    if (typeof raw !== "string" || raw.length === 0) continue;

    // Try numeric seconds first (common case). Guard against
    // `Number.parseFloat` swallowing the year out of an RFC3339
    // timestamp like "2026-06-01T12:00:00Z" (which would yield 2026
    // and be treated as a 2026-second wait) by only taking the
    // numeric branch when `raw` is a plain numeric token.
    const trimmed = raw.trim();
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      const seconds = Number.parseFloat(trimmed);
      if (Number.isFinite(seconds) && seconds > 0) {
        return Math.min(Math.ceil(seconds * 1000), MAX_DELAY_MS);
      }
    }

    // Try RFC3339 timestamp (Anthropic ratelimit reset headers)
    const timestamp = Date.parse(raw);
    if (Number.isFinite(timestamp)) {
      const delayMs = timestamp - Date.now();
      if (delayMs > 0) {
        return Math.min(delayMs, MAX_DELAY_MS);
      }
    }
  }
  return null;
}

function computeDelay(serverHintMs: number | null, attempt: number): number {
  if (serverHintMs !== null) return serverHintMs;
  const backoff = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  // Symmetric ±JITTER_RATIO around the backoff. (Math.random()*2 - 1)
  // lives in [-1, 1); scaled by JITTER_RATIO * backoff this gives
  // a delay window of [backoff * (1 - JITTER_RATIO), backoff *
  // (1 + JITTER_RATIO)). Math.max guards against a theoretical
  // negative due to floating-point rounding at low backoff values.
  const jitter = (Math.random() * 2 - 1) * JITTER_RATIO * backoff;
  return Math.max(0, Math.round(backoff + jitter));
}

function classifyReason(error: unknown, provider: LlmProvider): string {
  if (error instanceof APICallError) {
    const status = error.statusCode;
    if (typeof status === "number") {
      if (status === 429) return `${provider}_429`;
      return `${provider}_${status}`;
    }
    return `${provider}_transport`;
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
 * Test-only export of the tunables so unit tests can pin behaviour
 * to the same constants the runtime uses without re-importing each
 * one.
 */
export const TEST_INTERNALS = {
  MAX_RETRIES,
  BASE_DELAY_MS,
  MAX_DELAY_MS,
  JITTER_RATIO,
} as const;
