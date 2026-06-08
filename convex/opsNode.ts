"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import {
  deleteSandbox,
  getSandboxState,
  listSandboxesByLabel,
  SYSTIFY_DAYTONA_MANAGED_LABELS,
  stopSandbox,
} from "./daytona";
import { logErrorWithId, logInfo } from "./lib/observability";

const CLEANUP_LEASE_EXTENSION_INTERVAL_MS = 5 * 60_000;

export const runSandboxCleanup = internalAction({
  args: {
    sandboxId: v.id("sandboxes"),
    jobId: v.id("jobs"),
  },
  handler: async (ctx, args) => {
    const sandbox = await ctx.runMutation(internal.ops.markSandboxCleanupRunning, {
      sandboxId: args.sandboxId,
      jobId: args.jobId,
    });
    if (!sandbox.started) {
      return;
    }

    const leaseTimer = setInterval(() => {
      void ctx.runMutation(internal.ops.extendSandboxCleanupLease, {
        jobId: args.jobId,
      });
    }, CLEANUP_LEASE_EXTENSION_INTERVAL_MS);

    try {
      if (sandbox.remoteId) {
        await deleteSandbox(sandbox.remoteId);
      }

      await ctx.runMutation(internal.ops.completeSandboxCleanup, {
        sandboxId: args.sandboxId,
        jobId: args.jobId,
      });
    } catch (error) {
      const errorId = logErrorWithId("ops", "sandbox_cleanup_failed", error, {
        sandboxId: args.sandboxId,
        jobId: args.jobId,
        remoteId: sandbox.remoteId,
      });
      await ctx.runMutation(internal.ops.failSandboxCleanup, {
        sandboxId: args.sandboxId,
        jobId: args.jobId,
        errorMessage: `${
          error instanceof Error ? error.message : "Unknown sandbox cleanup error"
        }\n\nReference: ${errorId}`,
      });
    } finally {
      clearInterval(leaseTimer);
    }
  },
});

// ---------------------------------------------------------------------------
// Scheduled sweep: reconcile Convex DB status with Daytona reality
// ---------------------------------------------------------------------------

const STALE_CHAT_JOB_ERROR_MESSAGE =
  "This reply stopped before it could finish. Try sending your message again. If it keeps happening, choose another model or check the provider configuration.";
const STALE_IMPORT_JOB_ERROR_MESSAGE = "Repository import stopped before it could finish. Start a new sync to retry.";
const DAYTONA_ORPHAN_RECONCILIATION_MIN_AGE_MS = 10 * 60_000;

export const sweepExpiredSandboxes = internalAction({
  args: {},
  handler: async (ctx) => {
    const expired = await ctx.runQuery(internal.ops.getExpiredSandboxes, {});

    if (expired.length === 0) {
      return;
    }

    logInfo("sweep", "expired_sandboxes_found", {
      count: expired.length,
    });

    for (const entry of expired) {
      try {
        const daytonaState = await getSandboxState(entry.remoteId);

        if (daytonaState === "archived" || daytonaState === "destroyed") {
          // Daytona already reclaimed it — mark as archived in Convex DB
          await ctx.runMutation(internal.ops.markSandboxSwept, {
            sandboxId: entry.sandboxId,
            newStatus: "archived",
          });
          logInfo("sweep", "sandbox_marked_archived", {
            sandboxId: entry.sandboxId,
            remoteId: entry.remoteId,
            daytonaState,
          });
        } else if (daytonaState === "stopped") {
          // Still on disk but stopped — proactively delete to free disk cost.
          // Real failures fall through to the outer catch and surface as
          // sandbox_reconciliation_failed; the next sweep retries.
          await deleteSandbox(entry.remoteId);
          logInfo("sweep", "stopped_sandbox_deleted", {
            sandboxId: entry.sandboxId,
            remoteId: entry.remoteId,
          });
          await ctx.runMutation(internal.ops.markSandboxSwept, {
            sandboxId: entry.sandboxId,
            newStatus: "archived",
          });
        } else if (daytonaState === "started") {
          // Sandbox is somehow still running past TTL — stop it first, delete next sweep
          await stopSandbox(entry.remoteId);
          await ctx.runMutation(internal.ops.markSandboxSwept, {
            sandboxId: entry.sandboxId,
            newStatus: "stopped",
          });
          logInfo("sweep", "running_sandbox_stopped_for_ttl", {
            sandboxId: entry.sandboxId,
            remoteId: entry.remoteId,
          });
        }
      } catch (error) {
        logErrorWithId("sweep", "sandbox_reconciliation_failed", error, {
          sandboxId: entry.sandboxId,
          remoteId: entry.remoteId,
        });
      }
    }
  },
});

