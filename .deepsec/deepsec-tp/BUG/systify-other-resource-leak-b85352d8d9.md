# [BUG] Fresh Daytona sandboxes can be orphaned if remote-info persistence fails

**File:** [`convex/lib/sandboxLiveness.ts`](https://github.com/EricTsai83/systify/blob/main/convex/lib/sandboxLiveness.ts#L333-L417) (lines 333, 336, 345, 412, 417)
**Project:** systify
**Severity:** BUG  •  **Confidence:** medium  •  **Slug:** `other-resource-leak`

## Owners

**Suggested assignee:** `eric492718@gmail.com` _(via last-committer)_

## Finding

After `provisionSandbox` returns, the new Daytona remote id is kept only in `remoteIdForCleanup` until `attachOnDemandSandboxRemoteInfo` persists it to the sandbox row. The catch path checks `remoteIdForCleanup` but only schedules cleanup by `sandboxId`; the cleanup action later reads `sandboxes.remoteId`. If an exception happens before the attach mutation commits, cleanup archives the local placeholder without deleting the actual Daytona remote. The orphan reconciler may eventually remove it by labels, but the immediate failure path leaks remote resources and cost.

## Recommendation

Make the failure cleanup path able to delete the known remote id directly, or pass/persist the remote id before any later operation can throw. At minimum, add a cleanup fallback that calls Daytona delete with `remoteIdForCleanup` when the sandbox row does not contain that remote id.

## Revalidation

**Verdict:** true-positive

The current worktree adds a best-effort direct delete, but it only runs when `scheduleSandboxCleanup` returns no cleanup job. The original problematic path still exists when the local sandbox row exists but the remote id was not persisted. After `provisionSandbox` returns, `remoteIdForCleanup` is set, but the durable row still has the placeholder `remoteId: ""` until `attachOnDemandSandboxRemoteInfo` commits. If that mutation call throws or aborts before the patch commits, the catch path calls `failOnDemandSandboxProvisioning`, which marks the row failed but does not add the known remote id. It then calls `scheduleSandboxCleanup`; because the row exists and is not archived, `queueSandboxCleanupJob` enqueues a cleanup job and returns a `jobId`, so the new direct `deleteRemoteSandboxBestEffort(remoteIdForCleanup)` branch is skipped. The cleanup action later reads `sandbox.remoteId` via `markSandboxCleanupRunning`, sees the empty string, skips `deleteSandbox`, and completes local cleanup by archiving the row. The Daytona remote id known only in `remoteIdForCleanup` is therefore still not deleted on this failure path. This is not a cross-tenant data exposure issue, but it is a real resource-leak/cost bug reachable in the on-demand sandbox provisioning flow.

## Recent committers (`git log`)

- Eric Tsai <eric492718@gmail.com> (2026-06-02)
