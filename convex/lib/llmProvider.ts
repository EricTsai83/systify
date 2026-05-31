import { v, type Infer } from "convex/values";

/**
 * Canonical LLM-provider vocabulary, shared by the persisted DB enums on
 * `messages.provider`, `threads.lockedProvider`, `jobs.provider`,
 * `artifacts.generatedByProvider`, and `systemDesignKindRuns.provider`,
 * the chat/send mutation that validates a user-picked model, and the
 * `convex/lib/llmGateway.ts` dispatcher.
 *
 * Defining the union here (rather than inlining in `schema.ts`) lets
 * `llmCatalog.ts` / `llmGateway.ts` import the TS type without pulling
 * in the full schema module, and keeps the literal set a single source
 * of truth — adding a third provider (Gemini, …) is a one-line change
 * here that surfaces at every consumer as a compile error.
 *
 *   - `openai`    — OpenAI's GPT family via `@ai-sdk/openai`
 *   - `anthropic` — Anthropic's Claude family via `@ai-sdk/anthropic`
 *
 * Provider strings are stable: never rename a literal, only add new
 * ones, since the literals appear in persisted rows.
 */
export const llmProviderValidator = v.union(v.literal("openai"), v.literal("anthropic"));

/**
 * TS twin of {@link llmProviderValidator}. Use everywhere a provider
 * literal is expected so adding a new provider surfaces downstream as
 * a compile error rather than a silent stale literal.
 */
export type LlmProvider = Infer<typeof llmProviderValidator>;

/**
 * Provider-agnostic token-usage shape produced by `llmGateway` after
 * normalizing each provider's `providerMetadata` block. Consumed by
 * `llmPricing.estimateCostUsd` for cost math and by callers that
 * persist usage onto messages / job rows.
 *
 *   - `inputTokens`        — prompt tokens (uncached portion).
 *   - `outputTokens`       — completion tokens (text + tool args).
 *   - `cachedInputTokens`  — prompt tokens served from the provider's
 *      cache. Already excluded from `inputTokens` so they are NOT
 *      double-counted. OpenAI surfaces this as
 *      `providerMetadata.openai.cachedPromptTokens`; Anthropic as
 *      `providerMetadata.anthropic.cacheReadInputTokens`.
 *   - `cacheWriteTokens`   — Anthropic-only: tokens written into the
 *      cache on this call (priced separately at a premium). Always
 *      `undefined` on OpenAI rows.
 *   - `reasoningTokens`    — extended-thinking / o-series reasoning
 *      tokens. Charged at the output rate but tracked separately so
 *      cost dashboards can attribute the reasoning portion of spend.
 *
 * All fields are `undefined`-tolerant: a provider that does not emit
 * a field, or a stream that errors before usage settles, produces a
 * partial shape. Downstream consumers must treat `undefined` as
 * "unknown" — pricing returns `undefined` rather than zero, and the
 * UI renders an em-dash rather than `$0.00`.
 */
export interface NormalizedUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}
