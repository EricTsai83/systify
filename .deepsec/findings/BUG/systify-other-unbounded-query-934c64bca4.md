# [BUG] System Design folder seeding scans every folder in the repository

**File:** [`convex/lib/systemDesign.ts`](https://github.com/EricTsai83/systify/blob/main/convex/lib/systemDesign.ts#L43-L46) (lines 43, 45, 46)
**Project:** systify
**Severity:** BUG  •  **Confidence:** medium  •  **Slug:** `other-unbounded-query`

## Owners

**Suggested assignee:** `eric492718@gmail.com` _(via last-committer)_

## Finding

`ensureSystemDesignFolders` queries `artifactFolders` with only `repositoryId` bound on the `by_repositoryId_and_systemKey` index and then calls `.collect()`. Because user-created folders are in the same repository slice, a repository with many folders can make imports and System Design requests scan an unbounded set before seeding seven system folders. This is owner-scoped rather than cross-tenant, but it can make import/header persistence or generation fail for large folder sets.

## Recommendation

Query each expected `systemKey` with both `repositoryId` and `systemKey`, or enforce a hard per-repository folder cap and use bounded reads. Avoid `.collect()` over the whole repository folder slice.

## Recent committers (`git log`)

- Eric Tsai <eric492718@gmail.com> (2026-05-29)
