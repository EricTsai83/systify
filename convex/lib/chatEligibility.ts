/**
 * Chat-mode eligibility — pure resolvers + shared runtime helpers backing
 * both `workspaceModeEligibility.evaluate` (per-workspace read path used by
 * the workspace mode switcher and the Discuss composer) and
 * `threadContext.getThreadContext` (per-thread read path used by the chat
 * panel and cost ticker).
 *
 * The pure resolvers stay independent of `process.env` and Convex `ctx`,
 * so they remain trivially testable. The runtime helpers below
 * (`toChatModeSandboxStatus`, `computeSandboxCostCapEvaluation`) own the
 * cross-query invariants that used to be duplicated between
 * `threadContext.ts` and `workspaceModeEligibility.ts`. Centralising them
 * here means the two read paths cannot drift in how they translate sandbox
 * lifecycle state or apply the cost-cap precedence rule.
 *
 * Mode semantics (post-Lab collapse):
 *   - `discuss`  — free-form chat with two independent grounding axes
 *                  (Library / Sandbox) the composer surfaces as toggles.
 *   - `library`  — RAG over user-produced artifacts for the attached
 *                  repository; the home of the always-visible Ask panel.
 */

import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { type ChatMode, getDefaultThreadMode } from "./chatMode";
import { type SandboxModeStatus } from "./repositorySandbox";
import {
  getSandboxReplyEstimateCents,
  peekSandboxDailyCostForUser,
  peekSandboxDailyCostForWorkspace,
  type SandboxDailyCostBudget,
} from "./rateLimit";

// ─── Types ────────────────────────────────────────────────────────────────

export type ChatModeSandboxStatus = "none" | "provisioning" | "ready" | "expired" | "failed";

/**
 * Stable enum of *why* a mode (or grounding axis) is disabled. Codes are
 * deliberately disjoint — the resolvers enumerate the possible disabled
 * states; this enum names each one.
 */
export type WorkspaceModeDisabledReasonCode =
  | "no_repository_attached"
  | "library_no_artifact"
  | "sandbox_missing"
  | "sandbox_provisioning"
  | "sandbox_expired"
  | "sandbox_failed"
  | "sandbox_user_cap_exceeded"
  | "sandbox_workspace_cap_exceeded";

/**
 * Discriminated union: every axis verdict is either enabled or disabled
 * with a structured reason. Type-level enforcement — TS forces callers
 * through `.enabled` narrowing before reading `.code`/`.message`.
 */
export type AxisVerdict =
  | { readonly enabled: true }
  | {
      readonly enabled: false;
      readonly code: WorkspaceModeDisabledReasonCode;
      readonly message: string;
    };

/**
 * Sandbox grounding carries an extra `isActivatable` flag so the composer
 * can render an Activate CTA on a closed-but-recoverable gate.
 */
export type SandboxGroundingVerdict =
  | { readonly enabled: true }
  | {
      readonly enabled: false;
      readonly code: WorkspaceModeDisabledReasonCode;
      readonly message: string;
      readonly isActivatable: boolean;
    };

/**
 * Sandbox daily-cost-cap gate. Closed when the per-user OR per-workspace
 * daily spend cap is reached; the resolver closes the Sandbox grounding
 * axis and surfaces the cost-cap tooltip so the user understands why the
 * toggle is greyed out.
 *
 * Two distinct closed `reason`s let the UI render scope-specific copy:
 * "your account" vs "this workspace" reach different remediation paths
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
       * Wall-clock ms epoch at which the cap resets. Surfaced on the
       * sandbox-cost-budget snapshot so the chat-panel ticker can render
       * a countdown ("Resets in 3h 12m"). Note: this is *lifecycle truth*
       * about when the bucket replenishes, not a retry hint — the
       * reactive query naturally fires when the bucket actually flips,
       * so eligibility verdicts deliberately do not carry a
       * `retryAfterMs?` field.
       */
      readonly resetAtMs: number;
    };

export const OPEN_SANDBOX_COST_CAP_GATE: SandboxCostCapGate = { enabled: true };

export interface ChatModeResolution {
  readonly modes: { readonly discuss: AxisVerdict; readonly library: AxisVerdict };
  readonly defaultMode: ChatMode;
}

