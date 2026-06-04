"use node";

/**
 * System Design eval harness — one Node action that sweeps
 * `(corpus × kind × stepBudget)` for a chosen `(provider, modelName)`
 * pair and returns `EvalRunRecord` rows.
 *
 * The runner deliberately bypasses the production job machinery:
 *
 *   - No `jobs` row is inserted — eval traffic does not pollute the
 *     operator's job dashboards.
 *   - No `artifacts` row is written — eval output is throwaway markdown.
 *   - No `systemDesignKindRuns` row is written — eval rows live in
 *     local JSONL on the operator's machine, not the production table.
 *
 * It DOES go through `generateViaGateway`, so eval calls show up in
 * the standard token / cost / rate-limit telemetry tagged with
 * `feature: "system_design"`. The judge phase shows up tagged
 * `feature: "eval_judge"` (see `judge.ts`).
 *
 * The sandbox is reused across kinds for a single corpus entry (one
 * `ensureSandboxReady` per repo), mirroring the production generator's
 * pattern at `convex/systemDesignNode.ts`.
 *
 * Rubric markdown is passed in via args (the bun CLI loads it from
 * disk) — the action itself does NOT read the filesystem, so the
 * Convex bundle stays self-contained.
 */

import { APICallError, stepCountIs } from "ai";
import { v } from "convex/values";
import { internal } from "../../_generated/api";
import type { Doc } from "../../_generated/dataModel";
import { internalAction } from "../../_generated/server";
import { createSandboxTools } from "../../chat/sandboxTools";
import { getSandboxFsClient } from "../../daytona";
import { getCatalogEntry, isValidPick, ROLE_MODELS } from "../../lib/llmCatalog";
import { generateViaGateway, LlmRateLimitError } from "../../lib/llmGateway";
import { llmProviderValidator, type NormalizedUsage } from "../../lib/llmProvider";
import { ensureSandboxReady, type EnsureSandboxReadyResult, SandboxPreparationError } from "../../lib/sandboxLiveness";
import { logInfo, logWarn } from "../../lib/observability";
import { SYSTEM_DESIGN_KINDS, systemDesignKindValidator, type SystemDesignKind } from "../../lib/systemDesign";
import {
  budgetSuffix,
  getKindRunConfig,
  validateMermaidBlock,
  validateRequiredSections,
} from "../../lib/systemDesignPrompts";
import type { EvalRunRecord, EvalRunStatus } from "./aggregate";
import { judgeArtifact } from "./judge";

const EVAL_HARNESS_OWNER = "eval:harness";
const DEFAULT_BUDGET = 20;

interface SkippedEntry {
  slug: string;
  reason: "missing_repository_id" | "sandbox_preparation_failed";
  detail?: string;
  sandboxReason?: string;
}