export const reconcileStaleInteractiveJobs = internalAction({
  args: {},
  handler: async (ctx) => {
    const staleJobs = await ctx.runQuery(internal.ops.listStaleInteractiveJobs, {});

    if (staleJobs.length === 0) {
      return;
    }

    logInfo("ops", "stale_interactive_jobs_found", {
      count: staleJobs.length,
    });

    for (const job of staleJobs) {
      if (job.kind === "chat") {
        await ctx.runMutation(internal.chat.streaming.recoverStaleChatJob, {
          jobId: job.jobId,
          errorMessage: STALE_CHAT_JOB_ERROR_MESSAGE,
        });
        continue;
      }

      if (job.kind === "sandbox_activation") {
        await ctx.runMutation(internal.repositories.recoverStaleSandboxActivationJob, {
          jobId: job.jobId,
        });
        continue;
      }

      if (job.kind === "artifact_draft") {
        await ctx.runMutation(internal.libraryArtifactDrafts.recoverStaleArtifactDraftJob, {
          jobId: job.jobId,
        });
        continue;
      }

      await ctx.runMutation(internal.systemDesign.recoverStaleSystemDesignJob, {
        jobId: job.jobId,
      });
    }
  },
});

export const reconcileStaleImportJobs = internalAction({
  args: {},
  handler: async (ctx) => {
    const staleJobs = await ctx.runQuery(internal.ops.listStaleImportJobs, {});

    if (staleJobs.length === 0) {
      return;
    }

    logInfo("ops", "stale_import_jobs_found", {
      count: staleJobs.length,
    });

    for (const job of staleJobs) {
      await ctx.runMutation(internal.imports.recoverStaleImportJob, {
        jobId: job.jobId,
        errorMessage: STALE_IMPORT_JOB_ERROR_MESSAGE,
      });
    }
  },
});

export const reconcileDaytonaOrphans = internalAction({
  args: {},
  handler: async (ctx) => {
    const sandboxes = await listSandboxesByLabel(SYSTIFY_DAYTONA_MANAGED_LABELS);

    if (sandboxes.length === 0) {
      return;
    }

    const now = Date.now();

    for (const sandbox of sandboxes) {
      const createdAtMs = sandbox.createdAt ? Date.parse(sandbox.createdAt) : Number.NaN;
      if (!Number.isFinite(createdAtMs) || now - createdAtMs < DAYTONA_ORPHAN_RECONCILIATION_MIN_AGE_MS) {
        continue;
      }

      const matchedSandbox = await ctx.runQuery(internal.ops.getSandboxByRemoteId, {
        remoteId: sandbox.remoteId,
      });
      if (matchedSandbox) {
        continue;
      }

      try {
        await deleteSandbox(sandbox.remoteId);
        logInfo("reconcile", "orphan_deleted", {
          remoteId: sandbox.remoteId,
          createdAt: sandbox.createdAt,
        });
      } catch (error) {
        logErrorWithId("reconcile", "orphan_delete_failed", error, {
          remoteId: sandbox.remoteId,
          createdAt: sandbox.createdAt,
        });
      }
    }
  },
});