/**
 * Workspace-shell variant of {@link ChatModeResolution}: same vocabulary,
 * but carries the readiness gates the top-level mode switcher and the
 * Discuss composer need.
 */
export interface WorkspaceModeResolution {
  readonly modes: { readonly discuss: AxisVerdict; readonly library: AxisVerdict };
  readonly defaultMode: ChatMode;
  readonly grounding: {
    readonly library: AxisVerdict;
    readonly sandbox: SandboxGroundingVerdict;
  };
  readonly askReadiness: AxisVerdict;
}

// ─── Tooltip constants ────────────────────────────────────────────────────

export const DISABLED_REASON_LIBRARY_NO_REPO = "Attach a repository to use Library mode.";

export const GROUNDING_LIBRARY_REASON_NO_REPO = "Attach a repository to ground replies in your design artifacts.";
export const GROUNDING_LIBRARY_REASON_NO_ARTIFACT =
  "Generate at least one system design artifact to enable Library grounding.";

export const GROUNDING_SANDBOX_REASON_NO_REPO = "Attach a repository to ground replies in live source.";
export const GROUNDING_SANDBOX_REASON_NO_SANDBOX = "Provision a sandbox to ground replies in live source.";
export const GROUNDING_SANDBOX_REASON_PROVISIONING =
  "Sandbox is provisioning — live-source grounding will be available once it is ready.";
export const GROUNDING_SANDBOX_REASON_EXPIRED =
  "Sandbox expired — provision a new sandbox to use live-source grounding.";
export const GROUNDING_SANDBOX_REASON_FAILED =
  "Sandbox provisioning failed — provision a new sandbox to use live-source grounding.";

const ASK_REASON_NO_REPO = "Attach a repository and produce at least one artifact before asking a question.";
const ASK_REASON_NO_ARTIFACT = "Library Ask needs at least one artifact in this workspace.";

/**
 * Tooltips for the cost-cap gate. Promise "Resets at midnight UTC" verbatim
 * because that is exactly when the underlying fixed-window bucket
 * replenishes — see `convex/lib/rateLimit.ts` for the bucket configuration.
 */
export const DISABLED_REASON_SANDBOX_USER_CAP_EXCEEDED =
  "Daily sandbox spend limit reached for your account. Resets at midnight UTC.";
export const DISABLED_REASON_SANDBOX_WORKSPACE_CAP_EXCEEDED =
  "Daily sandbox spend limit reached for this workspace. Resets at midnight UTC.";

// ─── Pure resolvers ───────────────────────────────────────────────────────

/**
 * Per-thread chat-mode resolution. Post-Lab collapse this is a thin
 * function — Lab is gone as a top-level mode, so only the
 * `(hasAttachedRepo)` axis matters for which modes are visible. Sandbox
 * status + cost cap now feed the Sandbox *grounding* axis (see
 * {@link resolveSandboxGroundingAxis}) rather than a mode availability
 * decision.
 */
export function resolveChatModes(hasAttachedRepo: boolean): ChatModeResolution {
  const discuss: AxisVerdict = { enabled: true };
  const library: AxisVerdict = hasAttachedRepo
    ? { enabled: true }
    : {
        enabled: false,
        code: "no_repository_attached",
        message: DISABLED_REASON_LIBRARY_NO_REPO,
      };

  return {
    modes: { discuss, library },
    defaultMode: getDefaultThreadMode(hasAttachedRepo),
  };
}

/**
 * Compute the Sandbox grounding axis from the (sandbox lifecycle, cost cap)
 * matrix. The composer renders the `Sandbox` toggle as disabled when this
 * returns `enabled: false`, with `message` as the tooltip and
 * `isActivatable: true` flagging the "no sandbox provisioned yet — click
 * to start one" sub-state.
 *
 * Precedence: cost cap → lifecycle. The cost cap is the more actionable
 * signal for a viewer who already has a healthy sandbox.
 *
 * Exported so the per-thread read path (`threadContext.enrichThreadContext`)
 * can derive `sandboxIsActivatable` from this verdict instead of
 * recomputing the (repo + cost-gate + status) tuple in parallel —
 * keeping the activation rule a single source of truth.
 */
