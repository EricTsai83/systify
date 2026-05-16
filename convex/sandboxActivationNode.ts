"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { ensureSandboxReady, SandboxPreparationError, type SandboxPreparationStage } from "./lib/sandboxLiveness";
import { logErrorWithId } from "./lib/observability";

const STAGE_LABELS: Record<SandboxPreparationStage, { label: string; progress: number }> = {
  probing: { label: "Probing existing environment…", progress: 0.15 },
  waking: { label: "Waking up live source…", progress: 0.45 },
  provisioning: { label: "Provisioning a fresh environment…", progress: 0.45 },
  cloning: { label: "Cloning repository…", progress: 0.8 },
  polling: { label: "Waiting for environment to come online…", progress: 0.25 },
};

/**
 * Action runner for the explicit chat `Activate` button. Mirrors the
 * shape of other long-running actions: marks the queued job running,
 * drives `ensureSandboxReady` (which is the only place that knows how
 * to wake / provision / clone in one place), and rolls up success or
 * failure through the standard job lifecycle helpers.
 */
export const runSandboxActivation = internalAction({
  args: {
    jobId: v.id("jobs"),
    repositoryId: v.id("repositories"),
    ownerTokenIdentifier: v.string(),
  },
  handler: async (ctx, args) => {
    const start = (await ctx.runMutation(internal.repositories.markSandboxActivationStarted, {
      jobId: args.jobId,
    })) as { started: boolean };
    if (!start.started) {
      return;
    }

    try {
      const prepared = await ensureSandboxReady(
        ctx,
        {
          repositoryId: args.repositoryId,
          ownerTokenIdentifier: args.ownerTokenIdentifier,
        },
        async (stage) => {
          const { label, progress } = STAGE_LABELS[stage];
          await ctx.runMutation(internal.repositories.updateSandboxActivationStage, {
            jobId: args.jobId,
            stage: label,
            progress,
          });
        },
      );
      await ctx.runMutation(internal.repositories.completeSandboxActivation, {
        jobId: args.jobId,
        sandboxId: prepared.sandboxId,
      });
    } catch (error) {
      const userFacingMessage =
        error instanceof SandboxPreparationError
          ? error.userFacingMessage
          : "Couldn't prepare live source. Try again in a minute.";
      logErrorWithId("sandbox_activation", "activation_failed", error, {
        jobId: args.jobId,
        repositoryId: args.repositoryId,
      });
      await ctx.runMutation(internal.repositories.failSandboxActivation, {
        jobId: args.jobId,
        errorMessage: userFacingMessage,
      });
    }
  },
});
