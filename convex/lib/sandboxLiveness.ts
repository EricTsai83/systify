"use node";

import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  assertSandboxProvisioningConfigured,
  cloneRepositoryInSandbox,
  probeLiveSandbox,
  provisionSandbox,
  startSandbox,
  type LiveSandboxProbe,
} from "../daytona";
import { getInstallationAccessToken } from "../githubAppNode";
import { logErrorWithId, logInfo, logWarn } from "./observability";

/**
 * Authoritative liveness check + cache reconciliation in one call.
 *
 * Any action that is about to use a sandbox should call this *before* it
 * spends tokens or compute. The function:
 *
 *   1. Probes Daytona for the actual sandbox state (source of truth).
 *   2. Mirrors that state back into the local `sandboxes` row via
 *      `internal.ops.syncSandboxStatusFromRemote` — so if the cache was
 *      stale (e.g. user deleted in the Daytona dashboard), the next
 *      preflight in `requestSystemDesignGeneration` / chat context build
 *      will see the corrected state without needing this verification.
 *   3. Returns the probe verdict so the caller can decide whether to
 *      proceed.
 *
 * Defense-in-depth pairing with the existing sync paths:
 *   - Real-time push: `daytonaWebhooks.processEvent` handles Daytona-side
 *     state transitions for events that actually fire.
 *   - Eventual reconciliation: `sweepExpiredSandboxes` (hourly) and
 *     `reconcileDaytonaOrphans` (six-hourly) catch missed webhooks.
 *   - **This helper**: verify-on-use. Closes the window where the cache
 *     is wrong AND a user is about to act on it, regardless of webhook
 *     delivery. Manual deletions in the Daytona dashboard never fire a
 *     webhook, so this is the only path that catches them at the right
 *     moment.
 */
export async function verifyAndSyncSandbox(
  ctx: ActionCtx,
  args: { sandboxId: Id<"sandboxes">; remoteId: string },
): Promise<LiveSandboxProbe> {
  const probe = await probeLiveSandbox(args.remoteId);
  await ctx.runMutation(internal.ops.syncSandboxStatusFromRemote, {
    sandboxId: args.sandboxId,
    remoteState: probe.remoteState,
  });
  return probe;
}

/**
 * Structured failure thrown by `ensureSandboxReady`. The
 * `userFacingMessage` is rendered directly to end users in the Library
 * banner / chat status, so it MUST be plain language and MUST NOT
 * include the word "sandbox". The `reason` code is for callers that
 * want to branch on the failure (e.g. System Design's `recordKindFailure`
 * which maps the reason to the `kindFailures.reason` discriminator).
 */
export type SandboxPreparationReason =
  | "live_source_unavailable"
  | "live_source_provisioning_timeout"
  | "repository_not_found"
  | "repository_inaccessible"
  | "missing_credentials"
  | "infrastructure_error";

export class SandboxPreparationError extends Error {
  readonly reason: SandboxPreparationReason;
  readonly userFacingMessage: string;
  constructor(args: { reason: SandboxPreparationReason; userFacingMessage: string; cause?: unknown }) {
    super(args.userFacingMessage);
    this.name = "SandboxPreparationError";
    this.reason = args.reason;
    this.userFacingMessage = args.userFacingMessage;
    if (args.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = args.cause;
    }
  }
}

export type SandboxPreparationStage = "probing" | "waking" | "provisioning" | "cloning" | "polling";

export type EnsureSandboxReadyResult = {
  sandboxId: Id<"sandboxes">;
  remoteId: string;
  repoPath: string;
};

const PROVISIONING_POLL_INTERVAL_MS = 2_000;
const PROVISIONING_POLL_TIMEOUT_MS = 120_000;

const LIVE_SOURCE_UNAVAILABLE_MESSAGE =
  "Live access to the repository wasn't available. The next attempt will prepare it first.";

/**
 * Single-source-of-truth orchestrator for "make the sandbox usable for
 * this repository, right now, regardless of its current state". Callers
 * are expected to use this in front of any LLM call or tool invocation
 * that depends on a live repository tree.
 *
 * Branching matrix (see plan-action-named-recovery-on-demand-sandbox-lifecycle.md):
 *
 *   | Local cache | Daytona probe | Action                                   |
 *   |-------------|---------------|-------------------------------------------|
 *   | ready       | started       | return                                    |
 *   | ready       | stopped       | startSandbox (wake), sync cache, return   |
 *   | ready       | archived/destr| provision new + clone, repoint repository |
 *   | stopped     | started       | sync cache, return                        |
 *   | stopped     | stopped       | startSandbox, sync cache, return          |
 *   | archived /  | (any)         | provision new + clone, repoint repository |
 *   |   failed /  |               |                                           |
 *   |   missing   |               |                                           |
 *   | provisioning| (n/a)         | poll until ready or timeout               |
 *
 * Throws `SandboxPreparationError` whose `userFacingMessage` is safe to
 * render directly to the end user.
 */
