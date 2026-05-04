/**
 * ChatModeResolver — pure resolver mapping (hasAttachedRepo, sandboxStatus,
 * sandboxFeatureGate) to (availableModes, defaultMode, disabledReasons).
 *
 * Single source of truth for chat-mode availability used by both the UI mode
 * selector and the `chat.sendMessage` / `chat.createThread` validators on the
 * backend. The `ChatMode` literals here are the persisted DB enum on
 * `threads.mode` and `messages.mode`; the UI labels ("General Chat" /
 * "Design Docs" / "Sandbox") are deliberately decoupled from these literals
 * so user-facing copy can evolve without a schema migration. Log lines stay
 * stable on `'discuss' | 'docs' | 'sandbox'` — no legacy quick/deep aliasing.
 *
 * Mode semantics (PRD #19, Architectural reversal):
 *   - `discuss`  — LLM training only; no repo, no sandbox. Pre-design talk.
 *   - `docs`     — RAG over user-produced artifacts (ADRs, diagrams, analyses)
 *                  for the attached repository.
 *   - `sandbox`  — live filesystem + execution in a Daytona sandbox; the
 *                  canonical source of truth for current code state.
 *
 * Design choices:
 *   - `defaultMode` never auto-selects `'sandbox'` even when a sandbox is
 *     ready. Sandbox mode is the most expensive (sandbox compute + slower
 *     end-to-end) so it is opt-in; defaulting to it would auto-spend sandbox
 *     quota on every new thread.
 *   - When the repository is not attached, `disabledReasons` still carries an
 *     unlock hint for `docs` and `sandbox` so the UI can render the tooltip
 *     promised by US 14 ("disabled modes show a tooltip explaining how to
 *     unlock them"). A mode that is in `disabledReasons` is, by construction,
 *     not in `availableModes`.
 *   - The Plan-04 feature gate (`sandboxFeatureGate`) is layered *on top* of
 *     the (repo, sandbox-status) resolution: when the gate is closed the
 *     resolver removes `sandbox` from `availableModes` regardless of the
 *     underlying sandbox lifecycle. The gate's tooltip wins over the lifecycle
 *     tooltip because "this mode is in private beta" is the more actionable
 *     signal — provisioning a sandbox would not unlock the mode for a viewer
 *     who isn't on the allowlist. Env reads stay at the *call site*; the
 *     resolver only consumes the precomputed gate so it remains a pure
 *     function (trivially testable, no `process.env` coupling).
 */

import type { SandboxFeatureGate } from "./lib/sandboxFeatureFlag";

export type ChatMode = "discuss" | "docs" | "sandbox";

export type ChatModeSandboxStatus = "none" | "provisioning" | "ready" | "expired" | "failed";

export interface ChatModeResolution {
  availableModes: ChatMode[];
  defaultMode: ChatMode;
  disabledReasons: Partial<Record<ChatMode, string>>;
}

/**
 * Plan 10 — sandbox daily-cost-cap gate. Closed when the per-user OR
 * per-workspace daily spend cap is reached; the resolver removes
 * `sandbox` from `availableModes` and surfaces the cost-cap tooltip so
 * the user understands why the option is greyed out.
 *
 * Mirrors the {@link SandboxFeatureGate} discriminated-union shape on
 * purpose — the resolver layers the two gates with the same precedence
 * pattern, and presenting them as the same shape keeps the call sites
 * uniform.
 *
 * Two distinct closed `reason`s let the UI render scope-specific copy:
 * "your account" vs "this workspace" reaches different remediation
 * paths (wait until midnight UTC vs. ask a workspace admin to raise
 * the cap).
 */
export type SandboxCostCapGateReason = "user_daily_cap_exceeded" | "workspace_daily_cap_exceeded";

export type SandboxCostCapGate =
  | { readonly enabled: true }
  | {
      readonly enabled: false;
      readonly reason: SandboxCostCapGateReason;
      readonly tooltip: string;
      /**
       * Wall-clock ms epoch at which the cap resets. The UI uses this to
       * render a countdown ("Resets in 3h 12m") so the user knows when
       * sandbox mode will become available again. Distinct from
       * `tooltip` so the same gate value can drive both a static
       * dropdown label and a live-updating countdown.
       */
      readonly resetAtMs: number;
    };

