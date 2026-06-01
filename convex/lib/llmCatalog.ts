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
 *
 * `ROLE_MODELS` at the bottom of this file names every named-role
 * model in the system (internal title gen, internal eval judge,
 * per-capability default). Swapping a role's model is a one-line
 * edit here — call sites import the role rather than the literal
 * model name.
 */

import { v } from "convex/values";
import type { LlmProvider } from "./llmProvider";

/**
 * Capability tier. Routes the model picker and the future
 * thread-level capability default — a "sandbox-capable" reply needs
 * a tool-using tier; a discuss reply does not.
 *
 * `embedding` covers vector-embedding models used by the artifact
 * RAG / indexing flows. Embedding entries are never `userPickable`
 * (the composer picker filters them out) but the gateway routes
 * them through the same fairness / cost surface as generation calls
 * via `embedViaGateway`.
 */
export type ModelCapability = "sandbox" | "library" | "discuss" | "embedding";

/**
 * User-facing subset of {@link ModelCapability} — the tiers a human
 * actually picks in the composer / Generate dialog. Excludes
 * `embedding`, which is dispatched only by backend RAG / indexing
 * flows. The picker UI, the chat-mode → capability map, and the
 * public `listPickableModels` query all key on this narrower union
 * so a stray `embedding` capability can't leak into a surface that
 * doesn't expect it.
 */
export type UserPickableCapability = Exclude<ModelCapability, "embedding">;

/**
 * Reasoning effort knob. OpenAI consumes this directly as
 * `providerOptions.openai.reasoningEffort`. Anthropic maps `none`
 * to disabled thinking and the remaining values to thinking-budget
 * token counts in `buildProviderOptions`. The per-message override
 * flows through `messages.reasoningEffort` and
 * `LlmGenerateArgs.reasoningEffort`.
 */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * Convex validator for {@link ReasoningEffort}. Exported so the
 * schema, send mutation, and any future per-call validator stay in
 * sync with the type union — change either side here, the other
 * still compiles against the same literal set.
 */
export const reasoningEffortValidator = v.union(
  v.literal("none"),
  v.literal("minimal"),
  v.literal("low"),
  v.literal("medium"),
  v.literal("high"),
  v.literal("xhigh"),
);