export async function ensureSandboxReady(
  ctx: ActionCtx,
  args: {
    repositoryId: Id<"repositories">;
    ownerTokenIdentifier: string;
  },
  onStage?: (stage: SandboxPreparationStage) => void | Promise<void>,
): Promise<EnsureSandboxReadyResult> {
  try {
    assertSandboxProvisioningConfigured();
  } catch (error) {
    throw new SandboxPreparationError({
      reason: "missing_credentials",
      userFacingMessage: LIVE_SOURCE_UNAVAILABLE_MESSAGE,
      cause: error,
    });
  }

  const snapshot = await ctx.runQuery(internal.repositories.getRepositorySandboxForPreparation, {
    repositoryId: args.repositoryId,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
  });
  if (snapshot === null) {
    throw new SandboxPreparationError({
      reason: "repository_not_found",
      userFacingMessage: "The repository is no longer available.",
    });
  }
  const { repository, sandbox } = snapshot;

  if (sandbox && sandbox.status === "provisioning") {
    return await pollUntilReady(ctx, sandbox._id, onStage);
  }

  if (sandbox && sandbox.remoteId && (sandbox.status === "ready" || sandbox.status === "stopped")) {
    await safeStage(onStage, "probing");
    const probe = await probeLiveSandbox(sandbox.remoteId);
    await ctx.runMutation(internal.ops.syncSandboxStatusFromRemote, {
      sandboxId: sandbox._id,
      remoteState: probe.remoteState,
    });

    if (probe.ok && probe.remoteState === "started" && sandbox.repoPath) {
      return { sandboxId: sandbox._id, remoteId: sandbox.remoteId, repoPath: sandbox.repoPath };
    }

    if (probe.remoteState === "stopped" && sandbox.repoPath) {
      await safeStage(onStage, "waking");
      try {
        await startSandbox(sandbox.remoteId);
      } catch (error) {
        const errorId = logErrorWithId("sandbox_liveness", "start_sandbox_failed", error, {
          sandboxId: sandbox._id,
          remoteId: sandbox.remoteId,
          repositoryId: args.repositoryId,
        });
        throw new SandboxPreparationError({
          reason: "infrastructure_error",
          userFacingMessage: `${LIVE_SOURCE_UNAVAILABLE_MESSAGE} (ref: ${errorId})`,
          cause: error,
        });
      }
      await ctx.runMutation(internal.ops.syncSandboxStatusFromRemote, {
        sandboxId: sandbox._id,
        remoteState: "started",
      });
      logInfo("sandbox_liveness", "sandbox_woken", {
        sandboxId: sandbox._id,
        repositoryId: args.repositoryId,
      });
      return { sandboxId: sandbox._id, remoteId: sandbox.remoteId, repoPath: sandbox.repoPath };
    }
    // probe says archived / destroyed / error / unknown — fall through to provision new.
  }

  return await provisionAndClone(ctx, { repository, previousSandbox: sandbox }, onStage);
}

