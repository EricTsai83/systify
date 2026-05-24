import type { ChatMode } from "./lib/chatMode";

export type { ChatMode };

/**
 * ChatModeResolver — pure resolver mapping (hasAttachedRepo, sandboxStatus,
 * sandboxCostCapGate) to (availableModes, defaultMode, disabledReasons).
 *
 * Single source of truth for chat-mode availability used by both the UI mode
 * selector and the `chat.sendMessage` / `chat.createThread` validators on the
 * backend. The `ChatMode` literals are the canonical vocabulary persisted on
 * `threads.mode` and `messages.mode`, surfaced in URL segments
 * (`/w/:wid/discuss | library | lab`), and rendered verbatim in the UI labels.
 *
 * Mode semantics:
 *   - `discuss`  — LLM training only; no repo, no sandbox. Pre-design talk.
 *   - `library`  — RAG over user-produced artifacts (ADRs, diagrams, analyses)
 *                  for the attached repository. No sandbox required.
 *   - `lab`      — live filesystem + execution in a Daytona sandbox; the
 *                  canonical source of truth for current code state.
 *
 * Design choices:
 *   - `defaultMode` never auto-selects `'lab'` even when a sandbox is ready.
 *     Lab is the most expensive (sandbox compute + slower end-to-end) so it
 *     is opt-in; defaulting to it would auto-spend sandbox quota on every
 *     new thread.
 *   - When the repository is not attached, `disabledReasons` still carries an
 *     unlock hint for `library` and `lab` so the UI can render the tooltip
 *     ("disabled modes show a tooltip explaining how to unlock them"). A
 *     mode that is in `disabledReasons` is, by construction, not in
 *     `availableModes`.
 *   - The cost-cap gate (`sandboxCostCapGate`) is layered *on top* of the
 *     (repo, sandbox-status) resolution: when the per-user or per-workspace
 *     daily cap is exhausted the resolver removes `lab` from `availableModes`
 *     and surfaces the cap-specific tooltip. Env / rate-limit reads stay at
 *     the *call site*; the resolver only consumes the precomputed gate so it
 *     remains a pure function (trivially testable, no `process.env` or
 *     Convex ctx coupling).
 */
export type ChatModeSandboxStatus = "none" | "provisioning" | "ready" | "expired" | "failed";

export interface ChatModeResolution {
  availableModes: ChatMode[];
  defaultMode: ChatMode;
  disabledReasons: Partial<Record<ChatMode, string>>;
}

/**
 * Workspace-shell variant of {@link ChatModeResolution}: same vocabulary,
 * but carries the readiness gates the top-level mode switcher needs to
 * decide whether the Library Ask composer can bind to an artifact and
 * whether a Lab session can actually start (vs merely navigate to /lab
 * and provision a sandbox from inside).
 */
export interface WorkspaceModeResolution {
  /**
   * Modes the user is currently allowed to enter. A mode is in this list
   * iff the underlying preconditions (repo attached, an artifact exists,
   * sandbox lifecycle ready, daily cost cap not exceeded) are all satisfied.
   */
  availableModes: ReadonlyArray<ChatMode>;
  /**
   * Mode the URL should land on when the user opens the workspace. Never
   * `lab` — Lab mode is opt-in to keep cost transparent.
   */
  defaultMode: ChatMode;
  /**
   * Per-mode reason a user can read in a tooltip when the mode is greyed
   * out. The mode is, by construction, NOT in `availableModes` when a
   * string is present.
   */
  disabledReasons: Partial<Record<ChatMode, string>>;
  /** Gate Lab session start / Ask thread bind on these. */
  labReadiness: { canStart: boolean; reason: string | null };
  askReadiness: { canBind: boolean; reason: string | null };
}

const DISABLED_REASON_LIBRARY_NO_REPO = "Attach a repository to use Library mode.";

const DISABLED_REASON_LAB_NO_REPO = "Attach a repository and provision a sandbox to use Lab mode.";
const DISABLED_REASON_LAB_NO_SANDBOX = "Provision a sandbox to use Lab mode.";
const DISABLED_REASON_LAB_PROVISIONING = "Sandbox is provisioning — Lab mode will be available once it is ready.";
const DISABLED_REASON_LAB_EXPIRED = "Sandbox expired — provision a new sandbox to use Lab mode.";
const DISABLED_REASON_LAB_FAILED = "Sandbox provisioning failed — provision a new sandbox to use Lab mode.";

