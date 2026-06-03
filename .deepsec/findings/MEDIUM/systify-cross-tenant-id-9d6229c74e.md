# [MEDIUM] Repository thread lists can include attacker-owned threads

**File:** [`src/components/repository-shell.tsx`](https://github.com/EricTsai83/systify/blob/main/src/components/repository-shell.tsx#L96-L555) (lines 96, 97, 555)
**Project:** systify
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `cross-tenant-id`

## Owners

**Suggested assignee:** `eric492718@gmail.com` _(via last-committer)_

## Finding

RepositoryShell subscribes to api.chat.threads.listThreads for the current repository and renders those results through the sidebar. Tracing the backend showed listThreads verifies the viewer owns the repository, but then reads threads by repositoryId only, while the public createThread mutation accepts a repositoryId without checking that the caller owns that repository. If an attacker obtains another user's repository id, they can create an attacker-owned thread bound to that repository id; the victim's repository thread list can then include the attacker-controlled thread title and pin state. Message reads remain owner-gated, so this is cross-tenant UI/data pollution rather than direct private message disclosure.

## Recommendation

Require repository ownership in createThread whenever repositoryId is supplied, preferably through requireActiveRepositoryForViewer or requireOwnedDoc. Also add ownerTokenIdentifier equality to repository-scoped thread queries such as listThreads and the threads slice in getRepositoryDetail, with regression tests for owner-mismatched child rows.

## Recent committers (`git log`)

- Eric Tsai <eric492718@gmail.com> (2026-06-02)
