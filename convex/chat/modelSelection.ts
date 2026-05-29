/**
 * Capability-keyed OpenAI model selection.
 *
 * Every reply path reaches the model through this resolver so the choice of
 * underlying model (and therefore the price tier and reasoning strength)
 * stays out of `generation.ts`'s control flow. The resolver keys on a
 * capability tier rather than the mode literal because two replies in the
 * same mode can need very different tiers — a Sandbox-grounded Discuss
 * reply drives tool use, while an ungrounded Discuss reply is a
 * single-step text completion.
 *
 * Capability tiers:
 *
 *   - `sandbox` — tool-using replies. Sandbox-grounded Discuss + the
 *                 system design generator. Default `gpt-5` because tool
 *                 trajectories benefit from stronger reasoning.
 *   - `library` — RAG over user artifacts. Default `gpt-5-mini`.
 *   - `discuss` — ungrounded text replies. Default `gpt-5-mini`.
 *
 * Resolution order (first defined wins):
 *
 *   1. Capability-specific override env var — `OPENAI_MODEL_SANDBOX`,
 *      `OPENAI_MODEL_LIBRARY`, `OPENAI_MODEL_DISCUSS`. Lets an operator
 *      pin a tier independently per capability (e.g. test a new model in
 *      sandbox without changing discuss/library spend) without code
 *      changes.
 *   2. Global override — `OPENAI_MODEL`. Single env var that applies to
 *      every capability; kept so an operator who wants one tier across
 *      the board can set it once instead of three times. The per-
 *      capability override above wins when both are set.
 *   3. Per-capability hard-coded default. Sized so `OPENAI_API_KEY`
 *      alone is enough for the system to "just work".
 *
 * The defaults below match the pricing table snapshot in
 * `convex/lib/openaiPricing.ts`. The pairing matters: an unknown model
 * silently produces `costUsd === undefined` from `estimateCostUsd`,
 * which the daily-cap settlement treats as "no cost recorded" — so a
 * default that drifts out of the pricing table would let users spend
 * without ever charging the cap. The colocated test in
 * `modelSelection.test.ts` asserts the pricing/default pairing.
 *
 * Lives in its own module (rather than inlined in `generation.ts`) for
 * three reasons:
 *
 *   - It is a pure, env-driven function: testable without any Convex
 *     runtime, and we want to pin the resolution order with table-driven
 *     unit tests.
 *   - Both the success path (`replyContext.mode` known) and the failure
 *     path (catch block, possibly before `replyContext` resolved) need
 *     the same model-name shape, so centralizing keeps them consistent.
 *   - Future per-repository / per-user model overrides hook into this
 *     resolver rather than pollute `generation.ts` with conditional
 *     model selection.
 */

import type { ChatMode } from "../lib/chatMode";

/**
 * Capability tiers the resolver routes replies through. Distinct from
 * {@link ChatMode} because the (mode, groundSandbox) pair maps onto these
 * tiers — sandbox-grounded Discuss and the system design generator both
 * land on `sandbox` even though their `mode` differs.
 */
export type ModelCapability = "sandbox" | "library" | "discuss";

/**
 * OpenAI reasoning effort knob. Mirrors the provider's accepted values for
 * `providerOptions.openai.reasoningEffort`.
 */
export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

/**
 * Resolver output. Carries the picked model name alongside its reasoning
 * capability so `streamText` can wire `providerOptions` without re-deriving
 * the effort from the model name.
 */
export type ModelChoice = {
  name: string;
  /** Undefined when the model doesn't support reasoning. */
  reasoningEffort: ReasoningEffort | undefined;
};

const DEFAULT_MODEL_BY_CAPABILITY: Record<ModelCapability, string> = {
  sandbox: "gpt-5",
  library: "gpt-5-mini",
  discuss: "gpt-5-mini",
};

