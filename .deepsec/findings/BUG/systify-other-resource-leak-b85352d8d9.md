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

## Recent committers (`git log`)

- Eric Tsai <eric492718@gmail.com> (2026-06-02)
