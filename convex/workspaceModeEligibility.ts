/**
 * Workspace mode eligibility — runtime evaluator for the (Discuss / Library /
 * Lab) mode trio at workspace scope.
 *
 * Owns the runtime composition for "can this viewer use mode X for this
 * workspace right now?" — load workspace + repository + sandbox doc + artifact
 * existence + sandbox cost cap (rate-limit peek), then run them through the
 * pure {@link resolveWorkspaceModes} resolver and augment the resolver's string
 * `disabledReasons` with structured `{ code, message, retryAfterMs? }` objects
 * so write-path callers can throw structured `ConvexError`s.
 *
 * Three exposed seams:
 *
 *   1. {@link evaluate} — public Convex query. UI subscribes; action callers
 *      fetch via `ctx.runQuery(api.workspaceModeEligibility.evaluate, ...)`.
 *   2. {@link assertWorkspaceModeEligible} — mutation-context sugar. Throws a
 *      structured `ConvexError` when the caller-supplied mode is disabled.
 *   3. {@link throwIfDisabled} — pure assertion over a verdict + mode. Action
 *      callers compose `runQuery` + this when they need verdict-aware control
 *      flow before deciding to throw (e.g., Lab generation tolerating an
 *      emergency feature-flag flip mid-flight).
 *
 * The pure {@link resolveWorkspaceModes} resolver is the internal seam — it
 * stays untouched and trivially testable; this module only adds the runtime
 * loading + structured-reason augmentation around it.
 */

import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  DISABLED_REASON_SANDBOX_USER_CAP_EXCEEDED,
  DISABLED_REASON_SANDBOX_WORKSPACE_CAP_EXCEEDED,
  resolveWorkspaceModes,
  type ChatModeSandboxStatus,
  type SandboxCostCapGate,
  type ChatMode,
  type WorkspaceModeResolution,
} from "./chatModeResolver";
import { requireViewerIdentity } from "./lib/auth";
import { getSandboxModeStatus, type SandboxModeStatus } from "./lib/sandboxAvailability";
import {
  getSandboxReplyEstimateCents,
  peekSandboxDailyCostForUser,
  peekSandboxDailyCostForWorkspace,
} from "./lib/rateLimit";

// ─── Types ────────────────────────────────────────────────────────────────

/**
 * Stable enum of *why* a mode is disabled at workspace scope. Exists so
 * write-path callers can branch on `code` (e.g. surface a "Resets at
 * midnight UTC" countdown for cost-cap codes) instead of regex-matching
 * tooltip strings.
 *
 * Codes are deliberately disjoint across the three modes — there is no
 * "library_provisioning" or "lab_no_artifact" because those combinations
 * cannot fire. The pure resolver in `chatModeResolver.ts` enumerates the
 * possible disabled states; this enum names each one.
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

export interface WorkspaceModeDisabled {
  readonly code: WorkspaceModeDisabledReasonCode;
  /** Tooltip-quality message taken verbatim from the pure resolver. */
  readonly message: string;
  /**
   * Wall-clock ms remaining until the gate would re-open. Populated only for
   * the cost-cap codes (`sandbox_user_cap_exceeded`,
   * `sandbox_workspace_cap_exceeded`); UI uses it to render a midnight-UTC
   * countdown.
   */
  readonly retryAfterMs?: number;
}

export interface WorkspaceModeEligibility {
  readonly availableModes: ReadonlyArray<ChatMode>;
  readonly defaultMode: ChatMode;
  readonly disabledReasons: Partial<Record<ChatMode, WorkspaceModeDisabled>>;
  readonly labReadiness: { canStart: boolean; reason: WorkspaceModeDisabled | null };
  readonly askReadiness: { canBind: boolean; reason: WorkspaceModeDisabled | null };
  /** Convenience flag — frontend uses it to short-circuit "import a repo" CTAs. */
  readonly hasAttachedRepo: boolean;
  /** Convenience flag — frontend uses it to gate first-system-design UI. */
  readonly hasAtLeastOneArtifact: boolean;
}

