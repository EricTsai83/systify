"use node";

import { APICallError, stepCountIs } from "ai";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import { createSandboxTools } from "./chat/sandboxTools";
import { getSandboxFsClient } from "./daytona";
import { getCatalogEntry } from "./lib/llmCatalog";
import { generateViaGateway, LlmRateLimitError } from "./lib/llmGateway";
import type { LlmProvider, NormalizedUsage } from "./lib/llmProvider";
import {
  ensureSandboxReady,
  type EnsureSandboxReadyResult,
  SandboxPreparationError,
  type SandboxPreparationStage,
} from "./lib/sandboxLiveness";
import { emitMetric, logErrorWithId, logInfo, logWarn } from "./lib/observability";
import { SYSTEM_DESIGN_KIND_TITLES, isSystemDesignKind, systemDesignKindValidator } from "./lib/systemDesign";
import {
  budgetSuffix,
  getKindRunConfig,
  validateMermaidBlock,
  validateRequiredSections,
} from "./lib/systemDesignPrompts";

/**
 * Library System Design generator.
 *
 * Every kind is LLM-backed: the action prepares a Daytona sandbox once via
 * `ensureSandboxReady`, then runs one `generateViaGateway` call per selected
 * kind against the sandbox-backed model with the same `read_file` /
 * `list_dir` / `run_shell` tool factory the chat-sandbox path uses. Kinds
 * run serially to honour the per-sandbox tool budget and the gateway's
 * per-user concurrency cap; the job lease is refreshed before each one so
 * a long publication (e.g. all seven kinds with high step budgets) does
 * not trip the stale-recovery sweep while the action is still making
 * progress.
 *
 * **Per-kind lifecycle** (each pass through the for-loop):
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
 *   6. Persist artifact + telemetry row in two mutations
 *      (`persistGeneratedArtifact` then `recordKindRun`), then patch the
 *      back-reference via `linkKindRun`.
 *   7. Settlement of the day's sandbox cost cap rides inside
 *      `recordKindRun` so the kindRun row and the cap decrement are
 *      atomic.
 *   8. Per-kind metrics (duration, cost, steps).
 *
 * Per-kind failures are isolated: the catch translates the error into a
 * `failureReason` literal, records a structured `kindFailures` entry,
 * and the loop continues to the next kind. Progress flows back through
 * `updateGenerationProgress` after every kind completes (success, cache
 * hit, or fail). If sandbox preparation fails up front the whole run is
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
    const start = (await ctx.runMutation(internal.systemDesign.markGenerationStarted, {
      jobId: args.jobId,
      selections: args.selections,
    })) as { started: boolean };
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
    const catalogEntry = getCatalogEntry(modelChoice.provider, modelChoice.modelName);

    // Every kind reads live source through the sandbox, so the run always
    // needs a ready sandbox. `ensureSandboxReady` probes / wakes / provisions
    // / clones as needed and reports each stage as job progress. On failure
    // the whole run is failed with the structured `userFacingMessage` — no
    // kinds run, because the user requested them together. The returned
    // `EnsureSandboxReadyResult` already carries the post-clone `remoteId`
    // and `repoPath`, so the per-kind LLM passes consume `prepared`
    // directly without a redundant DB re-fetch.
    const stageLabel: Record<SandboxPreparationStage, string> = {
      probing: "Preparing environment for your request…",
      waking: "Waking up the repository sandbox…",
      provisioning: "Setting up the repository sandbox…",
      cloning: "Cloning repository…",
      polling: "Preparing environment for your request…",
    };
    let prepared: EnsureSandboxReadyResult;
    try {
      prepared = await ensureSandboxReady(
        ctx,
        {
          repositoryId: args.repositoryId,
          ownerTokenIdentifier: args.ownerTokenIdentifier,
        },
        async (stage) => {
          await ctx.runMutation(internal.systemDesign.updateGenerationProgress, {
            jobId: args.jobId,
            completedCount: 0,
            totalCount,
            stage: stageLabel[stage] ?? "Preparing environment for your request…",
          });
        },
      );
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

      const startedAt = Date.now();
      const config = getKindRunConfig(kind);

      emitMetric("systemdesign_kind_started", {
        tags: {
          kind,
          provider: modelChoice.provider,
          model: modelChoice.modelName,
          prompt_version: config.promptVersion,
        },
        details: { jobId: args.jobId, repositoryId: args.repositoryId },
      });

      // ── 1. Cache probe ────────────────────────────────────────────────
      let runStatus: Doc<"systemDesignKindRuns">["status"] = "failed";
      let failureReason: ReturnType<typeof classifyLlmError> | undefined;
      let artifactId: Id<"artifacts"> | undefined;
      let usage: NormalizedUsage = {};
      let costUsd: number | undefined;
      let actualSteps = 0;
      let outputCharLength = 0;
      let missingSections: string[] | undefined;

      if (!forceRegenerate && commitSha) {
        const cached = await ctx.runQuery(internal.systemDesign.findCachedArtifact, {
          repositoryId: args.repositoryId,
          kind,
          alignedImportCommitSha: commitSha,
          generatedByProvider: modelChoice.provider,
          generatedByModel: modelChoice.modelName,
          promptVersion: config.promptVersion,
        });
        if (cached) {
          runStatus = "cached_hit";
          artifactId = cached._id;
          outputCharLength = cached.contentMarkdown.length;
          emitMetric("systemdesign_kind_cache_hit", {
            tags: { kind, provider: modelChoice.provider, model: modelChoice.modelName },
            details: { repositoryId: args.repositoryId, commitSha },
          });
        }
      }

      // ── 2. LLM call (skipped on cache hit) ────────────────────────────
      if (runStatus !== "cached_hit") {
        try {
          await ctx.runMutation(internal.systemDesign.assertKindCostBudget, {
            ownerTokenIdentifier: args.ownerTokenIdentifier,
            repositoryId: args.repositoryId,
          });

          const result = await generateViaGateway(
            ctx,
            {
              provider: modelChoice.provider,
              modelName: modelChoice.modelName,
              ownerTokenIdentifier: args.ownerTokenIdentifier,
              capability: "sandbox",
              feature: "system_design",
              jobId: args.jobId,
            },
            {
              system: config.prompt + budgetSuffix(config.stepBudget),
              prompt: buildUserPrompt(context.repository),
              tools: createSandboxTools(await getSandboxFsClient(prepared.remoteId), prepared.repoPath),
              stopWhen: stepCountIs(config.stepBudget),
              reasoningEffort: catalogEntry?.reasoningEffort,
            },
          );

          usage = result.usage;
          costUsd = result.costUsd;
          actualSteps = result.steps.length;
          const text = result.text.trim();
          outputCharLength = text.length;

          if (text.length === 0) {
            runStatus = "failed";
            failureReason = "model_empty_output";
          } else {
            const validation = validateRequiredSections(text, config.expectedSections);
            const mermaidOk = kind !== "architecture_diagram" || validateMermaidBlock(text);
            if (!validation.ok || !mermaidOk) {
              runStatus = "quality_rejected";
              failureReason = "output_quality";
              missingSections = [...validation.missingSections];
              if (!mermaidOk) {
                missingSections.push("mermaid_block");
              }
            } else {
              const persisted = (await ctx.runMutation(internal.systemDesign.persistGeneratedArtifact, {
                repositoryId: args.repositoryId,
                ownerTokenIdentifier: args.ownerTokenIdentifier,
                jobId: args.jobId,
                kind,
                title: SYSTEM_DESIGN_KIND_TITLES[kind],
                summary: extractSummary(text),
                contentMarkdown: text,
                alignedImportCommitSha: commitSha,
                generatedByProvider: modelChoice.provider,
                generatedByModel: modelChoice.modelName,
                promptVersion: config.promptVersion,
              })) as { artifactId: Id<"artifacts"> };
              artifactId = persisted.artifactId;
              runStatus = "succeeded";
            }
          }
        } catch (error) {
          runStatus = "failed";
          failureReason = classifyLlmError(error);
          const errorId = logErrorWithId("systemDesign", "kind_generation_failed", error, {
            jobId: args.jobId,
            repositoryId: args.repositoryId,
            kind,
            provider: modelChoice.provider,
            modelName: modelChoice.modelName,
            failureReason,
          });
          logWarn("systemDesign", "kind_skipped", {
            jobId: args.jobId,
            kind,
            errorId,
            failureReason,
          });
          const rawMessage = error instanceof Error ? error.message : String(error);
          await ctx.runMutation(internal.systemDesign.recordKindFailure, {
            jobId: args.jobId,
            kind,
            errorId,
            message: rawMessage,
            reason: failureReason,
          });
        }
      }

      const durationMs = Date.now() - startedAt;

      // ── 3. Telemetry: kindRun row + cost settlement ───────────────────
      const recorded = (await ctx.runMutation(internal.systemDesign.recordKindRun, {
        ownerTokenIdentifier: args.ownerTokenIdentifier,
        repositoryId: args.repositoryId,
        jobId: args.jobId,
        kind,
        provider: modelChoice.provider,
        modelName: modelChoice.modelName,
        promptVersion: config.promptVersion,
        alignedImportCommitSha: commitSha,
        stepCap: config.stepBudget,
        actualSteps,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        reasoningTokens: usage.reasoningTokens,
        totalCostUsd: costUsd,
        durationMs,
        status: runStatus,
        failureReason,
        outputCharLength: outputCharLength > 0 ? outputCharLength : undefined,
        missingSections,
        startedAt,
      })) as { kindRunId: Id<"systemDesignKindRuns"> };

      if (artifactId && runStatus !== "cached_hit") {
        await ctx.runMutation(internal.systemDesign.linkKindRun, {
          artifactId,
          kindRunId: recorded.kindRunId,
        });
      }

      // ── 4. Per-kind metrics ───────────────────────────────────────────
      emitMetric("systemdesign_kind_duration_ms", {
        value: durationMs,
        tags: {
          kind,
          provider: modelChoice.provider,
          model: modelChoice.modelName,
          status: runStatus,
        },
        details: { jobId: args.jobId },
      });
      emitMetric("systemdesign_kind_steps_used", {
        value: actualSteps,
        tags: {
          kind,
          provider: modelChoice.provider,
          model: modelChoice.modelName,
          hit_budget: actualSteps >= config.stepBudget,
        },
        details: { jobId: args.jobId },
      });
      if (costUsd !== undefined) {
        emitMetric("systemdesign_kind_cost_usd", {
          value: costUsd,
          tags: { kind, provider: modelChoice.provider, model: modelChoice.modelName },
          details: { jobId: args.jobId },
        });
      }
      if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
        emitMetric("systemdesign_kind_tokens", {
          tags: { kind, provider: modelChoice.provider, model: modelChoice.modelName },
          details: {
            input: usage.inputTokens,
            output: usage.outputTokens,
            cached_input: usage.cachedInputTokens,
            cache_write: usage.cacheWriteTokens,
            reasoning: usage.reasoningTokens,
          },
        });
      }
      if (runStatus === "failed" || runStatus === "quality_rejected") {
        emitMetric("systemdesign_kind_failed", {
          tags: {
            kind,
            provider: modelChoice.provider,
            model: modelChoice.modelName,
            reason: failureReason ?? "unknown",
          },
          details: { jobId: args.jobId },
        });
      }

      if (runStatus === "succeeded" || runStatus === "cached_hit") {
        succeeded += 1;
      } else {
        failed += 1;
      }
      completedCount += 1;
      await ctx.runMutation(internal.systemDesign.updateGenerationProgress, {
        jobId: args.jobId,
        completedCount,
        totalCount,
        stage: `Generated ${completedCount} of ${totalCount}: ${SYSTEM_DESIGN_KIND_TITLES[kind]}`,
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
      provider: modelChoice.provider,
      modelName: modelChoice.modelName,
      succeeded,
      failed,
      total: totalCount,
    });
  },
});

/**
 * Map an LLM call exception into one of the structured
 * `kindFailureReason` literals. Order matters:
 *
 *   1. `SandboxPreparationError` — should never reach here (caught
 *      higher up) but kept defensively for safety.
 *   2. `LlmRateLimitError` — gateway-level fairness denial (per-user
 *      RPM or concurrency cap). Distinct from provider 429 but both
 *      surface as `transport_rate_limit` in the kindRun row so the
 *      banner copy works without sniffing the error class.
 *   3. `APICallError` with 429 — provider rate-limited the call past
 *      `withLlmRetry`'s ceiling.
 *   4. `APICallError` other — provider returned a non-429 transport
 *      fault (5xx, 4xx other than 429, network without status).
 *   5. Legacy `empty document` substring — pre-PR-A2 callers threw
 *      this on empty output; keep for backwards compatibility with
 *      historical eval fixtures.
 *   6. Default — `infra`. Convex / our-side bug; engineering alerted.
 */
