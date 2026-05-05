/**
 * Plan 11 — per-mode OpenAI model selection.
 *
 * Each chat mode reaches the model through this resolver so the choice of
 * underlying model (and therefore the price tier and reasoning strength)
 * stays out of `generation.ts`'s control flow. Resolution order, first
 * defined wins:
 *
 *   1. **Mode-specific override env var** — `OPENAI_MODEL_SANDBOX`,
 *      `OPENAI_MODEL_DOCS`, `OPENAI_MODEL_DISCUSS`. These let an operator
 *      pin a tier independently per mode (e.g. test a new model in
 *      sandbox without changing discuss/docs spend) without code changes.
 *   2. **Legacy global override** — `OPENAI_MODEL`. Kept so an operator
 *      who pinned the previous global default during the Plan 04-10
 *      rollout window keeps that behavior across all three modes until
 *      they explicitly opt into the per-mode split. Removing this fallback
 *      would silently re-route their replies onto the new defaults.
 *   3. **Per-mode hard-coded default**. Sized so `OPENAI_API_KEY` alone
 *      is enough for the system to "just work": sandbox gets the full
 *      tier (it drives tool use and benefits from stronger reasoning);
 *      docs / discuss get the mini tier (text-only, latency-sensitive,
 *      and the lighter cost profile suits the per-message volume).
 *
 * The defaults below match the pricing table snapshot in
 * `convex/lib/openaiPricing.ts`. The pairing matters: an unknown model
 * silently produces `costUsd === undefined` from `estimateCostUsd`,
 * which Plan 10's daily-cap settlement treats as "no cost recorded" —
 * so a default that drifts out of the pricing table would let users
 * spend without ever charging the cap. The colocated test in
 * `modelSelection.test.ts` asserts the pricing/default pairing as a
 * compile-time-style invariant.
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
 *   - Plan 13's rollout knobs (and future per-workspace model
 *     overrides) will hook into this resolver rather than pollute
 *     `generation.ts` with conditional model selection.
 */

import type { ChatMode } from "../chatModeResolver";

/**
 * Per-mode default model identifier. Wired to the pricing table in
 * `convex/lib/openaiPricing.ts`; if a default is ever changed, update
 * the pricing table in the same commit and re-run
 * `convex/chat/modelSelection.test.ts` to verify the pairing.
 *
 * Sandbox uses the full GPT-5 tier because tool-driven replies benefit
 * from stronger reasoning (the model has to plan a `list_dir` →
 * `read_file` → answer trajectory under a step budget); discuss / docs
 * use the mini tier since they are single-step text replies where the
 * mini tier is empirically indistinguishable on this workload while
 * costing ~5–8× less.
 */
const DEFAULT_MODEL_BY_MODE: Record<ChatMode, string> = {
  sandbox: "gpt-5",
  docs: "gpt-5-mini",
  discuss: "gpt-5-mini",
};

/**
 * Mode → mode-specific override env var name. Kept as a typed
 * `Record<ChatMode, string>` so adding a new `ChatMode` literal forces
 * a compile error here, mirroring the exhaustiveness pattern used in
 * `convex/chat/prompting.ts:SYSTEM_PROMPTS`.
 */
const MODE_ENV_VAR: Record<ChatMode, string> = {
  sandbox: "OPENAI_MODEL_SANDBOX",
  docs: "OPENAI_MODEL_DOCS",
  discuss: "OPENAI_MODEL_DISCUSS",
};

/**
 * Read an env var with the trim-or-undefined shape every Plan 11 / 13
 * env knob expects. A missing variable, an empty string, or a
 * whitespace-only string all produce `undefined` so the resolver can
 * fall through to the next layer instead of selecting an empty model
 * name (which would fail at the AI SDK boundary with a confusing
 * "model: '' not found" error).
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
 * Resolve the OpenAI model identifier to use for a single reply.
 *
 * Pure function over `process.env` and the {@link DEFAULT_MODEL_BY_MODE}
 * table. Safe to call from both the success path (during `streamText`
 * setup) and the catch path (when reading partial usage post-throw):
 * the result is deterministic for a given env snapshot and never
 * throws — a missing API key is detected upstream by `generation.ts`
 * before this resolver is ever consulted.
 */
export function resolveModelForMode(mode: ChatMode): string {
  const override = readEnv(MODE_ENV_VAR[mode]);
  if (override !== undefined) {
    return override;
  }
  const legacy = readEnv("OPENAI_MODEL");
  if (legacy !== undefined) {
    return legacy;
  }
  return DEFAULT_MODEL_BY_MODE[mode];
}
