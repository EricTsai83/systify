import type { ChatMode } from "./lib/chatMode";

export type { ChatMode };

/**
 * ChatModeResolver — pure resolver mapping (hasAttachedRepo, sandboxStatus,
 * sandboxCostCapGate) to (availableModes, defaultMode, disabledReasons,
 * grounding axis availability).
 *
 * Single source of truth for chat-mode availability used by both the UI mode
 * switcher and the `chat.sendMessage` / `chat.createThread` validators on the
 * backend. The `ChatMode` literals are the canonical vocabulary persisted on
 * `threads.mode` and `messages.mode`, surfaced in URL segments
 * (`/w/:wid/discuss | library`), and rendered verbatim in the UI labels.
 *
 * Mode semantics (post-Lab collapse):
 *   - `discuss`  — free-form chat with two independent grounding axes
 *                  (Library / Sandbox) the composer surfaces as toggles.
 *   - `library`  — RAG over user-produced artifacts for the attached
 *                  repository; the home of the always-visible Ask panel.
 *
 * Design choices:
 *   - `defaultMode` is `library` when a repo is attached, `discuss`
 *     otherwise.
 *   - When the repository is not attached, `disabledReasons` still carries
 *     an unlock hint for `library` so the UI can render the tooltip.
 *   - The Discuss Sandbox grounding axis is the heaviest path (Daytona
 *     compute + tool steps) so its availability is gated by the same
 *     (sandbox-lifecycle, cost-cap) matrix the legacy Lab mode used.
 *     Library grounding adds an artifact existence gate on top of the
 *     repo gate. The pure resolver names the gates; the runtime layer
 *     (`workspaceModeEligibility.ts`) loads the inputs.
 *   - The cost-cap gate (`sandboxCostCapGate`) is layered *on top* of the
 *     (repo, sandbox-status) resolution: when the per-user or per-workspace
 *     daily cap is exhausted the Sandbox grounding axis is closed and the
 *     cap-specific tooltip is surfaced. Env / rate-limit reads stay at the
 *     *call site*; the resolver only consumes the precomputed gate so it
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
 * but carries the readiness gates the top-level mode switcher and the
 * Discuss composer need.
 */
export interface WorkspaceModeResolution {
  /**
   * Modes the user is currently allowed to enter. A mode is in this list
   * iff the underlying preconditions (repo attached) are satisfied.
   */
  availableModes: ReadonlyArray<ChatMode>;
  /**
   * Mode the URL should land on when the user opens the workspace.
   */
  defaultMode: ChatMode;
  /**
   * Per-mode reason a user can read in a tooltip when the mode is greyed
   * out. The mode is, by construction, NOT in `availableModes` when a
   * string is present.
   */
  disabledReasons: Partial<Record<ChatMode, string>>;
  askReadiness: { canBind: boolean; reason: string | null };
  /**
   * Discuss-composer grounding-toggle availability. Each axis carries a
   * tooltip-quality reason when closed; the sandbox axis also reports
   * `isActivatable` so the composer can render an Activate CTA on a
   * closed-but-recoverable gate. Library Mode ignores these — its
   * grounding is implicit in the mode.
   */
  grounding: {
    library: { available: boolean; reason: string | null };
    sandbox: { available: boolean; reason: string | null; isActivatable: boolean };
  };
}

const DISABLED_REASON_LIBRARY_NO_REPO = "Attach a repository to use Library mode.";

const GROUNDING_LIBRARY_REASON_NO_REPO = "Attach a repository to ground replies in your design artifacts.";
const GROUNDING_LIBRARY_REASON_NO_ARTIFACT =
  "Generate at least one system design artifact to enable Library grounding.";

const GROUNDING_SANDBOX_REASON_NO_REPO = "Attach a repository to ground replies in live source.";
const GROUNDING_SANDBOX_REASON_NO_SANDBOX = "Provision a sandbox to ground replies in live source.";
const GROUNDING_SANDBOX_REASON_PROVISIONING =
  "Sandbox is provisioning — live-source grounding will be available once it is ready.";
const GROUNDING_SANDBOX_REASON_EXPIRED = "Sandbox expired — provision a new sandbox to use live-source grounding.";
const GROUNDING_SANDBOX_REASON_FAILED =
  "Sandbox provisioning failed — provision a new sandbox to use live-source grounding.";

const ASK_REASON_NO_REPO = "Attach a repository and produce at least one artifact before asking a question.";
const ASK_REASON_NO_ARTIFACT = "Library Ask needs at least one artifact in this workspace.";

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
 * Per-thread chat-mode resolution. Post-Lab collapse this is a much
 * simpler shape — Lab is gone as a top-level mode, so only the
 * `(hasAttachedRepo)` axis matters for which modes are visible. Sandbox
 * status + cost cap now feed the Sandbox *grounding* axis (see
 * {@link resolveSandboxGroundingAxis}) rather than a mode availability
 * decision; this function is kept thin so legacy callers / tests can
 * still read `(availableModes, defaultMode, disabledReasons)` without
 * threading the grounding domain through.
 */