function classifyLlmError(
  error: unknown,
):
  | "live_source_unavailable"
  | "model_empty_output"
  | "transport_rate_limit"
  | "transport_other"
  | "output_quality"
  | "infra" {
  if (error instanceof SandboxPreparationError) {
    return "live_source_unavailable";
  }
  if (error instanceof LlmRateLimitError) {
    return "transport_rate_limit";
  }
  if (error instanceof APICallError) {
    if (error.statusCode === 429) {
      return "transport_rate_limit";
    }
    return "transport_other";
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/empty document/i.test(message)) {
    return "model_empty_output";
  }
  return "infra";
}

/**
 * Per-kind user-prompt shell. The system prompt carries the
 * per-kind directive; this user prompt only supplies the repository
 * identification + an opening instruction. The two are concatenated
 * inside the gateway call so the model sees `system` and `prompt`
 * the way AI SDK expects.
 */
function buildUserPrompt(repository: Doc<"repositories">): string {
  return [
    `Repository: ${repository.sourceRepoFullName ?? "(unknown)"}`,
    repository.defaultBranch ? `Default branch: ${repository.defaultBranch}` : null,
    "",
    "Begin by listing the repository root, then inspect the most relevant files",
    "before writing the document. Stay within the repo subtree.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/**
 * Extract a 1-line preview from a generated markdown document — first
 * non-heading, non-blank line, capped at 280 characters. Falls back to
 * a generic label so artifacts always have a summary.
 */
function extractSummary(markdown: string): string {
  const lines = markdown.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    return trimmed.slice(0, 280);
  }
  return "Generated by Library System Design.";
}

/**
 * Type-only re-export for downstream eval / report callers that want
 * to discriminate kindRun statuses without re-deriving the union from
 * the schema document.
 */
export type { LlmProvider };
