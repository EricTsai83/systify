/**
 * Resolve `(provider, modelName)` for a single chat reply.
 *
 * The resolver is a thin pass-through. It runs after `chat.send.sendMessage`
 * has already validated the user's pick against {@link MODEL_CATALOG} and
 * enforced the thread provider lock; this module's job is only to
 * collapse the (per-message override, thread default, capability default)
 * triple into a single `ModelChoice`. The picker UI, the lock
 * enforcement, and the env-driven operator escape hatch all live
 * elsewhere:
 *
 *   - The picker UI lives in `src/components/ai-elements/prompt-input-model-picker.tsx`.
 *   - The lock enforcement lives in `chat/send.ts:sendMessage`.
 *   - Operator overrides land in {@link MODEL_CATALOG} (add an entry) or via
 *     the future per-user policy table — not via env vars here.
 *
 * Resolution order (first defined wins):
 *
 *   1. **Per-message override.** `overrideProvider + overrideModelName`
 *      come from the queued user message (`messages.provider /
 *      messages.modelName`). These are what the user explicitly picked in
 *      the composer for *this* send. Already validated by the send
 *      mutation; we revalidate here so an out-of-band rewrite (catalog
 *      narrowed while a thread was running) degrades to the default
 *      rather than producing an `LlmGateway` failure later.
 *
 *   2. **Thread default.** `threadDefaultModelName` is
 *      `threads.defaultModelName`, refreshed on every send. Only consulted
 *      when no per-message override exists; the provider is inferred via
 *      catalog lookup. Lets a re-opened thread restore the user's last
 *      pick without forcing them to re-select.
 *
 *   3. **Capability default.** Falls back to a hard-coded
 *      {@link DEFAULT_PICK_BY_CAPABILITY} entry sized so a fresh install
 *      with `OPENAI_API_KEY` set just works. Defaults are OpenAI today
 *      (Anthropic is reachable via explicit pick) because the bootstrap
 *      docs only mandate `OPENAI_API_KEY`.
 *
 * The returned `reasoningEffort` is the catalog entry's per-model default;
 * `undefined` for non-reasoning models so the gateway can omit the
 * provider-specific reasoning knob cleanly.
 */

import type { ChatMode } from "../lib/chatMode";
import { getCatalogEntry, MODEL_CATALOG, type ModelCapability, type ReasoningEffort } from "../lib/llmCatalog";
import type { LlmProvider } from "../lib/llmProvider";

// Re-exported for the chat / generation call sites so they don't have to
// chase the canonical location at the same time the multi-provider
// catalog lands.
export type { ModelCapability, ReasoningEffort };

/**
 * Resolved pick handed to {@link generateViaGateway} / {@link streamViaGateway}.
 * Carries the picked `(provider, modelName)` pair alongside its catalog-
 * derived `reasoningEffort` and the `capability` tier we routed against so
 * the gateway can wire `providerOptions` without re-deriving either.
 */
export type ModelChoice = {
  provider: LlmProvider;
  modelName: string;
  /** `undefined` for non-reasoning models — gateway omits the provider-specific knob. */
  reasoningEffort: ReasoningEffort | undefined;
  capability: ModelCapability;
};

/**
 * Capability → `(provider, model)` default. The pricing-coverage test in
 * `modelSelection.test.ts` pins this pairing — every default here must
 * have a catalog entry AND a pricing row, otherwise the daily cost cap
 * settlement silently degrades to "no cost recorded" (`estimateCostUsd`
 * returns `undefined` for unknown pairs).
 *
 * Defaults are OpenAI because `OPENAI_API_KEY` is the only env var the
 * bootstrap docs require; Anthropic is opt-in via the composer picker.
 */
const DEFAULT_PICK_BY_CAPABILITY: Record<ModelCapability, { provider: LlmProvider; modelName: string }> = {
  sandbox: { provider: "openai", modelName: "gpt-5" },
  library: { provider: "openai", modelName: "gpt-5-mini" },
  discuss: { provider: "openai", modelName: "gpt-5-mini" },
};

/**
 * Map a `(mode, groundSandbox)` pair to its capability tier. Sandbox
 * grounding wins over the underlying mode because the tool-use trajectory
 * is the dominant cost signal — a sandbox-grounded Discuss reply lands on
 * the heavier `sandbox` tier regardless of the surface name.
 */
export function pickCapability(args: { mode: ChatMode; groundSandbox: boolean }): ModelCapability {
  if (args.groundSandbox) {
    return "sandbox";
  }
  return args.mode;
}

/**
 * Find any catalog entry by `modelName` alone, regardless of provider.
 *
 * Used by the thread-default resolution layer where the persisted column
 * is `threads.defaultModelName` (no provider). Model names are unique
 * across providers in the current catalog (no `claude-mini` overlapping
 * `gpt-mini`), so the first match is unambiguous.
 *
 * Returns `undefined` if the model name doesn't appear in the catalog —
 * the caller falls through to the capability default in that case.
 */
function findCatalogEntryByModelName(modelName: string) {
  return MODEL_CATALOG.find((entry) => entry.modelName === modelName);
}

/**
 * Resolve the model pick for a single reply.
 *
 * Total function: always returns a valid `ModelChoice` even when every
 * input source is missing or mismatched against the catalog. The fallback
 * to {@link DEFAULT_PICK_BY_CAPABILITY} guarantees we never hand the
 * gateway an unknown `(provider, modelName)` pair.
 */
export function resolveModelForReply(args: {
  mode: ChatMode;
  groundSandbox: boolean;
  /**
   * Per-message override from the queued user message
   * (`messages.provider` / `messages.modelName`). Both fields must be
   * present together to take effect — a half-set pair falls through to
   * the next layer.
   */
  overrideProvider?: LlmProvider;
  overrideModelName?: string;
  /**
   * Thread's last-picked model name (`threads.defaultModelName`). Only
   * consulted when no per-message override exists; provider is inferred
   * via catalog lookup so we never have to persist provider redundantly
   * alongside the default model name.
   */
  threadDefaultModelName?: string;
}): ModelChoice {
  const capability = pickCapability(args);

  // 1. Explicit per-message override. Already validated by the send
  // mutation; re-validate here so an out-of-band catalog change degrades
  // to the default rather than reaching the gateway with an unknown pair.
  if (args.overrideProvider !== undefined && args.overrideModelName !== undefined) {
    const entry = getCatalogEntry(args.overrideProvider, args.overrideModelName);
    if (entry) {
      return {
        provider: entry.provider,
        modelName: entry.modelName,
        reasoningEffort: entry.reasoningEffort,
        capability,
      };
    }
  }

  // 2. Thread default. Looked up by model name alone — provider is
  // inferred from the catalog so we don't have to persist it redundantly.
  if (args.threadDefaultModelName !== undefined) {
    const entry = findCatalogEntryByModelName(args.threadDefaultModelName);
    if (entry) {
      return {
        provider: entry.provider,
        modelName: entry.modelName,
        reasoningEffort: entry.reasoningEffort,
        capability,
      };
    }
  }

  // 3. Capability default. The hard-coded fallback pairing is pinned
  // against the pricing table by the unit test below.
  const fallback = DEFAULT_PICK_BY_CAPABILITY[capability];
  const fallbackEntry = getCatalogEntry(fallback.provider, fallback.modelName);
  return {
    provider: fallback.provider,
    modelName: fallback.modelName,
    reasoningEffort: fallbackEntry?.reasoningEffort,
    capability,
  };
}
