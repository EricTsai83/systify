"use node";

import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { probeLiveSandbox, type LiveSandboxProbe } from "../daytona";

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
