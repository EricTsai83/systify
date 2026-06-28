/**
 * Pricing snapshot for LLM models the chat / system-design / eval paths
 * are allowed to use. Provider-agnostic — keys combine `provider` and
 * `modelName` (`"openai:gpt-5"`, `"anthropic:claude-opus-4-8"`) so
 * adding a third provider (Gemini, …) is purely additive here.
 *
 * The set deliberately covers more than the current capability defaults
 * so the multi-provider model picker can land without a second pricing
 * pass — a (provider, model) pair missing from this table would
 * silently drop from the daily-cap accounting (`estimateCostUsd`
 * returns `undefined` for unknown pairs), which would let users
 * overspend through whichever variant happened to be missing.
 *
 * Numbers are public list pricing per 1 million tokens, USD. Update
 * the snapshot when a provider moves a tier; the values flow into:
 *
 *   1. The per-message cost ticker rendered in the chat bubble.
 *   2. The daily-cap settlement on `finalizeAssistantReply` (sandbox mode).
 *   3. The per-kind System Design cost telemetry.
 *   4. Test fixtures asserting fixed totals.
 *
 * Tolerant by design: a cache miss returns `undefined` rather than
 * throws so a typo in the catalog or a stale model name degrades to
 * "cost unavailable" instead of bricking the chat. Missing pricing
 * also short-circuits the daily-cap settlement (`undefined` ↔
 * "no cost recorded for this reply").
 *
 * Coverage invariant: every entry in `MODEL_CATALOG` (`llmCatalog.ts`)
 * must have a row here. The catalog test (`llmCatalog.test.ts`)
 * asserts this — adding a model to the catalog without adding a
 * pricing row fails the suite at build time, not at the user's
 * first reply.
 */
import type { LlmProvider, NormalizedUsage } from "./llmProvider";

export interface LlmPricing {
  /** USD per 1 M input (uncached prompt) tokens. */
  inputPerMillion: number;
  /** USD per 1 M output (completion + tool args) tokens. */
  outputPerMillion: number;
  /**
   * USD per 1 M cache-read input tokens. Anthropic prices cache reads
   * at a steep discount; OpenAI's prompt cache is model-specific
   * and exposed via `cachedPromptTokens` — both flow through this field.
   *
   * Omit when the provider does not charge a separate cache-read
   * tier (the math treats `cachedInputTokens` as fully-billed input
   * in that case).
   */
  cacheReadPerMillion?: number;
  /**
   * Anthropic-only: USD per 1 M cache-write tokens. Anthropic charges
   * a premium (~125% of input rate) for the first call that populates
   * the cache; subsequent reads pay the cheaper cacheRead rate.
   * Always `undefined` on OpenAI rows — OpenAI does not charge a
   * separate cache-write tier.
   */
  cacheWritePerMillion?: number;
  /**
   * USD per 1 M reasoning tokens. OpenAI charges reasoning at the
   * output rate; we model it as its own field so a future provider
   * with a different reasoning tier can land without changing the
   * call site. When `undefined`, the math falls back to charging
   * reasoning at the output rate (current OpenAI behaviour).
   */
  reasoningPerMillion?: number;
}

const PRICING: Record<string, LlmPricing> = {
  // === OpenAI === Sized to OpenAI GPT-5.5+ family list pricing. The
  // sandbox tier uses the full model because it drives tool use;
  // discuss / docs use mini / nano because they only need text
  // completions.
  "openai:gpt-5.5": {
    inputPerMillion: 5,
    outputPerMillion: 30,
    cacheReadPerMillion: 0.5,
  },
  "openai:gpt-5.4-mini": {
    inputPerMillion: 0.75,
    outputPerMillion: 4.5,
    cacheReadPerMillion: 0.075,
  },
  "openai:gpt-5.4-nano": {
    inputPerMillion: 0.2,
    outputPerMillion: 1.25,
    cacheReadPerMillion: 0.02,
  },
  // Legacy fallbacks for existing persisted messages.
  "openai:gpt-5": {
    inputPerMillion: 1.25,
    outputPerMillion: 10,
    cacheReadPerMillion: 0.625,
  },
  "openai:gpt-5-mini": {
    inputPerMillion: 0.25,
    outputPerMillion: 2,
    cacheReadPerMillion: 0.125,
  },
  "openai:gpt-5-nano": {
    inputPerMillion: 0.05,
    outputPerMillion: 0.4,
    cacheReadPerMillion: 0.025,
  },
  // GPT-4 family fallbacks. Kept so existing fixtures and historical
  // artifact provenance rows continue to bill correctly.
  "openai:gpt-4o-mini": {
    inputPerMillion: 0.15,
    outputPerMillion: 0.6,
  },
  "openai:gpt-4o": {
    inputPerMillion: 2.5,
    outputPerMillion: 10,
  },
  "openai:gpt-4.1": {
    inputPerMillion: 2.0,
    outputPerMillion: 8,
  },
  "openai:gpt-4.1-mini": {
    inputPerMillion: 0.4,
    outputPerMillion: 1.6,
  },
  // === Anthropic === Sized to Anthropic Claude Opus 4.8+ family list
  // pricing. Anthropic explicitly bills cache reads cheaper (10%) and
  // cache writes more expensive (125%) than the base input rate.
  "anthropic:claude-opus-4-8": {
    inputPerMillion: 5,
    outputPerMillion: 25,
    cacheReadPerMillion: 0.5,
    cacheWritePerMillion: 6.25,
  },
  "anthropic:claude-opus-4-7": {
    inputPerMillion: 5,
    outputPerMillion: 25,
    cacheReadPerMillion: 0.5,
    cacheWritePerMillion: 6.25,
  },
  "anthropic:claude-haiku-4-5": {
    inputPerMillion: 1,
    outputPerMillion: 5,
    cacheReadPerMillion: 0.1,
    cacheWritePerMillion: 1.25,
  },
  // Legacy fallbacks for existing persisted messages.
  "anthropic:claude-sonnet-4-6": {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
  },
  // === OpenAI embeddings === Input-only pricing — embedding APIs
  // return a vector, not generated tokens, so `outputPerMillion`
  // sits at 0. `estimateCostUsd` charges the `outputTokens / 1e6
  // * 0` line cleanly when the gateway passes
  // `{ outputTokens: 0 }`; the embed call sites never pass
  // `cachedInputTokens` / `cacheWriteTokens` / `reasoningTokens`,
  // so those lines naturally short-circuit to zero.
  "openai:text-embedding-3-small": {
    inputPerMillion: 0.02,
    outputPerMillion: 0,
  },
  "openai:text-embedding-3-large": {
    inputPerMillion: 0.13,
    outputPerMillion: 0,
  },
};