const ASK_REASON_NO_REPO = "Attach a repository and produce at least one artifact before asking a question.";
const ASK_REASON_NO_ARTIFACT = "Library Ask needs at least one artifact in this workspace.";
const LAB_READY_REASON_NO_REPO = "Lab requires an attached repository.";

/**
 * Sandbox daily-cost-cap gate. Closed when the per-user OR per-workspace
 * daily spend cap is reached; the resolver removes `lab` from
 * `availableModes` and surfaces the cost-cap tooltip so the user
 * understands why the option is greyed out.
 *
 * Two distinct closed `reason`s let the UI render scope-specific copy:
 * "your account" vs "this workspace" reaches different remediation paths
 * (wait until midnight UTC vs. ask a workspace admin to raise the cap).
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
       * Lab mode will become available again. Distinct from `tooltip` so
       * the same gate value can drive both a static dropdown label and a
       * live-updating countdown.
       */
      readonly resetAtMs: number;
    };

/**
 * Statically-open cost-cap gate for tests that focus on non-cost-related
 * resolver behaviour. Real per-viewer evaluation lives in
 * `lib/rateLimit.ts` (`peekSandboxDailyCostForUser` /
 * `peekSandboxDailyCostForWorkspace`).
 */
export const OPEN_SANDBOX_COST_CAP_GATE: SandboxCostCapGate = { enabled: true };

/**
 * Disabled-reason tooltips for the cost-cap gate. Module-scoped exports so
 * the call sites that build a {@link SandboxCostCapGate}
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
  return hasAttachedRepo ? "library" : "discuss";
}

/**
 * Apply the daily-cost-cap gate to an already-resolved
 * `ChatModeResolution`. Idempotent on open gate; on closed gate, removes
 * `lab` from `availableModes` and writes the cap-specific tooltip
 * (overriding any lifecycle-derived tooltip because the cap is the more
 * actionable signal — provisioning a sandbox would not unlock the mode
 * for a viewer who has hit their daily spend ceiling).
 *
 * The `defaultMode` invariant ("default is always one of `availableModes`")
 * is preserved by the upstream resolver: `defaultMode` is never `lab`
 * (lab is opt-in), so removing `lab` from `availableModes` cannot orphan
 * the default.
 */
function applySandboxCostCapGate(resolution: ChatModeResolution, gate: SandboxCostCapGate): ChatModeResolution {
  if (gate.enabled) {
    return resolution;
  }
  return {
    availableModes: resolution.availableModes.filter((mode) => mode !== "lab"),
    defaultMode: resolution.defaultMode,
    disabledReasons: {
      ...resolution.disabledReasons,
      lab: gate.tooltip,
    },
  };
}

export function resolveChatModes(
  hasAttachedRepo: boolean,
  sandboxStatus: ChatModeSandboxStatus,
  sandboxCostCapGate: SandboxCostCapGate = OPEN_SANDBOX_COST_CAP_GATE,
): ChatModeResolution {
  const baseline = resolveChatModesIgnoringCostCap(hasAttachedRepo, sandboxStatus);
  return applySandboxCostCapGate(baseline, sandboxCostCapGate);
}

function resolveChatModesIgnoringCostCap(
  hasAttachedRepo: boolean,
  sandboxStatus: ChatModeSandboxStatus,
): ChatModeResolution {
  if (!hasAttachedRepo) {
    return {
      availableModes: ["discuss"],
      defaultMode: getDefaultThreadMode(false),
      disabledReasons: {
        library: DISABLED_REASON_LIBRARY_NO_REPO,
        lab: DISABLED_REASON_LAB_NO_REPO,
      },
    };
  }

  switch (sandboxStatus) {
    case "ready":
      return {
        availableModes: ["discuss", "library", "lab"],
        defaultMode: getDefaultThreadMode(true),
        disabledReasons: {},
      };
    case "provisioning":
      return {
        availableModes: ["discuss", "library"],
        defaultMode: getDefaultThreadMode(true),
        disabledReasons: { lab: DISABLED_REASON_LAB_PROVISIONING },
      };
    case "expired":
      return {
        availableModes: ["discuss", "library"],
        defaultMode: getDefaultThreadMode(true),
        disabledReasons: { lab: DISABLED_REASON_LAB_EXPIRED },
      };
    case "failed":
      return {
        availableModes: ["discuss", "library"],
        defaultMode: getDefaultThreadMode(true),
        disabledReasons: { lab: DISABLED_REASON_LAB_FAILED },
      };
    case "none":
      return {
        availableModes: ["discuss", "library"],
        defaultMode: getDefaultThreadMode(true),
        disabledReasons: { lab: DISABLED_REASON_LAB_NO_SANDBOX },
      };
  }
}

