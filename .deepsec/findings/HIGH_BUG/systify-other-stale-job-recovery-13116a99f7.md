# [HIGH_BUG] Cleanup jobs can get stuck forever and block sandbox deletion

**File:** [`convex/ops.ts`](https://github.com/EricTsai83/systify/blob/main/convex/ops.ts#L23-L416) (lines 23, 29, 63, 72, 404, 411, 416)
**Project:** systify
**Severity:** HIGH_BUG  •  **Confidence:** high  •  **Slug:** `other-stale-job-recovery`

## Owners

**Suggested assignee:** `eric492718@gmail.com` _(via last-committer)_

## Finding

Cleanup jobs are enqueued without a lease, while listActiveCleanupJobs treats any queued or running cleanup job as active. The stale-job recovery query only covers chat, system_design, and sandbox_activation jobs, so a cleanup action that never starts or dies after being marked running leaves a permanent queued/running cleanup job. Future cleanup scheduling deduplicates against that stale row instead of re-enqueueing, and repository deletion can keep waiting on sandbox cleanup indefinitely while Daytona resources remain allocated.

## Recommendation

Give cleanup jobs a leaseMs when enqueued, refresh or clear the lease during runSandboxCleanup, and add stale cleanup recovery that either re-enqueues cleanup or fails the stale job so a later schedule can retry. Deduplication should ignore expired cleanup jobs.

## Recent committers (`git log`)

- Eric Tsai <eric492718@gmail.com> (2026-06-02)
