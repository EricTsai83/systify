import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export type SandboxUnavailableCode =
  | "missing_sandbox"
  | "sandbox_unavailable"
  | "sandbox_expired"
  | "sandbox_provisioning";

export type SandboxModeStatus = {
  reasonCode: "available" | SandboxUnavailableCode;
  message: string | null;
};

type SandboxAvailability = SandboxModeStatus & { available: boolean };

type SandboxReadCtx = QueryCtx | MutationCtx;

function classifySandbox(sandbox: Doc<"sandboxes"> | null, now = Date.now()): SandboxAvailability {
  if (!sandbox) {
    return {
      available: false,
      reasonCode: "missing_sandbox",
      message:
        "A live sandbox is unavailable because no sandbox is ready for this repository yet. Sync the repository to provision one.",
    };
  }

  if (sandbox.status === "failed") {
    return {
      available: false,
      reasonCode: "sandbox_unavailable",
      message:
        "A live sandbox is unavailable because the sandbox failed. Sync the repository to provision a fresh sandbox.",
    };
  }

  if (sandbox.status === "provisioning") {
    return {
      available: false,
      reasonCode: "sandbox_provisioning",
      message:
        "A live sandbox is unavailable because the sandbox is still provisioning. Wait for the import to finish or sync the repository again.",
    };
  }

  // `archived` is a normal end-of-life state (Daytona auto-archives after the
  // configured idle interval) — treat it the same as a TTL-expired sandbox so
  // the UI surfaces it as a warning ("Sandbox expired") rather than a red
  // "Sandbox error", which is reserved for the genuine `failed` case above.
  if (sandbox.status === "stopped" || sandbox.status === "archived" || now > sandbox.ttlExpiresAt) {
    return {
      available: false,
      reasonCode: "sandbox_expired",
      message:
        "A live sandbox is unavailable because the sandbox expired. Sync the repository to provision a fresh sandbox.",
    };
  }

  if (!sandbox.remoteId || !sandbox.repoPath) {
    return {
      available: false,
      reasonCode: "sandbox_provisioning",
      message:
        "A live sandbox is unavailable because the sandbox is still provisioning. Wait for the import to finish or sync the repository again.",
    };
  }

  return {
    available: true,
    reasonCode: "available",
    message: null,
  };
}

export async function getRepositorySandboxStatus(
  ctx: SandboxReadCtx,
  repository: Doc<"repositories">,
): Promise<{
  sandboxModeStatus: SandboxModeStatus;
  sandbox: Doc<"sandboxes"> | null;
}> {
  const sandbox = repository.latestSandboxId ? await ctx.db.get(repository.latestSandboxId) : null;
  const { available: _available, ...sandboxModeStatus } = classifySandbox(sandbox);
  return { sandboxModeStatus, sandbox };
}

export async function requireRepositorySandbox(
  ctx: SandboxReadCtx,
  repository: Doc<"repositories">,
): Promise<{ sandbox: Doc<"sandboxes"> }> {
  const { sandboxModeStatus, sandbox } = await getRepositorySandboxStatus(ctx, repository);
  if (sandboxModeStatus.reasonCode !== "available" || !sandbox) {
    throw new Error(sandboxModeStatus.message ?? "Sandbox is not available for this repository.");
  }
  return { sandbox };
}
