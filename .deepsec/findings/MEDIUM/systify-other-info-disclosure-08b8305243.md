# [MEDIUM] Unauthenticated thread existence oracle

**File:** [`convex/threadContext.ts`](https://github.com/EricTsai83/systify/blob/main/convex/threadContext.ts#L100-L110) (lines 100, 106, 110)
**Project:** systify
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `other-info-disclosure`

## Owners

**Suggested assignee:** `eric492718@gmail.com` _(via last-committer)_

## Finding

getThreadContext is a public query and probes ctx.db.get(threadId) before requiring viewer identity. A nonexistent threadId returns null immediately, while an existing threadId reaches loadOwnedDoc, which calls requireViewerIdentity and throws a sign-in error for anonymous callers. This lets an unauthenticated caller distinguish valid private thread IDs from nonexistent ones without owning the thread.

## Recommendation

Authenticate before the existence probe, then return the same response for missing and non-owned threads. If anonymous callers should receive null instead of an auth error, explicitly normalize unauthenticated, missing, and unauthorized cases to the same result.

## Recent committers (`git log`)

- Eric Tsai <eric492718@gmail.com> (2026-06-02)
