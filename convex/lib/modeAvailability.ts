import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { RepositoryModeEligibility } from "../repositoryModeEligibility";
import type { ThreadContextSandboxCostBudgets } from "../threadContext";
import {
  DISABLED_REASON_SANDBOX_REPOSITORY_CAP_EXCEEDED,
  DISABLED_REASON_SANDBOX_USER_CAP_EXCEEDED,
  resolveChatModes,
  resolveRepositoryModes,
  type ChatModeResolution,
  type ChatModeSandboxStatus,
  type SandboxCostCapGate,
} from "./chatEligibility";
import { getRepositorySandboxStatus, type SandboxModeStatus } from "./repositorySandbox";
import {
  getSandboxReplyEstimateCents,
  peekSandboxDailyCostForRepository,
  peekSandboxDailyCostForUser,
  type SandboxDailyCostBudget,
} from "./rateLimit";

export interface ModeAvailabilitySnapshot {
  chatModes: ChatModeResolution;
  repositoryModes?: RepositoryModeEligibility;
  sandbox: Doc<"sandboxes"> | null;
  sandboxModeStatus: SandboxModeStatus | null;
  sandboxCostBudgets: ThreadContextSandboxCostBudgets | null;
}

interface SandboxCostCapEvaluation {
  gate: SandboxCostCapGate;
  userBudget: SandboxDailyCostBudget;
  repositoryBudget: SandboxDailyCostBudget | null;
}

function toChatModeSandboxStatus(status: SandboxModeStatus | null): ChatModeSandboxStatus {
  switch (status?.reasonCode ?? "missing_sandbox") {
    case "available":
      return "ready";
    case "sandbox_provisioning":
      return "provisioning";
    case "sandbox_expired":
      return "expired";
    case "sandbox_unavailable":
      return "failed";
    case "missing_sandbox":
      return "none";
  }
}

async function computeSandboxCostCapEvaluation(
  ctx: QueryCtx,
  ownerTokenIdentifier: string,
  repositoryId: Id<"repositories"> | null,
): Promise<SandboxCostCapEvaluation> {
  const estimateCents = getSandboxReplyEstimateCents();
  const userBudget = await peekSandboxDailyCostForUser(ctx, ownerTokenIdentifier);
  const repositoryBudget = repositoryId ? await peekSandboxDailyCostForRepository(ctx, repositoryId) : null;

  if (userBudget.remainingCents < estimateCents) {
    return {
      gate: {
        enabled: false,
        reason: "user_daily_cap_exceeded",
        tooltip: DISABLED_REASON_SANDBOX_USER_CAP_EXCEEDED,
        resetAtMs: userBudget.resetAtMs,
      },
      userBudget,
      repositoryBudget,
    };
  }
  if (repositoryBudget && repositoryBudget.remainingCents < estimateCents) {
    return {
      gate: {
        enabled: false,
        reason: "repository_daily_cap_exceeded",
        tooltip: DISABLED_REASON_SANDBOX_REPOSITORY_CAP_EXCEEDED,
        resetAtMs: repositoryBudget.resetAtMs,
      },
      userBudget,
      repositoryBudget,
    };
  }
  return { gate: { enabled: true }, userBudget, repositoryBudget };
}

export async function evaluateRepositoryModeAvailability(
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

  const costGate =
    args.repository === null
      ? { enabled: true as const }
      : (await computeSandboxCostCapEvaluation(ctx, args.tokenIdentifier, args.repository._id)).gate;
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

export async function evaluateThreadModeAvailability(
  ctx: QueryCtx,
  args: {
    thread: Doc<"threads">;
    attachedRepository: Doc<"repositories"> | null;
    viewerTokenIdentifier: string;
    preloadedSandboxStatus?: {
      sandboxModeStatus: SandboxModeStatus;
      sandbox: Doc<"sandboxes"> | null;
    } | null;
  },
): Promise<ModeAvailabilitySnapshot> {
  const { attachedRepository, viewerTokenIdentifier } = args;
  let sandboxModeStatus: SandboxModeStatus | null = null;
  let sandbox: Doc<"sandboxes"> | null = null;

  if (attachedRepository) {
    const sandboxSnapshot = args.preloadedSandboxStatus ?? (await getRepositorySandboxStatus(ctx, attachedRepository));
    sandboxModeStatus = sandboxSnapshot.sandboxModeStatus;
    sandbox = sandboxSnapshot.sandbox;
  }

  let sandboxCostBudgets: ThreadContextSandboxCostBudgets | null = null;
  if (attachedRepository !== null) {
    const evaluation = await computeSandboxCostCapEvaluation(ctx, viewerTokenIdentifier, attachedRepository._id);
    sandboxCostBudgets = { userBudget: evaluation.userBudget, repositoryBudget: evaluation.repositoryBudget };
  }

  const chatModes = resolveChatModes(attachedRepository !== null);

  return {
    chatModes,
    sandbox,
    sandboxModeStatus,
    sandboxCostBudgets,
  };
}