/**
 * Statically-open gate for callers that have already established the feature
 * is on (e.g. resolver tests that focus on the underlying repo / sandbox
 * lifecycle logic, or one-off scripts in dev). Real per-viewer evaluation
 * lives in `lib/sandboxFeatureFlag.ts`.
 */
export const OPEN_SANDBOX_FEATURE_GATE: SandboxFeatureGate = { enabled: true };

/**
 * Plan 10 — statically-open cost-cap gate for tests that focus on
 * non-cost-related resolver behaviour. Real per-viewer evaluation lives
 * in `lib/rateLimit.ts` (`peekSandboxDailyCostForUser` /
 * `peekSandboxDailyCostForWorkspace`).
 */
export const OPEN_SANDBOX_COST_CAP_GATE: SandboxCostCapGate = { enabled: true };

// User-facing copy uses the new mode labels — "Design Docs" for `docs`, and
// "Sandbox" for `sandbox` (kept unchanged because it is already the shared
// engineering vocabulary). The resolver and the mode selector tell the user
// the same story; only the persisted column type still uses the DB literal
// `docs`.
const DISABLED_REASON_DOCS_NO_REPO = "Attach a repository to use Design Docs mode.";
const DISABLED_REASON_SANDBOX_NO_REPO = "Attach a repository and provision a sandbox to use Sandbox mode.";
const DISABLED_REASON_SANDBOX_NO_SANDBOX = "Provision a sandbox to use Sandbox mode.";
const DISABLED_REASON_SANDBOX_PROVISIONING =
  "Sandbox is provisioning — Sandbox mode will be available once it is ready.";
const DISABLED_REASON_SANDBOX_EXPIRED = "Sandbox expired — provision a new sandbox to use Sandbox mode.";
const DISABLED_REASON_SANDBOX_FAILED = "Sandbox provisioning failed — provision a new sandbox to use Sandbox mode.";

/**
 * Plan 10 — disabled-reason tooltips for the cost-cap gate. Module-scoped
 * exports so the call sites that build a {@link SandboxCostCapGate}
 * (`threadContext.ts`) and the test assertions don't drift apart.
 *
 * The tooltips advertise "Resets at midnight UTC" verbatim because that
 * is exactly when the underlying fixed-window bucket replenishes — see
 * `convex/lib/rateLimit.ts` for the bucket configuration. Promising a
 * specific time would be a lie; UTC midnight is the contract.
 */
export const DISABLED_REASON_SANDBOX_USER_CAP_EXCEEDED =
  "Daily sandbox spend limit reached for your account. Resets at midnight UTC.";
export const DISABLED_REASON_SANDBOX_WORKSPACE_CAP_EXCEEDED =
  "Daily sandbox spend limit reached for this workspace. Resets at midnight UTC.";

export function getDefaultThreadMode(hasAttachedRepo: boolean): ChatMode {
  return hasAttachedRepo ? "docs" : "discuss";
}

/**
 * Apply the Plan-04 sandbox feature gate to an already-resolved
 * `ChatModeResolution`. Idempotent and safe to call when the gate is open
 * (returns the input unchanged).
 *
 * When the gate is closed and `sandbox` *was* available, this function
 * removes it from `availableModes` and writes the gate's tooltip into
 * `disabledReasons.sandbox` — overriding any lifecycle-derived tooltip
 * because the gate is a stronger signal (the mode is unavailable to this
 * viewer regardless of sandbox status).
 *
 * The `defaultMode` invariant ("default is always one of `availableModes`")
 * is preserved by the upstream resolver: `defaultMode` is never `sandbox`
 * (sandbox is opt-in), so removing `sandbox` from `availableModes` cannot
 * orphan the default.
 */