export function resolveSandboxGroundingAxis(
  hasAttachedRepo: boolean,
  sandboxStatus: ChatModeSandboxStatus,
  sandboxCostCapGate: SandboxCostCapGate,
): SandboxGroundingVerdict {
  if (!hasAttachedRepo) {
    return {
      enabled: false,
      code: "no_repository_attached",
      message: GROUNDING_SANDBOX_REASON_NO_REPO,
      isActivatable: false,
    };
  }
  if (!sandboxCostCapGate.enabled) {
    const code: WorkspaceModeDisabledReasonCode =
      sandboxCostCapGate.reason === "user_daily_cap_exceeded"
        ? "sandbox_user_cap_exceeded"
        : "sandbox_workspace_cap_exceeded";
    return {
      enabled: false,
      code,
      message: sandboxCostCapGate.tooltip,
      isActivatable: false,
    };
  }
  switch (sandboxStatus) {
    case "ready":
      return { enabled: true };
    case "provisioning":
      return {
        enabled: false,
        code: "sandbox_provisioning",
        message: GROUNDING_SANDBOX_REASON_PROVISIONING,
        isActivatable: false,
      };
    case "expired":
      return {
        enabled: false,
        code: "sandbox_expired",
        message: GROUNDING_SANDBOX_REASON_EXPIRED,
        isActivatable: true,
      };
    case "failed":
      return {
        enabled: false,
        code: "sandbox_failed",
        message: GROUNDING_SANDBOX_REASON_FAILED,
        isActivatable: true,
      };
    case "none":
      return {
        enabled: false,
        code: "sandbox_missing",
        message: GROUNDING_SANDBOX_REASON_NO_SANDBOX,
        isActivatable: true,
      };
  }
}

/**
 * Compute the Library grounding axis. Library grounding requires both an
 * attached repository (to scope retrieval) AND at least one artifact (so
 * the RAG retriever has something to fetch).
 */
function resolveLibraryGroundingAxis(hasAttachedRepo: boolean, hasAtLeastOneArtifact: boolean): AxisVerdict {
  if (!hasAttachedRepo) {
    return {
      enabled: false,
      code: "no_repository_attached",
      message: GROUNDING_LIBRARY_REASON_NO_REPO,
    };
  }
  if (!hasAtLeastOneArtifact) {
    return {
      enabled: false,
      code: "library_no_artifact",
      message: GROUNDING_LIBRARY_REASON_NO_ARTIFACT,
    };
  }
  return { enabled: true };
}

/**
 * Translate the (repo, artifact, sandbox, gates) tuple into the
 * structured verdict the workspace shell consumes.
 *
 * Independent of {@link resolveChatModes}: the chat-mode resolver answers
 * the per-thread mode-selector question; this one answers "which top-level
 * mode can the user enter from the workspace shell AND what does the
 * Discuss composer's grounding toggle bar look like right now". Both stay
 * pure — no `process.env`, no Convex `ctx`.
 */
export function resolveWorkspaceModes(
  hasAttachedRepo: boolean,
  hasAtLeastOneArtifact: boolean,
  sandboxStatus: ChatModeSandboxStatus,
  sandboxCostCapGate: SandboxCostCapGate = OPEN_SANDBOX_COST_CAP_GATE,
): WorkspaceModeResolution {
  const { modes, defaultMode } = resolveChatModes(hasAttachedRepo);

  const askReadiness: AxisVerdict = !hasAttachedRepo
    ? {
        enabled: false,
        code: "no_repository_attached",
        message: ASK_REASON_NO_REPO,
      }
    : !hasAtLeastOneArtifact
      ? {
          enabled: false,
          code: "library_no_artifact",
          message: ASK_REASON_NO_ARTIFACT,
        }
      : { enabled: true };

  return {
    modes,
    defaultMode,
    grounding: {
      library: resolveLibraryGroundingAxis(hasAttachedRepo, hasAtLeastOneArtifact),
      sandbox: resolveSandboxGroundingAxis(hasAttachedRepo, sandboxStatus, sandboxCostCapGate),
    },
    askReadiness,
  };
}

