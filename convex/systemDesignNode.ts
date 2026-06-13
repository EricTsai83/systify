"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import type { LlmProvider } from "./lib/llmProvider";
import { logInfo } from "./lib/observability";
import {
  prepareSandboxLibraryGeneration,
  resolveSandboxLibraryGenerationModelChoice,
  SYSTEM_DESIGN_SANDBOX_STAGE_LABELS,
  type SandboxLibraryGenerationModelChoice,
} from "./lib/sandboxLibraryGeneration";
import { SandboxPreparationError, type EnsureSandboxReadyResult } from "./lib/sandboxLiveness";
import { isSystemDesignKind, systemDesignKindValidator } from "./lib/systemDesign";
import { runSystemDesignKind } from "./systemDesignKindRun";

/**
 * Library System Design generator.
 *
 * Every kind is LLM-backed: the action prepares a Daytona sandbox once via
 * `ensureSandboxReady`, then calls the System Design kind-run Module once
 * per selected kind. That Module owns the `generateViaGateway` call against
 * the sandbox-backed model with the same `read_file` / `list_dir` /
 * `run_shell` tool factory the chat-sandbox path uses. Kinds run serially
 * to honour the per-sandbox tool budget and the gateway's per-user
 * concurrency cap; the job lease is refreshed before each one so a long
 * publication (e.g. all seven kinds with high step budgets) does not trip
 * the stale-recovery sweep while the action is still making progress.
 *
 * **Per-kind lifecycle** (inside the kind-run Module):
 *
 *   1. Refresh lease.
 *   2. Cache probe via `findCachedArtifact` keyed on
 *      `(repo, kind, commit, provider, model, promptVersion)`. A hit
 *      records a `cached_hit` kindRun and skips the LLM call entirely.
 *   3. Sandbox-cost pre-check via `assertKindCostBudget`. Throws on
 *      cap exhaustion; caught and recorded as `transport_rate_limit`.
 *   4. `generateViaGateway` call. Provider dispatch, rate-limit acquire,
 *      retry, normalized usage all happen inside the gateway.
 *   5. Quality gate: section presence + (for `architecture_diagram`)
 *      mermaid block presence. Rejection records `quality_rejected`.
 *   6. Publication Settlement via `finalizeKindPublication`. Cache hits,
 *      generated markdown, quality rejects, and generation failures all pass
 *      through this single mutation. It validates the active write target,
 *      writes any artifact/kindRun rows, appends failure summaries, settles
 *      actual usage for paid outcomes, and patches the artifact -> kindRun
 *      back-reference when a new artifact is published.
 *   7. Per-kind metrics (duration, cost, steps).
 *
 * Per-kind failures are isolated: the catch translates the error into a
 * `failureReason` literal and hands the failure outcome to publication
 * settlement; the loop then continues to the next kind. Progress flows back
 * through `updateGenerationProgress` after every kind completes (success,
 * cache hit, or fail). If sandbox preparation fails up front the whole run is
 * failed with the structured `userFacingMessage` and no kinds run.
 */
