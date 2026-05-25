/**
 * Workspace mode eligibility — runtime evaluator for the (Discuss / Library)
 * mode pair at workspace scope, with per-axis grounding-toggle availability
 * for the Discuss composer.
 *
 * Owns the runtime composition for "can this viewer use mode X for this
 * workspace right now?" — load workspace + repository + sandbox doc +
 * artifact existence + sandbox cost cap (rate-limit peek), then run them
 * through the pure {@link resolveWorkspaceModes} resolver in
 * `lib/chatEligibility.ts` and augment the resolver's string
 * `disabledReasons` with structured `{ code, message }` objects so
 * write-path callers can throw structured `ConvexError`s.
 *
 * Three exposed seams:
 *
 *   1. {@link evaluate} — public Convex query. UI subscribes; action callers
 *      fetch via `ctx.runQuery(api.workspaceModeEligibility.evaluate, ...)`.
 *   2. {@link assertWorkspaceModeEligible} — mutation-context sugar. Throws a
 *      structured `ConvexError` when the caller-supplied mode is disabled.
 *   3. {@link throwIfDisabled} — pure assertion over a verdict + mode. Action
 *      callers compose `runQuery` + this when they need verdict-aware control
 *      flow before deciding to throw.
 *
 * The pure {@link resolveWorkspaceModes} resolver is the internal seam — it
 * stays in `lib/chatEligibility.ts` and trivially testable; this module only
 * adds the runtime loading + structured-reason augmentation around it. The
 * sandbox-status translation and cost-cap precedence rule also live in
 * `lib/chatEligibility.ts` so the per-thread `threadContext.getThreadContext`
 * read path and this per-workspace read path cannot drift.
 *
 * Verdicts deliberately carry no `retryAfterMs?` field. Reactive
 * subscriptions update naturally when the underlying state flips (budget
 * resets, sandbox readies, artifact appears); a parallel retry timer would
 * just drift from the actual wall-clock event. Lifecycle-truth timing
 * (e.g. "Daily cap resets at midnight UTC") lives on the cost-budget
 * snapshot in `threadContext.ts`, not on the eligibility verdict.
 */

import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  computeSandboxCostCapEvaluation,
  resolveWorkspaceModes,
  toChatModeSandboxStatus,
  type ChatModeSandboxStatus,
  type SandboxCostCapGate,
  type WorkspaceModeResolution,
} from "./lib/chatEligibility";
import type { ChatMode } from "./lib/chatMode";
import { requireViewerIdentity } from "./lib/auth";
import { getRepositorySandboxStatus, type SandboxModeStatus } from "./lib/repositorySandbox";

// ─── Types ────────────────────────────────────────────────────────────────

/**
 * Stable enum of *why* a mode (or grounding axis) is disabled at workspace
 * scope. Exists so write-path callers can branch on `code` (e.g. render a
 * "Resets at midnight UTC" countdown for cost-cap codes via the cost-budget
 * snapshot) instead of regex-matching tooltip strings.
 *
 * Codes are deliberately disjoint — the pure resolver in
 * `lib/chatEligibility.ts` enumerates the possible disabled states; this
 * enum names each one.
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
}

/**
 * Per-axis grounding availability for the Discuss composer. Each axis
 * collapses the underlying preconditions (repo attached, artifact exists,
 * sandbox lifecycle, cost cap) into a single yes/no plus reason, so the
 * composer can render the toggle bar without re-deriving the rules.
 */
export interface GroundingAxisAvailability {
  readonly available: boolean;
  readonly reason: WorkspaceModeDisabled | null;
  /**
   * Sandbox-only: when `available` is false but the user can still click
   * the toggle to lazily provision a sandbox. The composer renders an
   * "Activate sandbox" CTA in that case.
   */
  readonly isActivatable?: boolean;
}