function pricingKey(provider: LlmProvider, modelName: string): string {
  return `${provider}:${modelName}`;
}

export function getPricing(provider: LlmProvider, modelName: string): LlmPricing | undefined {
  return PRICING[pricingKey(provider, modelName)];
}

/**
 * Compute USD spend for a single LLM call.
 *
 * Returns `undefined` when:
 *   - the (provider, modelName) pair is not in the pricing table, OR
 *   - both `inputTokens` and `outputTokens` are missing.
 *
 * Returning `undefined` (rather than zero) lets the daily-cap
 * settlement distinguish "this reply produced no recordable spend"
 * (heuristic path, pricing miss) from "the model truly cost $0.00"
 * (catalog'd model that genuinely returned zero tokens).
 *
 * Cache + reasoning tokens are priced when both the field is present
 * AND the pricing tier defines a rate for it. A model that does not
 * surface `cachedInputTokens` simply contributes nothing on the
 * cache-read line — no over-charging.
 */
export function estimateCostUsd(provider: LlmProvider, modelName: string, usage: NormalizedUsage): number | undefined {
  const pricing = getPricing(provider, modelName);
  if (!pricing) return undefined;
  const { inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens, reasoningTokens } = usage;
  // Require at least one core token field to attribute meaningful
  // cost. A call with neither input nor output tokens is a degenerate
  // case (a stream that errored before any usage settled); we treat
  // it as "cost unknown" so the daily cap doesn't double-charge a
  // retried failure.
  if (inputTokens === undefined && outputTokens === undefined) return undefined;

  let cost = 0;
  if (inputTokens !== undefined) {
    cost += (inputTokens / 1_000_000) * pricing.inputPerMillion;
  }
  if (outputTokens !== undefined) {
    cost += (outputTokens / 1_000_000) * pricing.outputPerMillion;
  }
  if (cachedInputTokens !== undefined) {
    // Fall back to the full input rate when the model does not declare
    // a dedicated cache-read tier — matches the LlmPricing contract
    // documented on `cacheReadPerMillion` ("the math treats
    // `cachedInputTokens` as fully-billed input in that case").
    const cachedRate = pricing.cacheReadPerMillion ?? pricing.inputPerMillion;
    cost += (cachedInputTokens / 1_000_000) * cachedRate;
  }
  if (cacheWriteTokens !== undefined && pricing.cacheWritePerMillion !== undefined) {
    cost += (cacheWriteTokens / 1_000_000) * pricing.cacheWritePerMillion;
  }
  if (reasoningTokens !== undefined) {
    // Fall back to the output rate when the model does not declare a
    // dedicated reasoning tier — OpenAI's published behaviour today.
    const reasoningRate = pricing.reasoningPerMillion ?? pricing.outputPerMillion;
    cost += (reasoningTokens / 1_000_000) * reasoningRate;
  }
  return cost;
}

/**
 * Convert a USD cost to integer cents using **ceiling** rounding.
 *
 * The daily-cap rate-limiter speaks in cents because the underlying
 * token-bucket component requires integer counts. Ceiling
 * rounding is the one rule that keeps the sum of recorded message costs
 * always ≥ the real spend — flooring would let many sub-cent replies stack
 * up to several free dollars per user before the cap finally triggered.
 *
 * `undefined` propagates from `estimateCostUsd` so callers can distinguish
 * "cost unknown" (don't settle) from "cost is zero" (still settle, but
 * for zero cents).
 */
export function costUsdToCents(costUsd: number | undefined): number | undefined {
  if (costUsd === undefined) {
    return undefined;
  }
  if (!Number.isFinite(costUsd) || costUsd < 0) {
    return 0;
  }
  return Math.ceil(costUsd * 100);
}

/**
 * Test-only export — exposes the list of priced `(provider, model)`
 * keys so the catalog-coverage assertion in `llmCatalog.test.ts` can
 * cross-check the catalog against the pricing table without reaching
 * into the module's private `PRICING` map.
 */
export const TEST_INTERNALS = {
  pricingKeys: () => Object.keys(PRICING),
} as const;