async function safeStage(
  onStage: ((stage: SandboxPreparationStage) => void | Promise<void>) | undefined,
  stage: SandboxPreparationStage,
) {
  if (!onStage) return;
  try {
    await onStage(stage);
  } catch (error) {
    // Stage callbacks are informational. A throwing callback must never
    // hide the real preparation result, so we log and move on.
    logWarn("sandbox_liveness", "stage_callback_threw", {
      stage,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function pollUntilReady(
  ctx: ActionCtx,
  sandboxId: Id<"sandboxes">,
  onStage: ((stage: SandboxPreparationStage) => void | Promise<void>) | undefined,
): Promise<EnsureSandboxReadyResult> {
  await safeStage(onStage, "polling");
  const deadline = Date.now() + PROVISIONING_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, PROVISIONING_POLL_INTERVAL_MS));
    const sandbox = await ctx.runQuery(internal.ops.getSandboxRow, { sandboxId });
    if (!sandbox) {
      throw new SandboxPreparationError({
        reason: "infrastructure_error",
        userFacingMessage: LIVE_SOURCE_UNAVAILABLE_MESSAGE,
      });
    }
    if (sandbox.status === "ready" && sandbox.remoteId && sandbox.repoPath) {
      return { sandboxId: sandbox._id, remoteId: sandbox.remoteId, repoPath: sandbox.repoPath };
    }
    if (sandbox.status === "failed" || sandbox.status === "archived") {
      throw new SandboxPreparationError({
        reason: "infrastructure_error",
        userFacingMessage: LIVE_SOURCE_UNAVAILABLE_MESSAGE,
      });
    }
  }
  throw new SandboxPreparationError({
    reason: "live_source_provisioning_timeout",
    userFacingMessage: "Preparing the repository is taking longer than expected. Try again in a minute.",
  });
}

async function provisionAndClone(
  ctx: ActionCtx,
  args: {
    repository: Doc<"repositories">;
    previousSandbox: Doc<"sandboxes"> | null;
  },
  onStage: ((stage: SandboxPreparationStage) => void | Promise<void>) | undefined,
): Promise<EnsureSandboxReadyResult> {
  const { repository, previousSandbox } = args;

  const installationId = (await ctx.runQuery(internal.github.getInstallationIdForOwner, {
    ownerTokenIdentifier: repository.ownerTokenIdentifier,
  })) as number | null;
  if (!installationId) {
    throw new SandboxPreparationError({
      reason: "missing_credentials",
      userFacingMessage: "Connect your GitHub account to give the app access to this repository, then try again.",
    });
  }

  const [repoOwner, repoName] = repository.sourceRepoFullName.split("/");
  if (!repoOwner || !repoName) {
    throw new SandboxPreparationError({
      reason: "repository_inaccessible",
      userFacingMessage: LIVE_SOURCE_UNAVAILABLE_MESSAGE,
    });
  }
  const accessCheck = (await ctx.runAction(internal.githubAppNode.checkRepoAccess, {
    installationId,
    owner: repoOwner,
    repo: repoName,
  })) as { accessible: boolean; isPrivate?: boolean; message?: string };
  if (!accessCheck.accessible) {
    throw new SandboxPreparationError({
      reason: "repository_inaccessible",
      userFacingMessage:
        accessCheck.message ?? "The app no longer has access to this repository. Reconnect GitHub and try again.",
    });
  }
  const detectedVisibility = accessCheck.isPrivate ? ("private" as const) : ("public" as const);

  await safeStage(onStage, "provisioning");
  const sandboxId = await ctx.runMutation(internal.imports.reserveOnDemandSandboxRow, {
    repositoryId: repository._id,
    ownerTokenIdentifier: repository.ownerTokenIdentifier,
    sourceAdapter: "git_clone",
  });

  let remoteIdForCleanup: string | null = null;

  try {
    const provisioned = await provisionSandbox({
      repositoryKey: repository.sourceRepoFullName,
      repositoryId: repository._id,
      sandboxId,
      accessMode: repository.accessMode,
      sourceAdapter: "git_clone",
    });
    remoteIdForCleanup = provisioned.remoteId;

    await ctx.runMutation(internal.imports.attachOnDemandSandboxRemoteInfo, {
      sandboxId,
      remoteId: provisioned.remoteId,
      workDir: provisioned.workDir,
      repoPath: provisioned.repoPath,
      cpuLimit: provisioned.cpuLimit,
      memoryLimitGiB: provisioned.memoryLimitGiB,
      diskLimitGiB: provisioned.diskLimitGiB,
      autoStopIntervalMinutes: provisioned.autoStopIntervalMinutes,
      autoArchiveIntervalMinutes: provisioned.autoArchiveIntervalMinutes,
      autoDeleteIntervalMinutes: provisioned.autoDeleteIntervalMinutes,
      networkBlockAll: provisioned.networkBlockAll,
      networkAllowList: provisioned.networkAllowList,
    });

    let githubToken: string | undefined;
    try {
      githubToken = await getInstallationAccessToken(installationId);
    } catch (error) {
      if (detectedVisibility === "private") {
        throw error;
      }
      logWarn("sandbox_liveness", "github_token_unavailable_public_clone", {
        repositoryId: repository._id,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    await safeStage(onStage, "cloning");
    const cloneResult = await cloneRepositoryInSandbox({
      remoteId: provisioned.remoteId,
      url: repository.sourceUrl,
      branch: repository.defaultBranch,
      token: githubToken,
    });

    await ctx.runMutation(internal.imports.markOnDemandSandboxReady, {
      sandboxId,
      repositoryId: repository._id,
      commitSha: cloneResult.commitSha,
      branch: cloneResult.branch,
    });

    if (previousSandbox && previousSandbox._id !== sandboxId) {
      await ctx.runMutation(internal.ops.scheduleSandboxCleanup, {
        sandboxId: previousSandbox._id,
      });
    }

    logInfo("sandbox_liveness", "on_demand_sandbox_provisioned", {
      sandboxId,
      repositoryId: repository._id,
      commitSha: cloneResult.commitSha,
    });

    return {
      sandboxId,
      remoteId: provisioned.remoteId,
      repoPath: provisioned.repoPath,
    };
  } catch (error) {
    if (error instanceof SandboxPreparationError) {
      throw error;
    }
    const errorId = logErrorWithId("sandbox_liveness", "on_demand_provision_failed", error, {
      sandboxId,
      repositoryId: repository._id,
    });
    await ctx.runMutation(internal.imports.failOnDemandSandboxProvisioning, {
      sandboxId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    if (remoteIdForCleanup) {
      await ctx.runMutation(internal.ops.scheduleSandboxCleanup, {
        sandboxId,
      });
    }
    throw new SandboxPreparationError({
      reason: "infrastructure_error",
      userFacingMessage: `${LIVE_SOURCE_UNAVAILABLE_MESSAGE} (ref: ${errorId})`,
      cause: error,
    });
  }
}