export interface WorkspaceModeEligibility {
  readonly availableModes: ReadonlyArray<ChatMode>;
  readonly defaultMode: ChatMode;
  readonly disabledReasons: Partial<Record<ChatMode, WorkspaceModeDisabled>>;
  /**
   * Grounding-toggle availability for the Discuss composer. The two axes
   * are independent: the user can enable either or both. Library Mode
   * does not consult this — its grounding is implicit in the mode.
   */
  readonly grounding: {
    readonly library: GroundingAxisAvailability;
    readonly sandbox: GroundingAxisAvailability;
  };
  readonly askReadiness: { canBind: boolean; reason: WorkspaceModeDisabled | null };
  /** Convenience flag — frontend uses it to short-circuit "import a repo" CTAs. */
  readonly hasAttachedRepo: boolean;
  /** Convenience flag — frontend uses it to gate first-system-design UI. */
  readonly hasAtLeastOneArtifact: boolean;
}

// ─── Internal helpers ─────────────────────────────────────────────────────

/**
 * Derive the structured `code` for a sandbox-grounding disabled state
 * from the same input matrix the resolver used. The resolver returns
 * string `reason` text; this helper extracts the matching code so write-
 * path callers and the composer can branch on it without regex-matching
 * the message.
 *
 * Precedence mirrors the resolver exactly (cost cap → lifecycle): the
 * cost-cap gate wins over lifecycle tooltips because the cap is the more
 * actionable signal for a viewer who already has a healthy sandbox.
 */
function deriveSandboxGroundingCode(args: {
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
      throw new Error("deriveSandboxGroundingCode: sandboxStatus is `ready` but sandbox grounding is disabled");
  }
}

/**
 * Augment the resolver's string `disabledReasons` and grounding axes into
 * structured `WorkspaceModeDisabled` objects. The resolver knows the
 * `message` (tooltip text); this layer adds the `code` (derived from the
 * same input matrix the resolver used) so write-path callers branch on
 * `code` instead of pattern-matching prose.
 */
function augmentResolution(
  resolution: WorkspaceModeResolution,
  inputs: {
    hasAttachedRepo: boolean;
    hasAtLeastOneArtifact: boolean;
    sandboxStatus: ChatModeSandboxStatus;
    sandboxCostCapGate: SandboxCostCapGate;
  },
): {
  disabledReasons: Partial<Record<ChatMode, WorkspaceModeDisabled>>;
  grounding: WorkspaceModeEligibility["grounding"];
  askReadiness: WorkspaceModeEligibility["askReadiness"];
} {
  const disabledReasons: Partial<Record<ChatMode, WorkspaceModeDisabled>> = {};

  if (resolution.disabledReasons.library !== undefined) {
    disabledReasons.library = {
      code: "no_repository_attached",
      message: resolution.disabledReasons.library,
    };
  }

  const libraryAxis = resolution.grounding.library;
  const sandboxAxis = resolution.grounding.sandbox;

  const libraryAvailability: WorkspaceModeEligibility["grounding"]["library"] = libraryAxis.available
    ? { available: true, reason: null }
    : {
        available: false,
        reason: {
          code: !inputs.hasAttachedRepo ? "no_repository_attached" : "library_no_artifact",
          message: libraryAxis.reason ?? "Library grounding is unavailable.",
        },
      };

  const sandboxAvailability: WorkspaceModeEligibility["grounding"]["sandbox"] = sandboxAxis.available
    ? { available: true, reason: null, isActivatable: false }
    : {
        available: false,
        reason: {
          code: deriveSandboxGroundingCode(inputs),
          message: sandboxAxis.reason ?? "Sandbox grounding is unavailable.",
        },
        isActivatable: sandboxAxis.isActivatable,
      };

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

  return {
    disabledReasons,
    grounding: { library: libraryAvailability, sandbox: sandboxAvailability },
    askReadiness,
  };
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
    sandboxModeStatus = (await getRepositorySandboxStatus(ctx, args.repository)).sandboxModeStatus;
  }

  let costGate: SandboxCostCapGate = { enabled: true };
  if (args.repository !== null) {
    const evaluation = await computeSandboxCostCapEvaluation(ctx, args.tokenIdentifier, args.workspaceId ?? null);
    costGate = evaluation.gate;
  }

  const sandboxStatus = toChatModeSandboxStatus(sandboxModeStatus);
  const hasAttachedRepo = args.repository !== null;

  const resolution = resolveWorkspaceModes(hasAttachedRepo, hasAtLeastOneArtifact, sandboxStatus, costGate);

  const augmented = augmentResolution(resolution, {
    hasAttachedRepo,
    hasAtLeastOneArtifact,
    sandboxStatus,
    sandboxCostCapGate: costGate,
  });

  return {
    availableModes: resolution.availableModes,
    defaultMode: resolution.defaultMode,
    disabledReasons: augmented.disabledReasons,
    grounding: augmented.grounding,
    askReadiness: augmented.askReadiness,
    hasAttachedRepo,
    hasAtLeastOneArtifact,
  };
}

