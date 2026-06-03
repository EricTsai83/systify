# [MEDIUM] Remote-update check throttle is bypassable on failures and races

**File:** [`convex/githubCheck.ts`](https://github.com/EricTsai83/systify/blob/main/convex/githubCheck.ts#L41-L114) (lines 41, 42, 59, 62, 111, 114)
**Project:** systify
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `rate-limit-bypass`

## Owners

**Suggested assignee:** `eric492718@gmail.com` _(via last-committer)_

## Finding

checkForUpdates reads lastCheckedForUpdatesAt before the outbound GitHub request, then only updates it after a successful SHA fetch. Failed GitHub requests leave the timestamp unchanged, and concurrent invocations can all pass the pre-check before any one updates the row. An authenticated caller can repeatedly invoke the public action for an owned repository to generate unthrottled GitHub requests, especially when the remote call fails.

## Recommendation

Reserve/update the throttle timestamp atomically before the outbound request, record failed check attempts as well as successful ones, and consider adding a per-viewer GitHub-check rate limit.

## Recent committers (`git log`)

- Eric Tsai <eric492718@gmail.com> (2026-05-24)
