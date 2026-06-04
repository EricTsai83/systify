# [BUG] User cost rollup scans all chat messages before applying the time window

**File:** [`convex/lib/userCost.ts`](https://github.com/EricTsai83/systify/blob/main/convex/lib/userCost.ts#L198-L204) (lines 198, 200, 201, 204)
**Project:** systify
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-unbounded-query`

## Owners

**Suggested assignee:** `eric492718@gmail.com` _(via last-committer)_

## Finding

`getUserCostBreakdown` uses the `by_ownerTokenIdentifier` messages index and `.collect()`s every message for the user, then filters `_creationTime` in memory. The `sinceMs`/`untilMs` window does not bound the database read, so cost reports for active users with long chat histories can become slow or hit Convex limits even for a small requested window. The System Design slice is correctly time-bounded with `by_owner_and_startedAt`; the chat slice is not.

## Recommendation

Add/use a time-bounded owner index for messages, constrain the query by the requested window, or aggregate chat costs into a dedicated ledger/rollup table as messages finalize.

## Recent committers (`git log`)

- Eric Tsai <eric492718@gmail.com> (2026-06-01)
