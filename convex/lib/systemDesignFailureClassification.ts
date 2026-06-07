"use node";

import { APICallError } from "ai";
import { LlmRateLimitError } from "./llmGateway";
import { SandboxPreparationError } from "./sandboxLiveness";
import { isUsageBudgetExceededError } from "./userCost";
import type { SystemDesignFailureReason } from "./systemDesignFailures";

/**
 * Map System Design kind-run exceptions into persisted failure taxonomy.
 *
 * The Interface hides provider SDK details, gateway rate-limit classes, and
 * usage-budget ConvexError payloads from the kind runner. Callers only need a
 * stable `SystemDesignFailureReason` for telemetry, retry copy, and reports.
 */
export function classifySystemDesignKindRunError(error: unknown): SystemDesignFailureReason {
  if (error instanceof SandboxPreparationError) {
    return "live_source_unavailable";
  }
  if (error instanceof LlmRateLimitError) {
    return "transport_rate_limit";
  }
  if (isUsageBudgetExceededError(error)) {
    return "transport_rate_limit";
  }
  if (APICallError.isInstance(error)) {
    if (error.statusCode === 429) {
      return "transport_rate_limit";
    }
    return "transport_other";
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/empty document/i.test(message)) {
    return "model_empty_output";
  }
  return "infra";
}
