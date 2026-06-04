# [HIGH_BUG] Repository imports can remain queued/running indefinitely and block future syncs

**File:** [`convex/repositories.ts`](https://github.com/EricTsai83/systify/blob/main/convex/repositories.ts#L50-L467) (lines 50, 58, 68, 73, 364, 467)
**Project:** systify
**Severity:** HIGH_BUG  •  **Confidence:** high  •  **Slug:** `other-stale-job-recovery`

## Owners

**Suggested assignee:** `eric492718@gmail.com` _(via last-committer)_

## Finding

queueImportWorkflow enqueues an import job and sets the repository importStatus to queued, but the job is created without a lease or visible stale recovery path. If the scheduled importsNode action never starts, crashes, or is killed after marking the import running but before finalizing failure/completion, the repository remains queued/running. Both createRepositoryImport and syncRepository reject when importStatus is queued or running, so the user can be permanently blocked from retrying without manual database repair.

## Recommendation

Add import job leases at enqueue/start, refresh the lease while the import pipeline progresses, and add stale import recovery that fails/cancels the import and resets repository importStatus or safely resumes the pipeline. The duplicate-in-flight checks should treat expired import jobs as recoverable rather than permanently active.

## Recent committers (`git log`)

- Eric Tsai <eric492718@gmail.com> (2026-06-02)
