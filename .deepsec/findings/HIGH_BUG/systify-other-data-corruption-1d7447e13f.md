# [HIGH_BUG] Folder caps are assumed but not enforced before bounded tree mutations

**File:** [`convex/artifactFolders.ts`](https://github.com/EricTsai83/systify/blob/main/convex/artifactFolders.ts#L10-L325) (lines 10, 63, 117, 263, 274, 311, 325)
**Project:** systify
**Severity:** HIGH_BUG  •  **Confidence:** high  •  **Slug:** `other-data-corruption`

## Owners

**Suggested assignee:** `eric492718@gmail.com` _(via last-committer)_

## Finding

The code relies on a 200-folder and 200-artifact cap for cycle detection and delete operations, but create inserts folders without checking the per-repository count. Because ensureNoCycle stops after 200 hops, a deeper chain can bypass cycle detection. remove also processes only the first 200 child folders or artifacts before deleting the folder, leaving any extras with parentFolderId or folderId pointing at a deleted folder.

## Recommendation

Enforce the folder and artifact placement caps at create/move time, or change delete/move operations to paginate through all children and artifacts in batches. Add explicit overflow checks for artifacts before deleting a folder.

## Recent committers (`git log`)

- Eric Tsai <eric492718@gmail.com> (2026-06-01)
