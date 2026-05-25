/**
 * Capability-keyed OpenAI model selection.
 *
 * Every reply path reaches the model through this resolver so the choice of
 * underlying model (and therefore the price tier and reasoning strength)
 * stays out of `generation.ts`'s control flow. The resolver keys on a
 * capability tier rather than the mode literal because two replies in the
 * same mode can need very different tiers — a Sandbox-grounded Discuss
 * reply drives tool use just like the retired Lab mode did, while an
 * ungrounded Discuss reply is a single-step text completion.
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
 *   - Future per-workspace / per-user model overrides hook into this
 *     resolver rather than pollute `generation.ts` with conditional
 *     model selection.
 */

import type { ChatMode } from "../chatModeResolver";

/**
 * Capability tiers the resolver routes replies through. Distinct from
 * {@link ChatMode} because the (mode, groundSandbox) pair maps onto these
 * tiers — sandbox-grounded Discuss and the system design generator both
 * land on `sandbox` even though their `mode` differs.
 */
export type ModelCapability = "sandbox" | "library" | "discuss";

const DEFAULT_MODEL_BY_CAPABILITY: Record<ModelCapability, string> = {
  sandbox: "gpt-5",
  library: "gpt-5-mini",
  discuss: "gpt-5-mini",
};

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
 * reply behaves like the retired Lab mode and should land on the heavier
 * tier regardless of the surface name.
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
 */
export function resolveModelForReply(args: { mode: ChatMode; groundSandbox: boolean }): string {
  const capability = pickCapability(args);
  const override = readEnv(CAPABILITY_ENV_VAR[capability]);
  if (override !== undefined) {
    return override;
  }
  const global = readEnv("OPENAI_MODEL");
  if (global !== undefined) {
    return global;
  }
  return DEFAULT_MODEL_BY_CAPABILITY[capability];
}
