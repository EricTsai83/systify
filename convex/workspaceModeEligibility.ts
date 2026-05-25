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
  type AxisVerdict,
  type SandboxCostCapGate,
  type SandboxGroundingVerdict,
} from "./lib/chatEligibility";
import type { ChatMode } from "./lib/chatMode";
import { requireViewerIdentity } from "./lib/auth";
import { getRepositorySandboxStatus, type SandboxModeStatus } from "./lib/repositorySandbox";

// ─── Types ────────────────────────────────────────────────────────────────

export type { WorkspaceModeDisabledReasonCode } from "./lib/chatEligibility";

export interface WorkspaceModeEligibility {
  readonly modes: {
    readonly discuss: AxisVerdict;
    readonly library: AxisVerdict;
  };
  readonly defaultMode: ChatMode;
  readonly grounding: {
    readonly library: AxisVerdict;
    readonly sandbox: SandboxGroundingVerdict;
  };
  readonly askReadiness: AxisVerdict;
  /** Convenience flag — frontend uses it to short-circuit "import a repo" CTAs. */
  readonly hasAttachedRepo: boolean;
  /** Convenience flag — frontend uses it to gate first-system-design UI. */
  readonly hasAtLeastOneArtifact: boolean;
}

// ─── Internal helpers ─────────────────────────────────────────────────────

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

  return {
    modes: resolution.modes,
    defaultMode: resolution.defaultMode,
    grounding: resolution.grounding,
    askReadiness: resolution.askReadiness,
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
  const verdictForMode = verdict.modes[mode];
  if (verdictForMode.enabled) return;
  throw new ConvexError({
    code: verdictForMode.code,
    mode,
    message: verdictForMode.message,
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
  const identity = await requireViewerIdentity(ctx);
  const groundLibrary = args.mode === "discuss" && args.groundLibrary === true;
  const groundSandbox = args.mode === "discuss" && args.groundSandbox === true;

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

  if (args.mode === "library") {
    const askReadiness = verdict.askReadiness;
    if (!askReadiness.enabled) {
      throw new ConvexError({
        code: askReadiness.code,
        mode: "library",
        message: askReadiness.message,
      });
    }
  }

  if (groundLibrary) {
    const libraryAxis = verdict.grounding.library;
    if (!libraryAxis.enabled) {
      throw new ConvexError({
        code: libraryAxis.code,
        mode: "discuss",
        message: libraryAxis.message,
      });
    }
  }
  if (groundSandbox) {
    const sandboxAxis = verdict.grounding.sandbox;
    if (!sandboxAxis.enabled) {
      throw new ConvexError({
        code: sandboxAxis.code,
        mode: "discuss",
        message: sandboxAxis.message,
      });
    }
  }

  throwIfDisabled(verdict, args.mode);
}
