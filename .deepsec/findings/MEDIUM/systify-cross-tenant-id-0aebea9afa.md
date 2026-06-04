# [MEDIUM] Thread creation accepts an unchecked repository id

**File:** [`src/components/repository-threads-rail.tsx`](https://github.com/EricTsai83/systify/blob/main/src/components/repository-threads-rail.tsx#L197-L200) (lines 197, 198, 199, 200)
**Project:** systify
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `cross-tenant-id`

## Owners

**Suggested assignee:** `eric492718@gmail.com` _(via last-committer)_

## Finding

The rail can call api.chat.threads.createThread with repositoryId from client-controlled state. Tracing that public Convex mutation shows it only requires a signed-in identity before inserting a thread with args.repositoryId, without verifying the viewer owns that repository. Repository thread listings then query by repositoryId without also constraining ownerTokenIdentifier, so an authenticated attacker who learns another user's repository id can create attacker-owned thread rows attached to the victim repository and have arbitrary thread titles appear in the victim's repository rail/detail views. React escaping prevents XSS, but this is a cross-tenant persistent integrity/UI-DoS issue.

## Recommendation

In convex/chat/threads.createThread, require ownership/active access when repositoryId is present, e.g. requireActiveRepositoryForViewer or requireOwnedDoc before insert. Also make repository thread reads defensively owner-scoped, and add tests that foreign repository ids are rejected and mixed-owner thread rows are not listed.

## Recent committers (`git log`)

- Eric Tsai <eric492718@gmail.com> (2026-06-01)
