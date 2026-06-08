import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { classifyLiveSourceAvailability, type SandboxModeStatus } from "./liveSourceLifecycle";

export type { SandboxModeStatus } from "./liveSourceLifecycle";

type SandboxReadCtx = QueryCtx | MutationCtx;

export async function getRepositorySandboxStatus(
  ctx: SandboxReadCtx,
  repository: Doc<"repositories">,
): Promise<{
  sandboxModeStatus: SandboxModeStatus;
  sandbox: Doc<"sandboxes"> | null;
}> {
  const sandbox = repository.latestSandboxId ? await ctx.db.get(repository.latestSandboxId) : null;
  const { available: _available, ...sandboxModeStatus } = classifyLiveSourceAvailability(sandbox);
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
