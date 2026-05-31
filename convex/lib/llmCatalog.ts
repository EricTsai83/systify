/**
 * Single source of truth for which `(provider, model)` pairs systify
 * supports. The catalog drives:
 *
 *   1. The composer's model picker (frontend filters `userPickable: true`).
 *   2. The backend `chat.send` mutation that validates a user-picked
 *      `(provider, modelName)` pair before queueing a reply.
 *   3. The `llmGateway` dispatcher (asserts the pair is valid before
 *      acquiring rate-limit slots or invoking the SDK).
 *   4. The pricing-table coverage test (`llmPricing.test.ts` /
 *      `llmCatalog.test.ts`) — every catalog entry must have a
 *      pricing row.
 *
 * Adding a model is a one-line addition here. Removing one is a
 * one-line deletion plus a follow-up audit:
 *
 *   - Any persisted row referencing the removed `modelName` keeps
 *     validating (the union accepts arbitrary strings via
 *     `v.string()`); the *gateway* will refuse to make a new call
 *     against the missing entry.
 *
 * Provider strings come from `llmProvider.ts`; `ModelCapability` and
 * `ReasoningEffort` are defined HERE so the catalog can be self-
 * describing without a circular import through `chat/modelSelection`.
 *
 * `userPickable: false` is reserved for internal-only models (eval
 * judge, future utility models). The picker filters them out; the
 * gateway still accepts them.
 */

import type { LlmProvider } from "./llmProvider";

/**
 * Capability tier. Routes the model picker and the future
 * thread-level capability default — a "sandbox-capable" reply needs
 * a tool-using tier; a discuss reply does not.
 */
export type ModelCapability = "sandbox" | "library" | "discuss";

/**
 * OpenAI reasoning effort knob. Mirrors the provider's accepted
 * values for `providerOptions.openai.reasoningEffort`. Anthropic
 * exposes a different "thinking" budget — we model that separately
 * (PR-A3) and keep this type OpenAI-shaped for clarity.
 */
export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

export interface ModelCatalogEntry {
  provider: LlmProvider;
  /**
   * Provider-native model identifier (`gpt-5`, `claude-opus-4-8`, …).
   * Persisted to `messages.modelName`, `threads.defaultModelName`,
   * `jobs.modelName`. Never rename a value — only add new ones.
   */
  modelName: string;
  /** Human-readable label rendered by the model picker. */
  displayName: string;
  /**
   * Default capability tier this model is wired for. The
   * `listPickableModels({ capability })` filter uses this to show
   * appropriate options per surface (e.g. sandbox composer hides
   * `discuss`-only nano tier).
   */
  capability: ModelCapability;
  /**
   * Default reasoning effort baked into the gateway dispatch when
   * the call goes through this model. `undefined` for non-reasoning
   * models. The gateway forwards this as `providerOptions.openai.
   * reasoningEffort` (OpenAI). Anthropic ignores it today; PR-A3
   * adds a separate thinking-budget knob.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Whether the model supports tool use. Drives the
   * `stopWhen: stepCountIs(...)` decision at the call site —
   * `false` shortcuts to a single text completion.
   */
  supportsTools: boolean;
  /**
   * Provider-published context window in tokens. Informational
   * today; used by the planning UI to warn before a long-context
   * call is attempted. Not enforced by the gateway.
   */
  contextWindow: number;
  /**
   * `false` hides the entry from the composer picker but keeps it
   * usable internally (eval judge, future utility flows). The
   * gateway accepts any catalog entry regardless of this flag.
   */
  userPickable: boolean;
}

export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  // === OpenAI === GPT-5 family.
  {
    provider: "openai",
    modelName: "gpt-5",
    displayName: "GPT-5",
    capability: "sandbox",
    reasoningEffort: "medium",
    supportsTools: true,
    contextWindow: 200_000,
    userPickable: true,
  },
  {
    provider: "openai",
    modelName: "gpt-5-mini",
    displayName: "GPT-5 Mini",
    capability: "discuss",
    reasoningEffort: "low",
    supportsTools: true,
    contextWindow: 200_000,
    userPickable: true,
  },
  {
    provider: "openai",
    modelName: "gpt-5-nano",
    displayName: "GPT-5 Nano",
    capability: "discuss",
    reasoningEffort: "minimal",
    // The nano tier intentionally drops tool support; we keep it
    // for ultra-cheap eval-judge and lightweight discuss flows.
    supportsTools: false,
    contextWindow: 128_000,
    userPickable: true,
  },
  // === Anthropic === Claude 4 family.
  {
    provider: "anthropic",
    modelName: "claude-opus-4-8",
    displayName: "Claude Opus 4.8",
    capability: "sandbox",
    supportsTools: true,
    contextWindow: 200_000,
    userPickable: true,
  },
  {
    provider: "anthropic",
    modelName: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    capability: "discuss",
    supportsTools: true,
    contextWindow: 200_000,
    userPickable: true,
  },
  {
    provider: "anthropic",
    modelName: "claude-haiku-4-5",
    displayName: "Claude Haiku 4.5",
    capability: "discuss",
    supportsTools: true,
    contextWindow: 200_000,
    userPickable: true,
  },
];

/**
 * Return the catalog entry for a `(provider, modelName)` pair, or
 * `undefined` when the pair is not catalogued.
 *
 * Lookup is linear; the catalog is small (~10 entries) and JS engines
 * optimise short array scans aggressively, so a `Map` would be cost
 * without benefit. If the catalog grows past ~50 entries, switch to
 * a `Map` keyed by `${provider}:${modelName}`.
 */
export function getCatalogEntry(provider: LlmProvider, modelName: string): ModelCatalogEntry | undefined {
  return MODEL_CATALOG.find((entry) => entry.provider === provider && entry.modelName === modelName);
}

/**
 * Filter the catalog to entries the picker should surface. Both
 * filters compose:
 *
 *   - `provider` — used by the composer when the thread is locked
 *     to a provider (`threads.lockedProvider`). Filters out the
 *     other provider's group entirely.
 *   - `capability` — used by surfaces that only support a tier
 *     (e.g. the standalone System Design dialog shows `sandbox`-
 *     tier models because the generator drives tool use).
 *
 * `userPickable: false` entries are always excluded from this
 * function's output — they're internal-only by definition.
 */
export function listPickableModels(opts?: {
  provider?: LlmProvider;
  capability?: ModelCapability;
}): ModelCatalogEntry[] {
  return MODEL_CATALOG.filter((entry) => {
    if (!entry.userPickable) return false;
    if (opts?.provider !== undefined && entry.provider !== opts.provider) return false;
    if (opts?.capability !== undefined && entry.capability !== opts.capability) return false;
    return true;
  });
}

/**
 * True iff `(provider, modelName)` is a valid catalog entry. Used
 * by the chat-send mutation to reject a fabricated picker payload
 * before any side-effect lands.
 *
 * Returns `true` for non-`userPickable` entries too — internal flows
 * (eval judge) need to call the gateway with non-pickable models.
 */
export function isValidPick(provider: LlmProvider, modelName: string): boolean {
  return getCatalogEntry(provider, modelName) !== undefined;
}
