/**
 * Resolve `(provider, modelName)` for a single chat reply.
 *
 * The resolver is a thin pass-through. It runs after `chat.send.sendMessage`
 * has already validated the user's pick against {@link MODEL_CATALOG}; this
 * module's job is only to collapse the (per-message override, thread default,
 * capability default) triple into a single `ModelChoice`. The picker UI and
 * the env-driven operator escape hatch live elsewhere:
 *
 *   - The picker UI lives in `src/components/ai-elements/prompt-input-model-picker.tsx`.
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
import {
  catalogCapabilityForPickableSurface,
  getCatalogEntry,
  isSupportedReasoningEffort,
  isUserPickableModel,
  MODEL_CATALOG,
  ROLE_MODELS,
  type ModelCapability,
  type ReasoningEffort,
  type UserPickableModelCatalogEntry,
  type UserPickableCapability,
} from "../lib/llmCatalog";
import type { LlmProvider } from "../lib/llmProvider";

// Re-exported for the chat / generation call sites so they don't have to
// chase the canonical location at the same time the multi-provider
// catalog lands.
export type { ModelCapability, ReasoningEffort, UserPickableCapability };

/**
 * Resolved pick handed to {@link generateViaGateway} / {@link streamViaGateway}.
 * Carries the picked `(provider, modelName)` pair alongside its catalog-
 * derived `reasoningEffort` and the resolved model's catalog `capability`
 * tier so the gateway can wire `providerOptions` without re-deriving either.
 *
 * `capability` is a user-facing generation tier (`sandbox` / `library` /
 * `discuss`) — embedding picks are dispatched separately via
 * `embedViaGateway` and never flow through this type.
 */
export type ModelChoice = {
  provider: LlmProvider;
  modelName: string;
  /** `undefined` for non-reasoning models — gateway omits the provider-specific knob. */
  reasoningEffort: ReasoningEffort | undefined;
  capability: UserPickableCapability;
};

/**
 * Capability → `(provider, model)` default. Derived from {@link ROLE_MODELS}
 * to ensure the pricing-coverage test in `modelSelection.test.ts` stays
 * in sync with the catalog. Every default here must have a catalog entry
 * AND a pricing row, otherwise the daily cost cap settlement silently
 * degrades to "no cost recorded" (`estimateCostUsd` returns `undefined`
 * for unknown pairs).
 *
 * Defaults are OpenAI because `OPENAI_API_KEY` is the only env var the
 * bootstrap docs require; Anthropic is opt-in via the composer picker.
 */
const DEFAULT_PICK_BY_CAPABILITY: Record<UserPickableCapability, { provider: LlmProvider; modelName: string }> = {
  sandbox: ROLE_MODELS.defaultSandbox,
  library: ROLE_MODELS.defaultLibrary,
  discuss: ROLE_MODELS.defaultDiscuss,
};

/**
 * Map a `(mode, groundSandbox)` pair to its capability tier. Sandbox
 * grounding wins over the underlying mode because the tool-use trajectory
 * is the dominant cost signal — a sandbox-grounded Discuss reply lands on
 * the heavier `sandbox` tier regardless of the surface name.
 */