// ─── Shared runtime helpers ───────────────────────────────────────────────

/**
 * Map the centralized `SandboxModeStatus` (from `lib/repositorySandbox.ts`)
 * onto the pure resolver's `ChatModeSandboxStatus` input. Single source of
 * truth for the translation — `threadContext.getThreadContext` and
 * `workspaceModeEligibility.evaluate` both import this so the two read
 * paths cannot drift in how they classify the same sandbox doc.
 *
 * TTL, missing remoteId / repoPath, and provider-status semantics stay in
 * `lib/repositorySandbox.ts`; this helper only relabels the codes for the
 * resolver domain.
 */
export function toChatModeSandboxStatus(status: SandboxModeStatus | null): ChatModeSandboxStatus {
  switch (status?.reasonCode ?? "missing_sandbox") {
    case "available":
      return "ready";
    case "sandbox_provisioning":
      return "provisioning";
    case "sandbox_expired":
      return "expired";
    case "sandbox_unavailable":
      return "failed";
    case "missing_sandbox":
      return "none";
  }
}

export interface SandboxCostCapEvaluation {
  /** Gate consumed by the eligibility resolver. */
  gate: SandboxCostCapGate;
  /** Per-user daily budget snapshot (always populated for the cost ticker). */
  userBudget: SandboxDailyCostBudget;
  /** Per-workspace daily budget snapshot, or `null` when no workspace is in play. */
  workspaceBudget: SandboxDailyCostBudget | null;
}

/**
 * Compute the sandbox daily-cost-cap gate AND the per-user / per-workspace
 * budget snapshots in one pass. Single source of truth for the precedence
 * rule (user cap blocks first) — previously duplicated between
 * `threadContext.computeSandboxCostBudgets` and
 * `workspaceModeEligibility.computeSandboxCostCapGate` with sync-comments
 * pleading "keep this aligned with the other one". Both call sites now
 * share this implementation so the rule cannot drift.
 *
 * Both peeks happen inside the surrounding query's transaction so the gate
 * decision and the displayed budgets agree even under concurrent
 * settlement: a rate-limit settle that lands between the user peek and the
 * workspace peek would update both buckets atomically from the viewer's
 * POV.
 *
 * Why we peek even when the gate ends up open: the chat-panel cost ticker
 * ("$X.XX of $Y.YY remaining today") is shown regardless of whether the
 * cap blocked the send. Returning both peeks unconditionally keeps the
 * read path a single source of truth.
 *
 * Precedence (user cap first) matches `assertSandboxDailyCostBudget`'s
 * write-path ordering in `convex/lib/rateLimit.ts`. When both would block,
 * the gate surfaces the user-cap tooltip — the more user-actionable signal
 * because the viewer can switch to ungrounded chat immediately, whereas
 * the workspace-cap reset would also gate every other workspace member.
 */
export async function computeSandboxCostCapEvaluation(
  ctx: QueryCtx,
  ownerTokenIdentifier: string,
  workspaceId: Id<"workspaces"> | null,
): Promise<SandboxCostCapEvaluation> {
  const estimateCents = getSandboxReplyEstimateCents();
  const userBudget = await peekSandboxDailyCostForUser(ctx, ownerTokenIdentifier);
  const workspaceBudget = workspaceId ? await peekSandboxDailyCostForWorkspace(ctx, workspaceId) : null;

  if (userBudget.remainingCents < estimateCents) {
    return {
      gate: {
        enabled: false,
        reason: "user_daily_cap_exceeded",
        tooltip: DISABLED_REASON_SANDBOX_USER_CAP_EXCEEDED,
        resetAtMs: userBudget.resetAtMs,
      },
      userBudget,
      workspaceBudget,
    };
  }
  if (workspaceBudget && workspaceBudget.remainingCents < estimateCents) {
    return {
      gate: {
        enabled: false,
        reason: "workspace_daily_cap_exceeded",
        tooltip: DISABLED_REASON_SANDBOX_WORKSPACE_CAP_EXCEEDED,
        resetAtMs: workspaceBudget.resetAtMs,
      },
      userBudget,
      workspaceBudget,
    };
  }
  return { gate: { enabled: true }, userBudget, workspaceBudget };
}