function applySandboxFeatureGate(resolution: ChatModeResolution, gate: SandboxFeatureGate): ChatModeResolution {
  if (gate.enabled) {
    return resolution;
  }
  // Filter out sandbox from availableModes (no-op if it wasn't there) and
  // replace any lifecycle tooltip with the gate's tooltip.
  return {
    availableModes: resolution.availableModes.filter((mode) => mode !== "sandbox"),
    defaultMode: resolution.defaultMode,
    disabledReasons: {
      ...resolution.disabledReasons,
      sandbox: gate.tooltip,
    },
  };
}

/**
 * Plan 10 — apply the daily-cost-cap gate. Sequenced AFTER the feature
 * gate in {@link resolveChatModes} so the feature-gate tooltip ("private
 * beta") wins over the cap tooltip when both fire — telling a viewer
 * "you're over your daily cap" is wrong information when they don't
 * even have access to the feature.
 *
 * Idempotent on open gate; on closed gate, removes `sandbox` from
 * `availableModes` and writes the cap-specific tooltip.
 */
function applySandboxCostCapGate(resolution: ChatModeResolution, gate: SandboxCostCapGate): ChatModeResolution {
  if (gate.enabled) {
    return resolution;
  }
  return {
    availableModes: resolution.availableModes.filter((mode) => mode !== "sandbox"),
    defaultMode: resolution.defaultMode,
    disabledReasons: {
      ...resolution.disabledReasons,
      sandbox: gate.tooltip,
    },
  };
}

export function resolveChatModes(
  hasAttachedRepo: boolean,
  sandboxStatus: ChatModeSandboxStatus,
  sandboxFeatureGate: SandboxFeatureGate,
  sandboxCostCapGate: SandboxCostCapGate = OPEN_SANDBOX_COST_CAP_GATE,
): ChatModeResolution {
  const baseline = resolveChatModesIgnoringFeatureGate(hasAttachedRepo, sandboxStatus);
  // Apply cost-cap gate first, then feature gate. Order matters: when
  // both gates close, the feature-gate tooltip overwrites the cap
  // tooltip (because feature gate is the more meaningful "you can't use
  // this at all" signal). Reversing the order would surface the cap
  // tooltip to viewers outside the private beta — wrong information.
  const afterCostCap = applySandboxCostCapGate(baseline, sandboxCostCapGate);
  return applySandboxFeatureGate(afterCostCap, sandboxFeatureGate);
}

function resolveChatModesIgnoringFeatureGate(
  hasAttachedRepo: boolean,
  sandboxStatus: ChatModeSandboxStatus,
): ChatModeResolution {
  if (!hasAttachedRepo) {
    return {
      availableModes: ["discuss"],
      defaultMode: getDefaultThreadMode(false),
      disabledReasons: {
        docs: DISABLED_REASON_DOCS_NO_REPO,
        sandbox: DISABLED_REASON_SANDBOX_NO_REPO,
      },
    };
  }

  switch (sandboxStatus) {
    case "ready":
      return {
        availableModes: ["discuss", "docs", "sandbox"],
        defaultMode: getDefaultThreadMode(true),
        disabledReasons: {},
      };
    case "provisioning":
      return {
        availableModes: ["discuss", "docs"],
        defaultMode: getDefaultThreadMode(true),
        disabledReasons: { sandbox: DISABLED_REASON_SANDBOX_PROVISIONING },
      };
    case "expired":
      return {
        availableModes: ["discuss", "docs"],
        defaultMode: getDefaultThreadMode(true),
        disabledReasons: { sandbox: DISABLED_REASON_SANDBOX_EXPIRED },
      };
    case "failed":
      return {
        availableModes: ["discuss", "docs"],
        defaultMode: getDefaultThreadMode(true),
        disabledReasons: { sandbox: DISABLED_REASON_SANDBOX_FAILED },
      };
    case "none":
      return {
        availableModes: ["discuss", "docs"],
        defaultMode: getDefaultThreadMode(true),
        disabledReasons: { sandbox: DISABLED_REASON_SANDBOX_NO_SANDBOX },
      };
  }
}