// ─── Public surface ────────────────────────────────────────────────────────

/**
 * Public Convex query. The frontend workspace-mode switcher subscribes here;
 * action callers fetch via
 * `ctx.runQuery(api.workspaceModeEligibility.evaluate, ...)` for an
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
    });
  },
});

/**
 * Pure assertion that throws a structured `ConvexError` when `verdict`
 * disables `mode`. Safe to call from any context; the resolver does not
 * touch `ctx`. Use from action callers after a `ctx.runQuery(evaluate, ...)`
 * when verdict-aware control flow is needed. Mutation callers should
 * prefer {@link assertWorkspaceModeEligible}, which bundles the load +
 * assert.
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
  });
}

/**
 * Mutation-context sugar: load the eligibility verdict for `args.repositoryId`
 * (with `args.workspaceId` contributing to the workspace cost-cap key when
 * present) and throw a structured `ConvexError` if `args.mode` or the
 * requested grounding axes are disabled.
 *
 * Takes both `repositoryId` and `workspaceId` so the caller (typically
 * `chat/send.ts` working from a `thread` doc) can pass the thread's existing
 * pointers without having to first dereference the workspace. Either or
 * both may be `null` / `undefined`:
 *
 *   - `repositoryId === null`: treated as no repo attached. Library is
 *     denied with `no_repository_attached`; Discuss is allowed only when
 *     no grounding flags are requested.
 *   - `workspaceId === null`: per-workspace cost cap is skipped (the
 *     per-user cap still applies).
 *
 * Grounding flags (`groundLibrary` / `groundSandbox`) are validated only
 * for `mode === "discuss"` turns; Library-mode callers can pass `false`
 * for both (Library grounding is implicit in the mode).
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
    groundLibrary?: boolean;
    groundSandbox?: boolean;
  },
): Promise<void> {
  // Identity check first so unsigned-in callers always get the same
  // "must sign in" error regardless of the mode they tried to assert.
  const identity = await requireViewerIdentity(ctx);
  const groundLibrary = args.mode === "discuss" && args.groundLibrary === true;
  const groundSandbox = args.mode === "discuss" && args.groundSandbox === true;

  // Discuss with no grounding flags has no preconditions beyond auth.
  if (args.mode === "discuss" && !groundLibrary && !groundSandbox) {
    return;
  }
  if (!args.repositoryId) {
    throw new ConvexError({
      code: "no_repository_attached",
      mode: args.mode,
      message:
        args.mode === "library"
          ? "Library mode requires an attached repository."
          : "Library / Sandbox grounding requires an attached repository.",
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

  if (groundLibrary && !verdict.grounding.library.available && verdict.grounding.library.reason) {
    const reason = verdict.grounding.library.reason;
    throw new ConvexError({
      code: reason.code,
      mode: "discuss",
      message: reason.message,
    });
  }
  if (groundSandbox && !verdict.grounding.sandbox.available && verdict.grounding.sandbox.reason) {
    const reason = verdict.grounding.sandbox.reason;
    throw new ConvexError({
      code: reason.code,
      mode: "discuss",
      message: reason.message,
    });
  }

  throwIfDisabled(verdict, args.mode);
}