/**
 * Translate the (repo, artifact, sandbox, gates) tuple into the
 * `(availableModes, defaultMode, disabledReasons, askReadiness, labReadiness)`
 * quintuple the workspace shell consumes.
 *
 * Independent of {@link resolveChatModes}: the chat-mode resolver answers
 * the per-thread mode-selector question; this one answers "which top-level
 * mode can the user enter from the workspace shell". Both stay pure —
 * no `process.env`, no Convex `ctx`.
 */
export function resolveWorkspaceModes(
  hasAttachedRepo: boolean,
  hasAtLeastOneArtifact: boolean,
  sandboxStatus: ChatModeSandboxStatus,
  sandboxCostCapGate: SandboxCostCapGate = OPEN_SANDBOX_COST_CAP_GATE,
): WorkspaceModeResolution {
  const available = new Set<ChatMode>(["discuss"]);
  const disabledReasons: Partial<Record<ChatMode, string>> = {};

  // Library availability — needs an attached repo. The empty Library page
  // surfaces a "Generate System Design" CTA so a repo with zero artifacts is
  // still a valid landing surface.
  if (!hasAttachedRepo) {
    disabledReasons.library = DISABLED_REASON_LIBRARY_NO_REPO;
  } else {
    available.add("library");
  }

  // Lab *navigation* only needs an attached repository — the sidebar Lab
  // button must stay clickable so the user can open Lab and provision a
  // sandbox from inside it (the sandbox may not exist yet at click time).
  // Whether a lab session can actually *run* — sandbox `ready`, cost cap
  // open — is the separate `labReadiness` axis below; the write path
  // (`assertWorkspaceModeEligible`) gates on that. This mirrors how Library
  // navigation is decoupled from `askReadiness`.
  if (hasAttachedRepo) {
    available.add("lab");
  } else {
    disabledReasons.lab = DISABLED_REASON_LAB_NO_REPO;
  }

  const askReadiness: WorkspaceModeResolution["askReadiness"] = !hasAttachedRepo
    ? { canBind: false, reason: ASK_REASON_NO_REPO }
    : !hasAtLeastOneArtifact
      ? { canBind: false, reason: ASK_REASON_NO_ARTIFACT }
      : { canBind: true, reason: null };

  // Defer the (cost-cap + sandbox-lifecycle) gate to `resolveChatModes` so
  // the per-thread chat-mode resolver and this workspace-mode resolver
  // agree on whether Lab is actually runnable right now. Computed at the
  // point of use so the dependency is obvious.
  const chatResolution = resolveChatModes(hasAttachedRepo, sandboxStatus, sandboxCostCapGate);
  const labReadiness: WorkspaceModeResolution["labReadiness"] = !hasAttachedRepo
    ? { canStart: false, reason: LAB_READY_REASON_NO_REPO }
    : sandboxStatus === "ready" && chatResolution.availableModes.includes("lab")
      ? { canStart: true, reason: null }
      : { canStart: false, reason: chatResolution.disabledReasons.lab ?? DISABLED_REASON_LAB_NO_SANDBOX };

  // Pick the URL-landing default. The function is intentionally
  // independent of `available` so it never lands the user on a disabled
  // mode (Lab is opt-in).
  const defaultMode = getDefaultThreadMode(hasAttachedRepo);

  return {
    availableModes: Array.from(available) as ReadonlyArray<ChatMode>,
    defaultMode,
    disabledReasons,
    askReadiness,
    labReadiness,
  };
}

export {
  DISABLED_REASON_LIBRARY_NO_REPO,
  DISABLED_REASON_LAB_NO_REPO,
  DISABLED_REASON_LAB_NO_SANDBOX,
  DISABLED_REASON_LAB_PROVISIONING,
  DISABLED_REASON_LAB_EXPIRED,
  DISABLED_REASON_LAB_FAILED,
};