export function resolveChatModes(hasAttachedRepo: boolean): ChatModeResolution {
  if (!hasAttachedRepo) {
    return {
      availableModes: ["discuss"],
      defaultMode: getDefaultThreadMode(false),
      disabledReasons: {
        library: DISABLED_REASON_LIBRARY_NO_REPO,
      },
    };
  }
  return {
    availableModes: ["discuss", "library"],
    defaultMode: getDefaultThreadMode(true),
    disabledReasons: {},
  };
}

/**
 * Compute the Sandbox grounding axis from the same (sandbox lifecycle,
 * cost cap) matrix the legacy `lab` mode used. The composer renders the
 * `Sandbox` toggle as disabled when this returns `available: false`,
 * with `reason` as the tooltip and `isActivatable: true` flagging the
 * "no sandbox provisioned yet — click to start one" sub-state.
 */
function resolveSandboxGroundingAxis(
  hasAttachedRepo: boolean,
  sandboxStatus: ChatModeSandboxStatus,
  sandboxCostCapGate: SandboxCostCapGate,
): { available: boolean; reason: string | null; isActivatable: boolean } {
  if (!hasAttachedRepo) {
    return { available: false, reason: GROUNDING_SANDBOX_REASON_NO_REPO, isActivatable: false };
  }
  if (!sandboxCostCapGate.enabled) {
    return { available: false, reason: sandboxCostCapGate.tooltip, isActivatable: false };
  }
  switch (sandboxStatus) {
    case "ready":
      return { available: true, reason: null, isActivatable: false };
    case "provisioning":
      return { available: false, reason: GROUNDING_SANDBOX_REASON_PROVISIONING, isActivatable: false };
    case "expired":
      return { available: false, reason: GROUNDING_SANDBOX_REASON_EXPIRED, isActivatable: true };
    case "failed":
      return { available: false, reason: GROUNDING_SANDBOX_REASON_FAILED, isActivatable: true };
    case "none":
      return { available: false, reason: GROUNDING_SANDBOX_REASON_NO_SANDBOX, isActivatable: true };
  }
}

/**
 * Compute the Library grounding axis. Library grounding requires both an
 * attached repository (to scope retrieval) AND at least one artifact (so
 * the RAG retriever has something to fetch).
 */
function resolveLibraryGroundingAxis(
  hasAttachedRepo: boolean,
  hasAtLeastOneArtifact: boolean,
): { available: boolean; reason: string | null } {
  if (!hasAttachedRepo) {
    return { available: false, reason: GROUNDING_LIBRARY_REASON_NO_REPO };
  }
  if (!hasAtLeastOneArtifact) {
    return { available: false, reason: GROUNDING_LIBRARY_REASON_NO_ARTIFACT };
  }
  return { available: true, reason: null };
}

/**
 * Translate the (repo, artifact, sandbox, gates) tuple into the
 * `(availableModes, defaultMode, disabledReasons, askReadiness, grounding)`
 * quintuple the workspace shell consumes.
 *
 * Independent of {@link resolveChatModes}: the chat-mode resolver answers
 * the per-thread mode-selector question; this one answers "which top-level
 * mode can the user enter from the workspace shell AND what does the
 * Discuss composer's grounding toggle bar look like right now". Both
 * stay pure — no `process.env`, no Convex `ctx`.
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

  const askReadiness: WorkspaceModeResolution["askReadiness"] = !hasAttachedRepo
    ? { canBind: false, reason: ASK_REASON_NO_REPO }
    : !hasAtLeastOneArtifact
      ? { canBind: false, reason: ASK_REASON_NO_ARTIFACT }
      : { canBind: true, reason: null };

  const grounding: WorkspaceModeResolution["grounding"] = {
    library: resolveLibraryGroundingAxis(hasAttachedRepo, hasAtLeastOneArtifact),
    sandbox: resolveSandboxGroundingAxis(hasAttachedRepo, sandboxStatus, sandboxCostCapGate),
  };

  const defaultMode = getDefaultThreadMode(hasAttachedRepo);

  return {
    availableModes: Array.from(available) as ReadonlyArray<ChatMode>,
    defaultMode,
    disabledReasons,
    askReadiness,
    grounding,
  };
}

export {
  DISABLED_REASON_LIBRARY_NO_REPO,
  GROUNDING_LIBRARY_REASON_NO_REPO,
  GROUNDING_LIBRARY_REASON_NO_ARTIFACT,
  GROUNDING_SANDBOX_REASON_NO_REPO,
  GROUNDING_SANDBOX_REASON_NO_SANDBOX,
  GROUNDING_SANDBOX_REASON_PROVISIONING,
  GROUNDING_SANDBOX_REASON_EXPIRED,
  GROUNDING_SANDBOX_REASON_FAILED,
};