export const runEval = internalAction({
  args: {
    /** Slug subset; empty / omitted means "every corpus entry the caller supplied a repo for". */
    corpusSlugs: v.optional(v.array(v.string())),
    kinds: v.optional(v.array(systemDesignKindValidator)),
    /** Step budgets to sweep. Each value runs as a separate trial per (corpus × kind). */
    budgets: v.optional(v.array(v.number())),
    provider: v.optional(llmProviderValidator),
    modelName: v.optional(v.string()),
    /**
     * Operator-provided map: corpus slug → `Id<"repositories">`.
     * The operator pre-imports each corpus repo into their Convex
     * deployment and supplies the resolved ids here. Slugs absent
     * from this map are reported in `skipped`.
     */
    repositoryIds: v.record(v.string(), v.id("repositories")),
    /**
     * Per-kind rubric markdown. When supplied, the runner calls the
     * judge after each successful trial. Missing kinds simply skip
     * the judge phase (records still emit with `judgeAxes: undefined`).
     */
    rubrics: v.optional(v.record(v.string(), v.string())),
  },
  handler: async (ctx, args): Promise<{ records: EvalRunRecord[]; skipped: SkippedEntry[] }> => {
    const provider = args.provider ?? ROLE_MODELS.defaultSystemDesign.provider;
    const modelName = args.modelName ?? ROLE_MODELS.defaultSystemDesign.modelName;
    if (!isValidPick(provider, modelName)) {
      throw new Error(`runEval: unsupported model pick ${provider}:${modelName}`);
    }
    const catalogEntry = getCatalogEntry(provider, modelName);

    const kinds: ReadonlyArray<SystemDesignKind> = args.kinds ?? SYSTEM_DESIGN_KINDS;
    const budgets: ReadonlyArray<number> = args.budgets && args.budgets.length > 0 ? args.budgets : [DEFAULT_BUDGET];
    const corpusSlugs: ReadonlyArray<string> =
      args.corpusSlugs && args.corpusSlugs.length > 0 ? args.corpusSlugs : Object.keys(args.repositoryIds);

    const records: EvalRunRecord[] = [];
    const skipped: SkippedEntry[] = [];

    for (const slug of corpusSlugs) {
      const repositoryId = args.repositoryIds[slug];
      if (!repositoryId) {
        skipped.push({ slug, reason: "missing_repository_id" });
        continue;
      }

      let repo: Doc<"repositories">;
      try {
        const fetched = await ctx.runQuery(internal.repositories.getRepositoryForProcessing, {
          repositoryId,
        });
        repo = fetched.repository;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const sandboxReason = detail === "Repository not found." ? "repository_not_found" : "infrastructure_error";
        skipped.push({
          slug,
          reason: "sandbox_preparation_failed",
          detail,
          sandboxReason,
        });
        continue;
      }

      let prepared: EnsureSandboxReadyResult;
      try {
        prepared = await ensureSandboxReady(ctx, {
          repositoryId,
          ownerTokenIdentifier: repo.ownerTokenIdentifier,
        });
      } catch (error) {
        const reason = error instanceof SandboxPreparationError ? error.reason : "infrastructure_error";
        skipped.push({
          slug,
          reason: "sandbox_preparation_failed",
          detail: error instanceof SandboxPreparationError ? error.userFacingMessage : String(error),
          sandboxReason: reason,
        });
        logWarn("eval", "sandbox_preparation_failed", { slug, repositoryId, reason });
        continue;
      }

      for (const kind of kinds) {
        for (const stepBudget of budgets) {
          const config = getKindRunConfig(kind);
          const startedAt = Date.now();
          let status: EvalRunStatus = "failed";
          let failureReason: string | undefined;
          let missingSections: string[] | undefined;
          let usage: NormalizedUsage = {};
          let costUsd: number | undefined;
          let outputCharLength = 0;
          let judgeAxes: EvalRunRecord["judgeAxes"];
          let judgeOverallScore: number | undefined;
          let judgeComments: string | undefined;
          let judgeParseError: string | undefined;

          try {
            const result = await generateViaGateway(
              ctx,
              {
                provider,
                modelName,
                ownerTokenIdentifier: EVAL_HARNESS_OWNER,
                capability: "sandbox",
                feature: "system_design",
              },
              {
                system: config.prompt + budgetSuffix(stepBudget),
                prompt: buildUserPrompt(repo),
                tools: createSandboxTools(await getSandboxFsClient(prepared.remoteId), prepared.repoPath),
                stopWhen: stepCountIs(stepBudget),
                reasoningEffort: catalogEntry?.reasoningEffort,
              },
            );

            usage = result.usage;
            costUsd = result.costUsd;
            const text = result.text.trim();
            outputCharLength = text.length;

            if (text.length === 0) {
              status = "failed";
              failureReason = "model_empty_output";
            } else {
              const validation = validateRequiredSections(text, config.expectedSections);
              const mermaidOk = kind !== "architecture_diagram" || validateMermaidBlock(text);
              if (!validation.ok || !mermaidOk) {
                status = "quality_rejected";
                failureReason = "output_quality";
                missingSections = [...validation.missingSections, ...(mermaidOk ? [] : ["mermaid_block"])];
              } else {
                status = "succeeded";
                const rubric = args.rubrics?.[kind];
                if (rubric) {
                  const judge = await judgeArtifact(ctx, {
                    kind,
                    contentMarkdown: text,
                    rubricMarkdown: rubric,
                  });
                  judgeAxes = judge.axes;
                  judgeOverallScore = judge.overallScore;
                  judgeComments = judge.comments;
                  judgeParseError = judge.parseError;
                }
              }
            }
          } catch (error) {
            status = "failed";
            failureReason = classifyEvalError(error);
            logWarn("eval", "trial_failed", {
              slug,
              kind,
              stepBudget,
              provider,
              modelName,
              failureReason,
              message: error instanceof Error ? error.message : String(error),
            });
          }

          const durationMs = Date.now() - startedAt;
          records.push({
            corpusSlug: slug,
            kind,
            stepBudget,
            provider,
            modelName,
            promptVersion: config.promptVersion,
            status,
            failureReason,
            missingSections,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cachedInputTokens: usage.cachedInputTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
            reasoningTokens: usage.reasoningTokens,
            totalCostUsd: costUsd,
            durationMs,
            judgeAxes,
            judgeOverallScore,
            judgeComments,
            judgeParseError,
            outputCharLength: outputCharLength > 0 ? outputCharLength : undefined,
            startedAt,
          });
        }
      }
    }

    logInfo("eval", "run_complete", {
      provider,
      modelName,
      corpusEntries: corpusSlugs.length,
      totalTrials: records.length,
      skippedCount: skipped.length,
    });

    return { records, skipped };
  },
});

/**
 * Eval-side error classifier. Mirrors `classifyLlmError` in
 * `convex/systemDesignNode.ts` but lives separate so eval can keep
 * its taxonomy stable when production tweaks classifications for
 * banner copy.
 */
function classifyEvalError(error: unknown): string {
  if (error instanceof SandboxPreparationError) return "live_source_unavailable";
  if (error instanceof LlmRateLimitError) return "transport_rate_limit";
  if (error instanceof APICallError) {
    if (error.statusCode === 429) return "transport_rate_limit";
    return "transport_other";
  }
  return "infra";
}

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