// ─── Internal helpers ─────────────────────────────────────────────────────

/**
 * Maps the centralized sandbox availability result onto the resolver's
 * input domain. Mirrors the same translation used by `threadContext.ts`'s
 * chat-mode read path so both queries report the same lifecycle state for
 * the same sandbox doc.
 */
function toChatModeSandboxStatus(status: SandboxModeStatus | null): ChatModeSandboxStatus {
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

/**
 * Plan 10 — derive the cost-cap gate from a peek of both the per-user and
 * per-workspace daily buckets, plus return the budget snapshots for the UI.
 *
 * Both peeks happen inside the surrounding query's transaction so the gate
 * decision and the displayed budget agree even under concurrent settlement.
 *
 * Same precedence rule as `threadContext.computeSandboxCostBudgets`: user
 * cap blocks first (more user-actionable than the workspace cap, which
 * also gates every other workspace member). Kept identical so the
 * workspace-mode read path reports the same gate the per-thread chat-mode
 * read path reports for the same caller.
 */
async function computeSandboxCostCapGate(
  ctx: QueryCtx,
  ownerTokenIdentifier: string,
  workspaceId: Id<"workspaces"> | null,
): Promise<SandboxCostCapGate> {
  const estimateCents = getSandboxReplyEstimateCents();
  const userBudget = await peekSandboxDailyCostForUser(ctx, ownerTokenIdentifier);

  if (userBudget.remainingCents < estimateCents) {
    return {
      enabled: false,
      reason: "user_daily_cap_exceeded",
      tooltip: DISABLED_REASON_SANDBOX_USER_CAP_EXCEEDED,
      resetAtMs: userBudget.resetAtMs,
    };
  }
  if (workspaceId) {
    const workspaceBudget = await peekSandboxDailyCostForWorkspace(ctx, workspaceId);
    if (workspaceBudget.remainingCents < estimateCents) {
      return {
        enabled: false,
        reason: "workspace_daily_cap_exceeded",
        tooltip: DISABLED_REASON_SANDBOX_WORKSPACE_CAP_EXCEEDED,
        resetAtMs: workspaceBudget.resetAtMs,
      };
    }
  }
  return { enabled: true };
}

/**
 * Derive the structured `code` for a Lab-disabled state from the same input
 * matrix the resolver used. The resolver returns string `disabledReasons`;
 * this helper extracts the matching code so write-path callers can branch
 * on it without regex-matching the message.
 *
 * Precedence mirrors the resolver exactly (cost cap → lifecycle): the
 * cost-cap gate wins over lifecycle tooltips because the cap is the more
 * actionable signal for a viewer who already has a healthy sandbox.
 */
function deriveLabDisabledCode(args: {
  hasAttachedRepo: boolean;
  sandboxStatus: ChatModeSandboxStatus;
  sandboxCostCapGate: SandboxCostCapGate;
}): WorkspaceModeDisabledReasonCode {
  if (!args.sandboxCostCapGate.enabled) {
    return args.sandboxCostCapGate.reason === "user_daily_cap_exceeded"
      ? "sandbox_user_cap_exceeded"
      : "sandbox_workspace_cap_exceeded";
  }
  if (!args.hasAttachedRepo) {
    return "no_repository_attached";
  }
  switch (args.sandboxStatus) {
    case "provisioning":
      return "sandbox_provisioning";
    case "expired":
      return "sandbox_expired";
    case "failed":
      return "sandbox_failed";
    case "none":
      return "sandbox_missing";
    case "ready":
      // Unreachable: caller only invokes this when lab is in `disabledReasons`,
      // which implies the resolver removed it from `availableModes`.
      throw new Error("deriveLabDisabledCode: sandboxStatus is `ready` but lab is disabled");
  }
}

function deriveLabRetryAfterMs(costCapGate: SandboxCostCapGate, now: number): number | undefined {
  if (!costCapGate.enabled) {
    return Math.max(1, costCapGate.resetAtMs - now);
  }
  return undefined;
}

/**
 * Augment the resolver's string `disabledReasons` into structured
 * `WorkspaceModeDisabled` objects. The resolver knows the `message` (tooltip
 * text); this layer adds the `code` (derived from the same input matrix
 * the resolver used) and the optional `retryAfterMs` (only meaningful for
 * cost-cap codes).
 *
 * Library disabled-reason codes collapse to `no_repository_attached` —
 * the only reason the resolver disables Library after the
 * `hasAtLeastOneArtifact` gate was removed. Lab disabled-reason codes
 * derive via {@link deriveLabDisabledCode} from the (sandboxStatus,
 * gates) matrix.
 *
 * The resolver may surface a mode as disabled even when the message is
 * unknown to us — we keep that contract by wrapping any unfamiliar
 * resolver string under the closest matching code (defensive default).
 */
function augmentResolution(
  resolution: WorkspaceModeResolution,
  inputs: {
    hasAttachedRepo: boolean;
    hasAtLeastOneArtifact: boolean;
    sandboxStatus: ChatModeSandboxStatus;
    sandboxCostCapGate: SandboxCostCapGate;
  },
  now: number,
): {
  disabledReasons: Partial<Record<ChatMode, WorkspaceModeDisabled>>;
  labReadiness: WorkspaceModeEligibility["labReadiness"];
  askReadiness: WorkspaceModeEligibility["askReadiness"];
} {
  const disabledReasons: Partial<Record<ChatMode, WorkspaceModeDisabled>> = {};

  // Discuss is always available — the resolver never disables it. No code
  // needed; the `disabledReasons.discuss` slot stays unset.

  // Library — only one disabled reason after the no-artifact gate was
  // dropped: a missing repository. Empty repos land on the Library page
  // and surface the Generate System Design CTA from the empty state.
  if (resolution.disabledReasons.library !== undefined) {
    disabledReasons.library = {
      code: "no_repository_attached",
      message: resolution.disabledReasons.library,
    };
  }

  // Lab
  if (resolution.disabledReasons.lab !== undefined) {
    const code = deriveLabDisabledCode(inputs);
    const retryAfterMs = deriveLabRetryAfterMs(inputs.sandboxCostCapGate, now);
    disabledReasons.lab = {
      code,
      message: resolution.disabledReasons.lab,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
  }

  // Lab readiness
  let labReadiness: WorkspaceModeEligibility["labReadiness"];
  if (resolution.labReadiness.canStart) {
    labReadiness = { canStart: true, reason: null };
  } else {
    const retryAfterMs = deriveLabRetryAfterMs(inputs.sandboxCostCapGate, now);
    labReadiness = {
      canStart: false,
      reason: {
        code: deriveLabDisabledCode(inputs),
        message: resolution.labReadiness.reason ?? "Lab is unavailable.",
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      },
    };
  }

  // Ask readiness — same disabled codes as Library since Ask is the
  // interactive surface inside Library mode.
  const askReadiness: WorkspaceModeEligibility["askReadiness"] = resolution.askReadiness.canBind
    ? { canBind: true, reason: null }
    : {
        canBind: false,
        reason: {
          code: !inputs.hasAttachedRepo ? "no_repository_attached" : "library_no_artifact",
          message: resolution.askReadiness.reason ?? "Library Ask is unavailable.",
        },
      };

  return { disabledReasons, labReadiness, askReadiness };
}

/**
 * Shared core: given an already-loaded repository (or `null`) plus optional
 * workspace context, compose the verdict. Both the read-path query (which
 * resolves the repo via the workspace) and the write-path assert (which
 * resolves the repo via the thread / direct `repositoryId`) call this.
 *
 * Read set (controls reactive subscription scope on the read path):
 *
 *   - `artifacts` index probe by `repositoryId` if repo attached (1, take(1))
 *   - `sandboxes.<repository.latestSandboxId>` if attached (1)
 *   - rate-limit component peeks (1 user + 1 workspace if both apply)
 *
 * Convex caches indexed reads so the cost is sub-millisecond.
 */
async function evaluateFromRepository(
  ctx: QueryCtx,
  args: {
    repository: Doc<"repositories"> | null;
    workspaceId: Id<"workspaces"> | null | undefined;
    tokenIdentifier: string;
    now: number;
  },
): Promise<WorkspaceModeEligibility> {
  let sandboxModeStatus: SandboxModeStatus | null = null;
  let hasAtLeastOneArtifact = false;

  if (args.repository) {
    // One-row probe via the repo index — cheaper than `.collect()` and
    // still answers the binary "is there any artifact?" question.
    const probe = await ctx.db
      .query("artifacts")
      .withIndex("by_repositoryId", (q) => q.eq("repositoryId", args.repository!._id))
      .take(1);
    hasAtLeastOneArtifact = probe.length > 0;
    const sandbox = args.repository.latestSandboxId ? await ctx.db.get(args.repository.latestSandboxId) : null;
    sandboxModeStatus = getSandboxModeStatus(sandbox);
  }

  let costGate: SandboxCostCapGate = { enabled: true };
  if (args.repository !== null) {
    costGate = await computeSandboxCostCapGate(ctx, args.tokenIdentifier, args.workspaceId ?? null);
  }

  const sandboxStatus = toChatModeSandboxStatus(sandboxModeStatus);
  const hasAttachedRepo = args.repository !== null;

  const resolution = resolveWorkspaceModes(hasAttachedRepo, hasAtLeastOneArtifact, sandboxStatus, costGate);

  const augmented = augmentResolution(
    resolution,
    {
      hasAttachedRepo,
      hasAtLeastOneArtifact,
      sandboxStatus,
      sandboxCostCapGate: costGate,
    },
    args.now,
  );

  return {
    availableModes: resolution.availableModes,
    defaultMode: resolution.defaultMode,
    disabledReasons: augmented.disabledReasons,
    labReadiness: augmented.labReadiness,
    askReadiness: augmented.askReadiness,
    hasAttachedRepo,
    hasAtLeastOneArtifact,
  };
}

// ─── Public surface ────────────────────────────────────────────────────────

/**
 * Public Convex query. The frontend workspace-mode switcher subscribes here;
 * action callers (e.g. Lab `chat.generation.generateAssistantReply`) fetch
 * via `ctx.runQuery(api.workspaceModeEligibility.evaluate, ...)` for an
 * execute-time recheck against the same view the user sees.
 *
 * Returns `null` when the workspace doesn't exist or the viewer doesn't own
 * it. Read set is bounded to the workspace's repo / sandbox / artifact
 * existence + per-user + per-workspace cost-cap peeks so the reactive
 * subscription only invalidates when something user-visible changes.
 */
export const evaluate = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args): Promise<WorkspaceModeEligibility | null> => {
    const identity = await requireViewerIdentity(ctx);
    const workspace = await ctx.db.get(args.workspaceId);
    if (!workspace || workspace.ownerTokenIdentifier !== identity.tokenIdentifier) {
      return null;
    }
    const repository = workspace.repositoryId ? await ctx.db.get(workspace.repositoryId) : null;
    return await evaluateFromRepository(ctx, {
      repository,
      workspaceId: args.workspaceId,
      tokenIdentifier: identity.tokenIdentifier,
      now: Date.now(),
    });
  },
});