export interface ModelCatalogEntry {
  provider: LlmProvider;
  /**
   * Provider-native model identifier (`gpt-5.5`, `claude-opus-4-8`, …).
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
   * models. The gateway forwards this as either
   * `providerOptions.openai.reasoningEffort` (OpenAI) or as an
   * Anthropic thinking-budget mapping; see `buildProviderOptions`.
   * Per-message override (`messages.reasoningEffort`) takes priority
   * over this value via `resolveModelForReply`.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Reasoning efforts this exact `(provider, modelName)` accepts.
   * Empty / omitted for non-reasoning models. The picker, write
   * mutations, and gateway all read this list so provider/model
   * support drift is fixed in one place.
   */
  supportedReasoningEfforts?: readonly ReasoningEffort[];
  /**
   * Whether this model accepts a reasoning / extended-thinking knob
   * at all. Drives:
   *   - The reasoning-effort picker visibility in the composer
   *     (hidden when `false`).
   *   - The gateway's `buildProviderOptions` — a `false` model never
   *     gets `reasoningEffort` smuggled into `providerOptions`, so a
   *     stray override on a non-reasoning model is dropped silently
   *     rather than landing as an SDK rejection.
   *
   * Distinct from `reasoningEffort` itself (which is the *default*
   * effort): an Anthropic reasoning model carries
   * `supportsReasoning: true` with `reasoningEffort: undefined` so
   * the catalog stays OpenAI-shaped while the gateway still
   * recognises the model as reasoning-capable.
   */
  supportsReasoning: boolean;
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
  //
  // GPT-5.5 is the latest sandbox-tier model; GPT-5.4 Mini remains
  // the fastest user-pickable small reasoning tier. GPT-5.4 Nano stays internal-only
  // (`userPickable: false`) because the picker should not surface a
  // model optimized for lightweight internal utility work.
  {
    provider: "openai",
    modelName: "gpt-5.5",
    displayName: "GPT-5.5",
    capability: "sandbox",
    reasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high"],
    supportsReasoning: true,
    supportsTools: true,
    contextWindow: 1_050_000,
    userPickable: true,
  },
  {
    provider: "openai",
    modelName: "gpt-5.4-mini",
    displayName: "GPT-5.4 Mini",
    capability: "discuss",
    reasoningEffort: "low",
    supportedReasoningEfforts: ["low", "medium", "high"],
    supportsReasoning: true,
    supportsTools: true,
    contextWindow: 400_000,
    userPickable: true,
  },
  {
    provider: "openai",
    modelName: "gpt-5.4-nano",
    displayName: "GPT-5.4 Nano",
    capability: "discuss",
    // The nano tier is kept internal-only for ultra-cheap eval-judge
    // and lightweight title-generation flows.
    supportedReasoningEfforts: ["low", "medium", "high"],
    supportsReasoning: true,
    supportsTools: true,
    contextWindow: 400_000,
    userPickable: false,
  },
  // === Anthropic === Claude 4 family.
  //
  // Opus 4.8 and Haiku 4.5 support extended thinking. The
  // `supportsReasoning` flag drives both the picker's reasoning-
  // effort visibility and the gateway's Anthropic thinking-budget
  // wiring.
  {
    provider: "anthropic",
    modelName: "claude-opus-4-8",
    displayName: "Claude Opus 4.8",
    capability: "sandbox",
    supportedReasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
    supportsReasoning: true,
    supportsTools: true,
    contextWindow: 1_000_000,
    userPickable: true,
  },
  {
    provider: "anthropic",
    modelName: "claude-opus-4-7",
    displayName: "Claude Opus 4.7",
    capability: "sandbox",
    supportedReasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
    supportsReasoning: true,
    supportsTools: true,
    contextWindow: 200_000,
    userPickable: false,
  },
  {
    provider: "anthropic",
    modelName: "claude-haiku-4-5",
    displayName: "Claude Haiku 4.5",
    capability: "discuss",
    supportedReasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
    supportsReasoning: true,
    supportsTools: true,
    contextWindow: 200_000,
    userPickable: true,
  },
  // === OpenAI embeddings === Wired into the artifact indexing /
  // RAG retrieval flows via `embedViaGateway`. `userPickable: false`
  // — the composer picker hides the embedding tier; only the
  // backend gateway dispatches to these entries.
  //
  // `contextWindow` reflects OpenAI's per-request input token cap
  // for the embedding endpoint (8192 for `text-embedding-3-*`),
  // not a conversational context — informational here, not
  // enforced by the gateway.
  {
    provider: "openai",
    modelName: "text-embedding-3-small",
    displayName: "OpenAI Embedding 3 (small)",
    capability: "embedding",
    supportsReasoning: false,
    supportsTools: false,
    contextWindow: 8_192,
    userPickable: false,
  },
  {
    provider: "openai",
    modelName: "text-embedding-3-large",
    displayName: "OpenAI Embedding 3 (large)",
    capability: "embedding",
    supportsReasoning: false,
    supportsTools: false,
    contextWindow: 8_192,
    userPickable: false,
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
 *   - `provider` — used by the composer when the thread is locked to a
 *     provider (`threads.lockedProvider`). Filters out the other provider's
 *     group entirely.
 *   - `capability` — used by surfaces that only support a tier
 *     (e.g. the standalone System Design dialog shows `sandbox`-
 *     tier models because the generator drives tool use).
 *
 * `userPickable: false` entries are always excluded from this
 * function's output — they're internal-only by definition.
 */
export function listPickableModels(opts?: {
  provider?: LlmProvider;
  capability?: UserPickableCapability;
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

/**
 * True iff the catalogued model accepts the requested reasoning
 * effort. Undefined effort is always valid because it means "use the
 * model's catalog default / provider default".
 */
export function isSupportedReasoningEffort(
  provider: LlmProvider,
  modelName: string,
  reasoningEffort: ReasoningEffort | undefined,
): boolean {
  if (reasoningEffort === undefined) {
    return true;
  }
  const entry = getCatalogEntry(provider, modelName);
  if (!entry?.supportsReasoning) {
    return false;
  }
  return (entry.supportedReasoningEfforts ?? []).includes(reasoningEffort);
}

/**
 * Named role → catalog pair. Every internal call site that used to
 * carry a hardcoded `("openai", "gpt-5-...")` literal now imports
 * the role it represents, so swapping the model for that role is a
 * one-line edit here. The catalog-validity test asserts every entry
 * resolves to a real catalog row — a swap that forgets to land the
 * matching catalog entry fails the suite, not production.
 *
 * `defaultSandbox` / `defaultLibrary` / `defaultDiscuss` are the
 * per-capability fallbacks consumed by `resolveModelForReply`'s
 * third layer. `defaultSystemDesign` is the System Design generator
 * default. `internalTitle` / `internalJudge` are the
 * `userPickable: false` workhorses behind thread-title gen and the
 * eval judge.
 */
export const ROLE_MODELS = {
  internalTitle: { provider: "openai", modelName: "gpt-5.4-nano" },
  internalJudge: { provider: "openai", modelName: "gpt-5.4-nano" },
  defaultSandbox: { provider: "openai", modelName: "gpt-5.5" },
  defaultDiscuss: { provider: "openai", modelName: "gpt-5.4-mini" },
  defaultLibrary: { provider: "openai", modelName: "gpt-5.4-mini" },
  defaultSystemDesign: { provider: "openai", modelName: "gpt-5.5" },
} as const satisfies Record<string, { provider: LlmProvider; modelName: string }>;
