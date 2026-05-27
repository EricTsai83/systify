/**
 * Repository mode eligibility — runtime evaluator for the (Discuss / Library)
 * mode pair at repository scope, with per-axis grounding-toggle availability
 * for the Discuss composer.
 *
 * Owns the runtime composition for "can this viewer use mode X for this
 * repository right now?" — load repository + sandbox doc + artifact
 * existence + sandbox cost cap (rate-limit peek), then run them through the
 * pure {@link resolveRepositoryModes} resolver in `lib/chatEligibility.ts`
 * and augment the resolver's string `disabledReasons` with structured
 * `{ code, message }` objects so write-path callers can throw structured
 * `ConvexError`s.
 *
 * Three exposed seams:
 *
 *   1. {@link evaluate} — public Convex query. UI subscribes; action callers
 *      fetch via `ctx.runQuery(api.repositoryModeEligibility.evaluate, ...)`.
 *   2. {@link assertRepositoryModeEligible} — mutation-context sugar. Throws
 *      a structured `ConvexError` when the caller-supplied mode is disabled.
 *   3. {@link throwIfDisabled} — pure assertion over a verdict + mode.
 */

import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  computeSandboxCostCapEvaluation,
  resolveRepositoryModes,
  toChatModeSandboxStatus,
  type AxisVerdict,
  type SandboxCostCapGate,
  type SandboxGroundingVerdict,
} from "./lib/chatEligibility";
import type { ChatMode } from "./lib/chatMode";
import { requireViewerIdentity } from "./lib/auth";
import { getRepositorySandboxStatus, type SandboxModeStatus } from "./lib/repositorySandbox";

// ─── Types ────────────────────────────────────────────────────────────────

export type { RepositoryModeDisabledReasonCode } from "./lib/chatEligibility";

export interface RepositoryModeEligibility {
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
 * Shared core: given an already-loaded repository (or `null`), compose the
 * verdict. Both the read-path query and the write-path assert call this.
 */
async function evaluateFromRepository(
  ctx: QueryCtx,
  args: {
    repository: Doc<"repositories"> | null;
    tokenIdentifier: string;
  },
): Promise<RepositoryModeEligibility> {
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
    const evaluation = await computeSandboxCostCapEvaluation(ctx, args.tokenIdentifier, args.repository._id);
    costGate = evaluation.gate;
  }

  const sandboxStatus = toChatModeSandboxStatus(sandboxModeStatus);
  const hasAttachedRepo = args.repository !== null;

  const resolution = resolveRepositoryModes(hasAttachedRepo, hasAtLeastOneArtifact, sandboxStatus, costGate);

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
 * Public Convex query. The frontend repository-mode switcher subscribes
 * here; action callers fetch via
 * `ctx.runQuery(api.repositoryModeEligibility.evaluate, ...)` for an
 * execute-time recheck against the same view the user sees.
 *
 * Returns `null` when the repository doesn't exist or the viewer doesn't
 * own it. The `args.repositoryId === undefined` branch returns the no-repo
 * verdict so repoless callers see a consistent set of disabled-reason
 * codes.
 */
export const evaluate = query({
  args: { repositoryId: v.optional(v.id("repositories")) },
  handler: async (ctx, args): Promise<RepositoryModeEligibility | null> => {
    const identity = await requireViewerIdentity(ctx);
    if (!args.repositoryId) {
      return await evaluateFromRepository(ctx, {
        repository: null,
        tokenIdentifier: identity.tokenIdentifier,
      });
    }
    const repository = await ctx.db.get(args.repositoryId);
    if (!repository || repository.ownerTokenIdentifier !== identity.tokenIdentifier) {
      return null;
    }
    return await evaluateFromRepository(ctx, {
      repository,
      tokenIdentifier: identity.tokenIdentifier,
    });
  },
});

/**
 * Pure assertion that throws a structured `ConvexError` when `verdict`
 * disables `mode`. Safe to call from any context.
 */
export function throwIfDisabled(verdict: RepositoryModeEligibility, mode: ChatMode): void {
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
 * and throw a structured `ConvexError` if `args.mode` or the requested
 * grounding axes are disabled.
 *
 *   - `repositoryId === null`: treated as no repo attached. Library is
 *     denied with `no_repository_attached`; Discuss is allowed only when
 *     no grounding flags are requested.
 *
 * Grounding flags (`groundLibrary` / `groundSandbox`) are validated only
 * for `mode === "discuss"` turns; Library-mode callers can pass `false`
 * for both (Library grounding is implicit in the mode).
 *
 * A non-null `repositoryId` whose row the viewer doesn't own surfaces as
 * `RepositoryNotFound`.
 */
export async function assertRepositoryModeEligible(
  ctx: MutationCtx,
  args: {
    repositoryId: Id<"repositories"> | null | undefined;
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