/**
 * Pure assertion that throws a structured `ConvexError` when `verdict`
 * disables `mode`. Safe to call from any context; the resolver does not
 * touch `ctx`. Use from action callers after a `ctx.runQuery(evaluate, ...)`
 * when verdict-aware control flow is needed (e.g. tolerating an emergency
 * feature-flag flip mid-flight). Mutation callers should prefer
 * {@link assertWorkspaceModeEligible}, which bundles the load + assert.
 */
export function throwIfDisabled(verdict: WorkspaceModeEligibility, mode: ChatMode): void {
  if (verdict.availableModes.includes(mode)) return;
  const reason = verdict.disabledReasons[mode];
  if (!reason) {
    throw new ConvexError({
      code: "workspace_mode_unavailable",
      mode,
      message: `'${mode}' mode is unavailable.`,
    });
  }
  throw new ConvexError({
    code: reason.code,
    mode,
    message: reason.message,
    ...(reason.retryAfterMs !== undefined ? { retryAfterMs: reason.retryAfterMs } : {}),
  });
}

/**
 * Mutation-context sugar: load the eligibility verdict for `args.repositoryId`
 * (with `args.workspaceId` contributing to the workspace cost-cap key when
 * present) and throw a structured `ConvexError` if `args.mode` is disabled.
 *
 * Takes both `repositoryId` and `workspaceId` so the caller (typically
 * `chat/send.ts` working from a `thread` doc) can pass the thread's existing
 * pointers without having to first dereference the workspace. Either or
 * both may be `null` / `undefined`:
 *
 *   - `repositoryId === null`: treated as no repo attached. Library / Lab
 *     are denied with `no_repository_attached`; Discuss short-circuits.
 *   - `workspaceId === null`: per-workspace cost cap is skipped (the
 *     per-user cap still applies). Legacy threads without a workspace
 *     therefore still get Lab eligibility checks; only the workspace-
 *     scoped cost cap is skipped (it has no key without a workspace).
 *
 * A non-null `repositoryId` whose row the viewer doesn't own surfaces as
 * `RepositoryNotFound` — same opaque-not-found contract the existing
 * `chat.send` mutation uses for thread/repo ownership mismatches.
 */
