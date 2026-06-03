# [BUG] Scoped Library Ask artifacts can survive a repository swap

**File:** [`convex/chat/context.ts`](https://github.com/EricTsai83/systify/blob/main/convex/chat/context.ts#L329-L331) (lines 329, 330, 331)
**Project:** systify
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-logic-bug`

## Owners

**Suggested assignee:** `eric492718@gmail.com` _(via last-committer)_

## Finding

When a thread has artifactContext, getReplyContext loads those artifact ids directly and includes every non-null artifact in the prompt without rechecking that each artifact still belongs to the thread's current repository. The creation path validates the scope initially, but setThreadRepository can later swap the thread to a different owned repository without clearing artifactContext. Subsequent replies for repository B can therefore include stale artifacts from repository A, causing incorrect grounding and cross-repository data mixing within the same account.

## Recommendation

When loading scoped artifacts, require artifact.repositoryId === repository._id and artifact.ownerTokenIdentifier === repository.ownerTokenIdentifier, or clear artifactContext whenever the thread repository changes.

## Recent committers (`git log`)

- Eric Tsai <eric492718@gmail.com> (2026-06-02)