export const runSystemDesignGeneration = internalAction({
  args: {
    jobId: v.id("jobs"),
    repositoryId: v.id("repositories"),
    ownerTokenIdentifier: v.string(),
    selections: v.array(systemDesignKindValidator),
    /**
     * When `true`, skip the per-kind cache probe and re-run every
     * selected kind through the LLM. The Generate dialog's "Regenerate
     * even if cached" checkbox flips this on. Auto-resume from
     * stale-recovery always passes `false` — the cache from the original
     * attempt is intentionally trusted so resume only pays for the
     * incomplete kinds.
     */
    forceRegenerate: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const start = await ctx.runMutation(internal.systemDesign.markGenerationStarted, {
      jobId: args.jobId,
      selections: args.selections,
    });
    if (!start.started) {
      return;
    }

    const context = await ctx.runQuery(internal.systemDesign.getGenerationContext, {
      repositoryId: args.repositoryId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
    });

    if (context === null) {
      await ctx.runMutation(internal.systemDesign.failGeneration, {
        jobId: args.jobId,
        errorMessage: "Repository was deleted before the generation could start.",
      });
      return;
    }

    const selections = args.selections.filter(isSystemDesignKind);
    const totalCount = selections.length;

    if (totalCount === 0) {
      await ctx.runMutation(internal.systemDesign.failGeneration, {
        jobId: args.jobId,
        errorMessage: "No valid system design kinds selected.",
      });
      return;
    }

    // Job-baked LLM pick. Pinned at request time so a resume picks up
    // the same pair and the cache key (artifacts.generatedByProvider /
    // generatedByModel) stays consistent across attempts.
    const modelChoice = await ctx.runQuery(internal.systemDesign.getJobModelChoice, {
      jobId: args.jobId,
    });
    const resolvedModelChoice = resolveSandboxLibraryGenerationModelChoice({
      provider: modelChoice.provider,
      modelName: modelChoice.modelName,
      reasoningEffort: modelChoice.reasoningEffort,
      missingSelectionMessage: "System Design job is missing its model selection.",
    });

    // Every kind reads live source through the sandbox, so the run always
    // needs a ready sandbox. `ensureSandboxReady` probes / wakes / provisions
    // / clones as needed and reports each stage as job progress. On failure
    // the whole run is failed with the structured `userFacingMessage` — no
    // kinds run, because the user requested them together. The returned
    // `EnsureSandboxReadyResult` already carries the post-clone `remoteId`
    // and `repoPath`, so the per-kind LLM passes consume `prepared`
    // directly without a redundant DB re-fetch.
    let prepared: EnsureSandboxReadyResult;
    try {
      prepared = await prepareSandboxLibraryGeneration(ctx, {
        repositoryId: args.repositoryId,
        ownerTokenIdentifier: args.ownerTokenIdentifier,
        onStage: async (stage) => {
          await ctx.runMutation(internal.systemDesign.updateGenerationProgress, {
            jobId: args.jobId,
            completedCount: 0,
            totalCount,
            stage: SYSTEM_DESIGN_SANDBOX_STAGE_LABELS[stage],
          });
        },
      });
    } catch (error) {
      if (error instanceof SandboxPreparationError) {
        await ctx.runMutation(internal.systemDesign.failGeneration, {
          jobId: args.jobId,
          errorMessage: error.userFacingMessage,
        });
        logInfo("systemDesign", "generation_failed_sandbox_prep", {
          jobId: args.jobId,
          repositoryId: args.repositoryId,
          reason: error.reason,
        });
        return;
      }
      throw error;
    }

    const commitSha = context.repository.lastSyncedCommitSha;
    const forceRegenerate = args.forceRegenerate ?? false;

    let completedCount = 0;
    let succeeded = 0;
    let failed = 0;

    // Kinds run serially: each one is a sandbox-backed LLM session, so running
    // them in parallel would contend on the per-sandbox tool budget and the
    // gateway's per-user concurrency cap.
    for (const kind of selections) {
      // Refresh the running job's lease before each kind so a long multi-kind
      // publication does not overrun the lease window and trigger a spurious
      // stale-recovery while progress is still happening.
      await ctx.runMutation(internal.systemDesign.refreshGenerationLease, { jobId: args.jobId });

      const outcome = await runSystemDesignKind(ctx, {
        jobId: args.jobId,
        repositoryId: args.repositoryId,
        ownerTokenIdentifier: args.ownerTokenIdentifier,
        kind,
        repository: context.repository,
        prepared,
        modelChoice: resolvedModelChoice,
        commitSha,
        forceRegenerate,
      });

      if (outcome.aborted) {
        await ctx.runMutation(internal.systemDesign.failGeneration, {
          jobId: args.jobId,
          errorMessage: "System Design generation stopped because the repository is no longer active.",
        });
        return;
      }

      if (outcome.countsAsSucceeded) {
        succeeded += 1;
      } else {
        failed += 1;
      }
      completedCount += 1;
      await ctx.runMutation(internal.systemDesign.updateGenerationProgress, {
        jobId: args.jobId,
        completedCount,
        totalCount,
        stage: `Generated ${completedCount} of ${totalCount}: ${outcome.title}`,
      });
    }

    await ctx.runMutation(internal.systemDesign.completeGeneration, {
      jobId: args.jobId,
      selections: args.selections,
      succeededCount: succeeded,
      failedCount: failed,
    });

    logInfo("systemDesign", "generation_complete", {
      jobId: args.jobId,
      repositoryId: args.repositoryId,
      provider: resolvedModelChoice.provider,
      modelName: resolvedModelChoice.modelName,
      succeeded,
      failed,
      total: totalCount,
    });
  },
});

/**
 * Type-only re-export for downstream eval / report callers that want
 * to discriminate kindRun statuses without re-deriving the union from
 * the schema document.
 */
export type { LlmProvider, SandboxLibraryGenerationModelChoice };