/**
 * Per-model-family reasoning default. Keys are family prefixes; a model
 * matches if its name equals the key OR begins with `<key>-` (boundary at
 * hyphen so `gpt-5` doesn't match a hypothetical `gpt-50`). Longest
 * matching prefix wins, so `gpt-5-mini-2026-01-15` resolves to the
 * `gpt-5-mini` row rather than the `gpt-5` row. A model that doesn't
 * match any prefix has no reasoning support — adding a new reasoning-
 * capable family means adding it here in the same change that introduces
 * it to the pricing table (`convex/lib/openaiPricing.ts`).
 *
 * Family matching (not exact id) so operator-pinned snapshot names like
 * `gpt-5-2026-01-15` keep the family's reasoning default instead of
 * silently degrading to no reasoning at all.
 *
 * Defaults are chosen per-family, NOT per-tier:
 *   - `gpt-5`      → `medium` — matches OpenAI's API default; the
 *                    sandbox tier uses this family and tool trajectories
 *                    (plan → call → re-plan) benefit from real thought.
 *   - `gpt-5-mini` → `low`    — the lighter tier used for library + discuss;
 *                    fast text replies don't justify deeper effort.
 *
 * To change a default permanently, edit this table — the diff is the
 * audit trail. To suppress reasoning for one tier at runtime, point
 * that tier at a non-reasoning model via `OPENAI_MODEL_<TIER>`.
 */
const MODEL_REASONING_DEFAULT: Record<string, ReasoningEffort> = {
  "gpt-5": "medium",
  "gpt-5-mini": "low",
};

/**
 * Resolve a model name to its family's reasoning effort. Longest matching
 * prefix wins so `gpt-5-mini-2026-01-15` lands on `gpt-5-mini` rather than
 * `gpt-5`. Returns `undefined` when no family matches — the caller treats
 * that as "non-reasoning model" and omits `providerOptions.openai.reasoningEffort`.
 */
function resolveReasoningEffort(modelName: string): ReasoningEffort | undefined {
  let bestKey: string | undefined;
  let bestEffort: ReasoningEffort | undefined;
  for (const [key, effort] of Object.entries(MODEL_REASONING_DEFAULT)) {
    if (modelName === key || modelName.startsWith(`${key}-`)) {
      if (bestKey === undefined || key.length > bestKey.length) {
        bestKey = key;
        bestEffort = effort;
      }
    }
  }
  return bestEffort;
}

/**
 * Capability → capability-specific override env var name. Kept as a typed
 * `Record<ModelCapability, string>` so adding a new capability literal
 * forces a compile error here.
 */
const CAPABILITY_ENV_VAR: Record<ModelCapability, string> = {
  sandbox: "OPENAI_MODEL_SANDBOX",
  library: "OPENAI_MODEL_LIBRARY",
  discuss: "OPENAI_MODEL_DISCUSS",
};

/**
 * Read an env var with the trim-or-undefined shape every env knob expects.
 * A missing variable, an empty string, or a whitespace-only string all
 * produce `undefined` so the resolver can fall through to the next layer
 * instead of selecting an empty model name (which would fail at the AI
 * SDK boundary with a confusing "model: '' not found" error).
 */
function readEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Map a (mode, groundSandbox) pair to its capability tier. Sandbox
 * grounding wins over the underlying mode because the tool-use
 * trajectory is the dominant cost signal — a sandbox-grounded Discuss
 * reply lands on the heavier `sandbox` tier regardless of the surface
 * name.
 */
export function pickCapability(args: { mode: ChatMode; groundSandbox: boolean }): ModelCapability {
  if (args.groundSandbox) {
    return "sandbox";
  }
  return args.mode;
}

/**
 * Resolve the OpenAI model identifier to use for a single reply.
 *
 * Pure function over `process.env` and the
 * {@link DEFAULT_MODEL_BY_CAPABILITY} table. Safe to call from both the
 * success path (during `streamText` setup) and the catch path (when
 * reading partial usage post-throw): the result is deterministic for a
 * given env snapshot and never throws — a missing API key is detected
 * upstream by `generation.ts` before this resolver is ever consulted.
 *
 * The returned `reasoningEffort` is keyed off the *resolved* model name,
 * not the capability tier — picking `gpt-5` always means "reasoning at
 * the gpt-5 default effort", and overriding the env to a non-reasoning
 * model (`OPENAI_MODEL_DISCUSS=gpt-4o`) returns `undefined` so the
 * generation path can omit `providerOptions.openai.reasoningEffort`
 * entirely. See {@link MODEL_REASONING_DEFAULT} for the per-model table.
 */
export function resolveModelForReply(args: { mode: ChatMode; groundSandbox: boolean }): ModelChoice {
  const capability = pickCapability(args);
  const override = readEnv(CAPABILITY_ENV_VAR[capability]);
  const name = override ?? readEnv("OPENAI_MODEL") ?? DEFAULT_MODEL_BY_CAPABILITY[capability];
  return {
    name,
    reasoningEffort: resolveReasoningEffort(name),
  };
}
