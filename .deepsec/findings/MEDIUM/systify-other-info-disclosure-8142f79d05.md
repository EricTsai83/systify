# [MEDIUM] Composer drafts can leak across account switches before auth cleanup takes effect

**File:** [`src/hooks/use-composer-draft.ts`](https://github.com/EricTsai83/systify/blob/main/src/hooks/use-composer-draft.ts#L13-L72) (lines 13, 20, 21, 23, 32, 56, 58, 62, 72)
**Project:** systify
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `other-info-disclosure`

## Owners

**Suggested assignee:** `eric492718@gmail.com` _(via last-committer)_

## Finding

The hook derives localStorage keys only from thread, repository, mode, or the global repoless chat bucket, then synchronously hydrates the textarea state from that key during the first render. The app has a separate auth-bound cleanup hook that removes composer draft keys on logout/account switch, but that cleanup runs in a post-render effect. A second user opening the same browser/profile can therefore have the previous user's draft rendered into the controlled chat textarea before cleanup, and for the repoless /chat bucket the stale draft can be sent under the second user's account if it remains in memory. Drafts may contain private repository details, code snippets, or secrets typed by the previous user.

## Recommendation

Scope draft keys by the authenticated WorkOS user id/token identifier, or gate draft hydration/rendering until auth-bound cleanup has completed for the current user. Also reset the in-memory draft state when auth cleanup removes draft keys, rather than relying only on localStorage deletion.

## Recent committers (`git log`)

- Eric Tsai <eric492718@gmail.com> (2026-05-27)