export function pickCapability(args: { mode: ChatMode; groundSandbox: boolean }): UserPickableCapability {
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
function findUserPickableCatalogEntryByModelName(modelName: string): UserPickableModelCatalogEntry | undefined {
  return MODEL_CATALOG.find(
    (entry): entry is UserPickableModelCatalogEntry =>
      entry.modelName === modelName && isUserPickableModel(entry.provider, entry.modelName),
  );
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
   * Per-message reasoning-effort override from the queued user message
   * (`messages.reasoningEffort`). When set on a `supportsReasoning`
   * model it wins over the catalog entry's default — the user picked
   * an intensity for *this* send. A reasoning override on a non-
   * reasoning model is dropped (the catalog entry's `undefined`
   * default stays in effect) so the gateway doesn't smuggle a knob
   * the provider would reject.
   */
  overrideReasoningEffort?: ReasoningEffort;
  /**
   * Thread's last-picked model name (`threads.defaultModelName`). Only
   * consulted when no per-message override exists; provider is inferred
   * via catalog lookup so we never have to persist provider redundantly
   * alongside the default model name.
   */
  threadDefaultModelName?: string;
  /**
   * `threads.lockedProvider` for the thread being replied into. When set,
   * the capability-default fallback picks from this provider's catalog
   * entries instead of {@link DEFAULT_PICK_BY_CAPABILITY} so provider-level
   * cached thread context stays coherent.
   */
  lockedProvider?: LlmProvider;
}): ModelChoice {
  const capability = pickCapability(args);
  const catalogCapability = catalogCapabilityForPickableSurface(capability);

  // Per-message override of reasoning effort. Applied at every layer
  // exit so the user's per-send intent survives whichever
  // (provider, model) ends up resolved. Dropped silently on a
  // non-reasoning model — the gateway would otherwise reject the
  // option as unknown.
  const applyReasoningOverride = (entry: {
    provider: LlmProvider;
    modelName: string;
    reasoningEffort?: ReasoningEffort;
    supportsReasoning: boolean;
  }) =>
    entry.supportsReasoning &&
    args.overrideReasoningEffort !== undefined &&
    isSupportedReasoningEffort(entry.provider, entry.modelName, args.overrideReasoningEffort)
      ? args.overrideReasoningEffort
      : entry.reasoningEffort;

  // 1. Explicit per-message override. Already validated by the send
  // mutation; re-validate here so an out-of-band catalog change degrades
  // to the default rather than reaching the gateway with an unknown pair.
  if (args.overrideProvider !== undefined && args.overrideModelName !== undefined) {
    const entry = getCatalogEntry(args.overrideProvider, args.overrideModelName);
    if (entry && isUserPickableModel(entry.provider, entry.modelName) && entry.capability !== "embedding") {
      return {
        provider: entry.provider,
        modelName: entry.modelName,
        reasoningEffort: applyReasoningOverride(entry),
        capability: entry.capability,
      };
    }
  }

  // 2. Thread default. Looked up by model name alone — provider is
  // inferred from the catalog so we don't have to persist it redundantly.
  if (args.threadDefaultModelName !== undefined) {
    const entry = findUserPickableCatalogEntryByModelName(args.threadDefaultModelName);
    if (entry) {
      return {
        provider: entry.provider,
        modelName: entry.modelName,
        reasoningEffort: applyReasoningOverride(entry),
        capability: entry.capability,
      };
    }
  }

  // 3. Capability default. The hard-coded fallback pairing is pinned
  // against the pricing table by the unit test below. When the thread is
  // locked to a different provider, prefer that provider's capability-tier
  // entry so the resolved pick survives the lock check in `sendMessage`.
  const fallback = DEFAULT_PICK_BY_CAPABILITY[capability];
  if (args.lockedProvider !== undefined && args.lockedProvider !== fallback.provider) {
    const lockedFallback = MODEL_CATALOG.find(
      (entry) =>
        entry.provider === args.lockedProvider &&
        entry.capability === catalogCapability &&
        isUserPickableModel(entry.provider, entry.modelName, catalogCapability),
    );
    if (lockedFallback) {
      return {
        provider: lockedFallback.provider,
        modelName: lockedFallback.modelName,
        reasoningEffort: applyReasoningOverride(lockedFallback),
        capability: catalogCapability,
      };
    }
  }
  const fallbackEntry = getCatalogEntry(fallback.provider, fallback.modelName);
  return {
    provider: fallback.provider,
    modelName: fallback.modelName,
    reasoningEffort: fallbackEntry !== undefined ? applyReasoningOverride(fallbackEntry) : undefined,
    capability: catalogCapability,
  };
}
