"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import { runFocusedInspection } from "./daytona";
import { getSandboxUnavailableReason } from "./lib/sandboxAvailability";
import { createDeepAnalysisMarkdown } from "./lib/repoAnalysis";
import { logErrorWithId } from "./lib/observability";

type DeepAnalysisContext = {
  repositoryId: Id<"repositories">;
  ownerTokenIdentifier: string;
  latestSandboxId?: Id<"sandboxes">;
  sandboxStatus?: "provisioning" | "ready" | "stopped" | "archived" | "failed";
  ttlExpiresAt?: number;
  remoteSandboxId?: string;
  repoPath?: string;
  sourceRepoFullName: string;
};

export const runDeepAnalysis = internalAction({
  args: {
    repositoryId: v.id("repositories"),
    jobId: v.id("jobs"),
    prompt: v.string(),
  },
  handler: async (ctx, args) => {
    const start = (await ctx.runMutation(internal.analysis.markDeepAnalysisRunning, {
      jobId: args.jobId,
    })) as { started: boolean };
    if (!start.started) {
      return;
    }

    try {
      // Cast required: Convex action ctx.runQuery cannot infer return types
      // for functions defined in a different file (framework limitation).
      const context = (await ctx.runQuery(internal.analysis.getDeepAnalysisContext, {
        repositoryId: args.repositoryId,
      })) as DeepAnalysisContext;

      const unavailableReason = getSandboxUnavailableReason(
        context.sandboxStatus && context.ttlExpiresAt !== undefined
          ? {
              status: context.sandboxStatus,
              ttlExpiresAt: context.ttlExpiresAt,
              remoteId: context.remoteSandboxId,
              repoPath: context.repoPath,
            }
          : null,
      );
      if (unavailableReason) {
        throw new Error(unavailableReason);
      }

      await ctx.runMutation(internal.analysis.refreshDeepAnalysisLease, {
        jobId: args.jobId,
      });
      const inspectionLog = await runFocusedInspection(context.remoteSandboxId!, context.repoPath!, args.prompt);
      await ctx.runMutation(internal.analysis.refreshDeepAnalysisLease, {
        jobId: args.jobId,
      });
      const markdown = createDeepAnalysisMarkdown(args.prompt, inspectionLog);

      await ctx.runMutation(internal.analysis.completeDeepAnalysis, {
        repositoryId: args.repositoryId,
        jobId: args.jobId,
        ownerTokenIdentifier: context.ownerTokenIdentifier,
        summary: `Focused inspection completed for ${context.sourceRepoFullName}.`,
        contentMarkdown: markdown,
      });
    } catch (error) {
      const errorId = logErrorWithId("analysis", "deep_analysis_failed", error, {
        repositoryId: args.repositoryId,
        jobId: args.jobId,
      });
      await ctx.runMutation(internal.analysis.failDeepAnalysis, {
        jobId: args.jobId,
        errorMessage: `${
          error instanceof Error ? error.message : "Unknown deep analysis error"
        }\n\nReference: ${errorId}`,
      });
    }
  },
});
