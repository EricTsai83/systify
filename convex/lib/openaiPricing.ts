/**
 * Pricing snapshot for OpenAI text models the chat replies are allowed to use.
 *
 * The set deliberately covers more than the current `OPENAI_MODEL` default so
 * Plan 11's per-mode model selection (`OPENAI_MODEL_SANDBOX` / `_DOCS` /
 * `_DISCUSS`) can land without a second pricing pass — adding a model that
 * isn't in the table would silently drop it from the daily-cap accounting
 * (Plan 10's `estimatedCostUsd` returns `undefined` for unknown models),
 * which would let users overspend through whichever variant happened to
 * be missing.
 *
 * Numbers are public list pricing per 1 million tokens, USD. Update the
 * snapshot when OpenAI moves a tier; the values flow into:
 *
 *   1. The per-message cost ticker rendered in the chat bubble.
 *   2. The daily-cap settlement on `finalizeAssistantReply` (sandbox mode).
 *   3. Test fixtures asserting fixed totals.
 *
 * Tolerant by design: a cache miss returns `undefined` rather than throws so
 * a typo in `OPENAI_MODEL_*` env vars degrades to "cost unavailable" instead
 * of bricking the chat. Missing pricing also short-circuits the daily-cap
 * settlement (`undefined` ↔ "no cost recorded for this reply"), so a typo
 * is a forgiving failure mode rather than a user-facing block.
 */
export type OpenAIPricing = {
  inputPerMillion: number;
  outputPerMillion: number;
};

const PRICING: Record<string, OpenAIPricing> = {
  // Plan 11 sandbox/docs/discuss defaults — sized roughly to the OpenAI
  // GPT-5 family list pricing. Sandbox mode uses the full-tier model
  // because it drives tool use; discuss / docs use the mini tier because
  // they only need text-only completions.
  "gpt-5": {
    inputPerMillion: 1.25,
    outputPerMillion: 10,
  },
  "gpt-5-mini": {
    inputPerMillion: 0.25,
    outputPerMillion: 2,
  },
  "gpt-5-nano": {
    inputPerMillion: 0.05,
    outputPerMillion: 0.4,
  },
  // Pre-Plan-11 GPT-4 family fallbacks. Kept so existing fixtures and any
  // operator who pinned `OPENAI_MODEL=gpt-4o` mid-rollout continue to bill
  // correctly during the transition window.
  "gpt-4o-mini": {
    inputPerMillion: 0.15,
    outputPerMillion: 0.6,
  },
  "gpt-4o": {
    inputPerMillion: 2.5,
    outputPerMillion: 10,
  },
  "gpt-4.1": {
    inputPerMillion: 2.0,
    outputPerMillion: 8,
  },
  "gpt-4.1-mini": {
    inputPerMillion: 0.4,
    outputPerMillion: 1.6,
  },
};

export function estimateCostUsd(
  model: string,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
): number | undefined {
  const pricing = PRICING[model];
  if (!pricing || inputTokens === undefined || outputTokens === undefined) {
    return undefined;
  }

  return (inputTokens / 1_000_000) * pricing.inputPerMillion + (outputTokens / 1_000_000) * pricing.outputPerMillion;
}

/**
 * Convert a USD cost to integer cents using **ceiling** rounding.
 *
 * The daily-cap rate-limiter (Plan 10) speaks in cents because the
 * underlying token-bucket component requires integer counts. Ceiling
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