export async function assertWorkspaceModeEligible(
  ctx: MutationCtx,
  args: {
    repositoryId: Id<"repositories"> | null | undefined;
    workspaceId: Id<"workspaces"> | null | undefined;
    mode: ChatMode;
  },
): Promise<void> {
  // Identity check first so unsigned-in callers always get the same
  // "must sign in" error regardless of the mode they tried to assert.
  const identity = await requireViewerIdentity(ctx);
  if (args.mode === "discuss") return;
  if (!args.repositoryId) {
    throw new ConvexError({
      code: "no_repository_attached",
      mode: args.mode,
      message: `'${args.mode}' mode requires an attached repository.`,
    });
  }
  const repository = await ctx.db.get(args.repositoryId);
  if (!repository || repository.ownerTokenIdentifier !== identity.tokenIdentifier) {
    throw new ConvexError({
      code: "RepositoryNotFound",
      message: "Repository not found.",
    });
  }
  const verdict = await evaluateFromRepository(ctx, {
    repository,
    workspaceId: args.workspaceId ?? null,
    tokenIdentifier: identity.tokenIdentifier,
    now: Date.now(),
  });
  // Library mode is read-mostly: navigation is available whenever a repo is
  // attached (the empty Library page surfaces a Generate System Design CTA),
  // but the write surface — Library Ask — still needs at least one indexed
  // artifact to retrieve against. Defer to askReadiness so the write-path
  // contract stays tied to the actual RAG precondition.
  if (args.mode === "library" && !verdict.askReadiness.canBind && verdict.askReadiness.reason) {
    throw new ConvexError({
      code: verdict.askReadiness.reason.code,
      mode: "library",
      message: verdict.askReadiness.reason.message,
    });
  }
  // Lab navigation is available whenever a repo is attached, but a lab
  // session can only *run* once the sandbox is provisioned and `ready`
  // (and the daily cost cap is open). Defer to `labReadiness` so the
  // write path stays tied to the real sandbox precondition — the same
  // navigation/write split Library uses with `askReadiness` above.
  if (args.mode === "lab" && !verdict.labReadiness.canStart && verdict.labReadiness.reason) {
    throw new ConvexError({
      code: verdict.labReadiness.reason.code,
      mode: "lab",
      message: verdict.labReadiness.reason.message,
      ...(verdict.labReadiness.reason.retryAfterMs !== undefined
        ? { retryAfterMs: verdict.labReadiness.reason.retryAfterMs }
        : {}),
    });
  }
  throwIfDisabled(verdict, args.mode);
}
