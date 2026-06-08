import type { Doc, Id } from "../_generated/dataModel";

export type LiveSourceRemoteState = "started" | "stopped" | "archived" | "destroyed" | "error" | "unknown";

export type LiveSourceRemoteObservationSource = "verify_on_use" | "webhook";

export type SandboxUnavailableCode =
  | "missing_sandbox"
  | "sandbox_unavailable"
  | "sandbox_expired"
  | "sandbox_provisioning";

export type SandboxModeStatus = {
  reasonCode: "available" | SandboxUnavailableCode;
  message: string | null;
};

export type SandboxAvailability = SandboxModeStatus & { available: boolean };

export type ReadyLiveSourceHandle = {
  sandboxId: Id<"sandboxes">;
  remoteId: string;
  repoPath: string;
};

export type SandboxSessionStartState = {
  status: "active" | "starting";
  sandboxId?: Id<"sandboxes">;
};

export type LiveSourceReadinessDecision =
  | {
      kind: "ready";
      handle: ReadyLiveSourceHandle;
    }
  | {
      kind: "poll_existing";
      sandboxId: Id<"sandboxes">;
    }
  | {
      kind: "probe_existing";
      sandbox: Doc<"sandboxes">;
    }
  | {
      kind: "provision_new";
      previousSandbox: Doc<"sandboxes"> | null;
    };

export type SandboxActivityLifecycleStatus = "idle" | "preparing" | "ready" | "expiring_soon";

/**
 * Shared user-facing copy for transient liveness failures. Keep this out of
 * the Daytona Adapter so all lifecycle callers surface the same language.
 */
export const LIVE_SOURCE_UNAVAILABLE_MESSAGE =
  "Live access to the repository wasn't available. The next attempt will prepare it first.";

const LIVE_SOURCE_PREPARING_MESSAGE = "Live source is preparing. You can keep Sandbox grounding selected.";
const LIVE_SOURCE_PREPARES_ON_DEMAND_MESSAGE = "Live source will be prepared when a task needs it.";

export function classifyLiveSourceAvailability(
  sandbox: Doc<"sandboxes"> | null,
  now = Date.now(),
): SandboxAvailability {
  if (!sandbox) {
    return {
      available: false,
      reasonCode: "missing_sandbox",
      message: LIVE_SOURCE_PREPARES_ON_DEMAND_MESSAGE,
    };
  }

  if (sandbox.status === "failed") {
    return {
      available: false,
      reasonCode: "sandbox_unavailable",
      message: LIVE_SOURCE_PREPARES_ON_DEMAND_MESSAGE,
    };
  }

  if (sandbox.status === "provisioning") {
    return {
      available: false,
      reasonCode: "sandbox_provisioning",
      message: LIVE_SOURCE_PREPARING_MESSAGE,
    };
  }

  if (sandbox.status === "stopped" || sandbox.status === "archived" || now > sandbox.ttlExpiresAt) {
    return {
      available: false,
      reasonCode: "sandbox_expired",
      message: LIVE_SOURCE_PREPARES_ON_DEMAND_MESSAGE,
    };
  }

  if (!sandbox.remoteId || !sandbox.repoPath) {
    return {
      available: false,
      reasonCode: "sandbox_provisioning",
      message: LIVE_SOURCE_PREPARING_MESSAGE,
    };
  }

  return {
    available: true,
    reasonCode: "available",
    message: null,
  };
}

export function getReadyLiveSourceHandle(sandbox: Doc<"sandboxes">): ReadyLiveSourceHandle | null {
  if (classifyLiveSourceAvailability(sandbox).available === false) {
    return null;
  }
  return {
    sandboxId: sandbox._id,
    remoteId: sandbox.remoteId,
    repoPath: sandbox.repoPath,
  };
}

export function shouldProbeExistingLiveSource(sandbox: Doc<"sandboxes">): boolean {
  return !!sandbox.remoteId && (sandbox.status === "ready" || sandbox.status === "stopped");
}

export function resolveLiveSourceReadinessDecision(sandbox: Doc<"sandboxes"> | null): LiveSourceReadinessDecision {
  if (!sandbox) {
    return { kind: "provision_new", previousSandbox: null };
  }

  if (sandbox.status === "provisioning") {
    return { kind: "poll_existing", sandboxId: sandbox._id };
  }

  const readyHandle = getReadyLiveSourceHandle(sandbox);
  if (readyHandle) {
    return { kind: "probe_existing", sandbox };
  }

  if (shouldProbeExistingLiveSource(sandbox)) {
    return { kind: "probe_existing", sandbox };
  }

  return { kind: "provision_new", previousSandbox: sandbox };
}

