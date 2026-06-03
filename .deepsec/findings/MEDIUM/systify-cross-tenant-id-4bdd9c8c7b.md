# [MEDIUM] Foreign repository IDs can inject attacker-owned threads into another user's repository thread list

**File:** [`convex/chat/threads.ts`](https://github.com/EricTsai83/systify/blob/main/convex/chat/threads.ts#L39-L216) (lines 39, 48, 55, 61, 68, 72, 198, 207, 216)
**Project:** systify
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `cross-tenant-id`

## Owners

**Suggested assignee:** `eric492718@gmail.com` _(via last-committer)_

## Finding

The public createThread mutation derives the caller identity, but when repositoryId is supplied it inserts the thread without verifying that the repository belongs to that identity. listThreads does verify that the viewer owns the requested repository, but then queries threads only by repositoryId/mode/pinnedAt/lastMessageAt and returns the raw thread documents without filtering ownerTokenIdentifier. If an attacker obtains a victim repository ID, they can create an attacker-owned thread referencing that repository; when the victim lists their repository threads, that attacker-controlled thread can be returned, including attacker-controlled title/mode/pinned metadata and the attacker's ownerTokenIdentifier. Downstream send/read paths re-check repository ownership, so this does not appear to expose private repository contents, but it is still a cross-tenant metadata injection and sidebar pollution issue.

## Recommendation

In createThread, when repositoryId is provided, require ownership and repository state with requireActiveRepositoryForViewer or at least requireOwnedDoc before inserting. Also make listThreads owner-scoped by querying/filtering on ownerTokenIdentifier, ideally with new indexes such as ownerTokenIdentifier + repositoryId + mode + lastMessageAt/pinnedAt so foreign rows cannot be returned or starve legitimate results.

## Recent committers (`git log`)

- Eric Tsai <eric492718@gmail.com> (2026-06-01)
