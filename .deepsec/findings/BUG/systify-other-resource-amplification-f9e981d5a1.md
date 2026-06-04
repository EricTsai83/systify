# [BUG] Cache-preview query does unbounded duplicate work

**File:** [`convex/systemDesign.ts`](https://github.com/EricTsai83/systify/blob/main/convex/systemDesign.ts#L960-L994) (lines 960, 963, 981, 988, 990, 994)
**Project:** systify
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-resource-amplification`

## Owners

**Suggested assignee:** `eric492718@gmail.com` _(via last-committer)_

## Finding

The public getCachedSelectionStatus query accepts an array of system design kinds and iterates over args.selections directly, running an artifacts query and collect for every element. Since the domain has only eight valid kinds but duplicate entries are not deduplicated or capped here, an authenticated caller can send a very large array of repeated valid kinds and force thousands of redundant DB reads, causing query failures or unnecessary backend load. The request mutation deduplicates selections before scheduling, but this preview query does not.

## Recommendation

Normalize selections with Array.from(new Set(args.selections)).filter(isSystemDesignKind) before computing totals or querying, and consider rejecting arrays larger than the number of supported kinds.

## Recent committers (`git log`)

- Eric Tsai <eric492718@gmail.com> (2026-06-02)