export function shouldReuseReservedLiveSource(sandbox: Doc<"sandboxes">): boolean {
  return sandbox.status === "provisioning" || sandbox.status === "ready";
}

export function shouldQueueLiveSourceCleanup(sandbox: Doc<"sandboxes">): boolean {
  return sandbox.status !== "archived";
}

export function resolveSandboxSessionStartState(
  sandbox: Doc<"sandboxes"> | null,
  now = Date.now(),
): SandboxSessionStartState {
  if (!sandbox) {
    return { status: "starting" };
  }

  const availability = classifyLiveSourceAvailability(sandbox, now);
  if (availability.available) {
    return { status: "active", sandboxId: sandbox._id };
  }

  if (sandbox.status === "ready" || sandbox.status === "stopped" || sandbox.status === "provisioning") {
    return { status: "starting", sandboxId: sandbox._id };
  }

  return { status: "starting" };
}

export function resolveSandboxSessionStartStateForRepository(args: {
  latestSandboxId?: Id<"sandboxes">;
  sandbox: Doc<"sandboxes"> | null;
  now?: number;
}): SandboxSessionStartState {
  const state = resolveSandboxSessionStartState(args.sandbox, args.now);
  if (state.sandboxId || !args.latestSandboxId) {
    return state;
  }
  return { status: "starting", sandboxId: args.latestSandboxId };
}

export function resolveSandboxActivityLifecycleStatus(args: {
  activeJob: Doc<"jobs"> | null;
  sandbox: Doc<"sandboxes"> | null;
  now?: number;
  expiringSoonMs: number;
}): SandboxActivityLifecycleStatus {
  const now = args.now ?? Date.now();
  if (args.activeJob || args.sandbox?.status === "provisioning") {
    return "preparing";
  }

  const availability = classifyLiveSourceAvailability(args.sandbox, now);
  if (!availability.available || !args.sandbox) {
    return "idle";
  }

  const remainingMs = args.sandbox.ttlExpiresAt - now;
  return remainingMs < args.expiringSoonMs ? "expiring_soon" : "ready";
}

export function buildLiveSourceCleanupCompletedPatch(
  now = Date.now(),
): Pick<Doc<"sandboxes">, "status" | "lastUsedAt"> {
  return {
    status: "archived",
    lastUsedAt: now,
  };
}

export function buildLiveSourceSweepPatch(
  newStatus: "stopped" | "archived",
  now = Date.now(),
): Pick<Doc<"sandboxes">, "status" | "lastUsedAt"> {
  return {
    status: newStatus,
    lastUsedAt: now,
  };
}

export function buildLiveSourceRemoteStatePatch(args: {
  sandbox: Doc<"sandboxes">;
  remoteState: LiveSourceRemoteState;
  source: LiveSourceRemoteObservationSource;
  now?: number;
}): Partial<Doc<"sandboxes">> {
  if (args.sandbox.status === "archived") {
    return {};
  }

  if (args.source === "webhook" && (args.sandbox.status === "provisioning" || args.sandbox.status === "failed")) {
    return {};
  }

  const now = args.now ?? Date.now();
  switch (args.remoteState) {
    case "started":
      return {
        status: "ready",
        lastUsedAt: now,
      };
    case "stopped":
      return {
        status: "stopped",
        lastUsedAt: now,
      };
    case "archived":
    case "destroyed":
      return {
        status: "archived",
        lastUsedAt: now,
      };
    case "error":
      return {
        status: "failed",
        lastErrorMessage:
          args.source === "webhook"
            ? "Daytona reported a sandbox error via webhook."
            : "Daytona reported the sandbox as errored during a live verification.",
      };
    case "unknown":
      return {};
  }
}

export function buildLiveSourceRemoteObservationPatch(args: {
  sandbox: Doc<"sandboxes">;
  remoteState: LiveSourceRemoteState;
  source: LiveSourceRemoteObservationSource;
  now?: number;
}): Partial<Doc<"sandboxes">> {
  return buildLiveSourceRemoteStatePatch(args);
}
