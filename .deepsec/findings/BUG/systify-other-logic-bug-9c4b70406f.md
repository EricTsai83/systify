# [BUG] GitHub branch URLs with slash-containing branch names are parsed incorrectly

**File:** [`convex/lib/github.ts`](https://github.com/EricTsai83/systify/blob/main/convex/lib/github.ts#L44-L45) (lines 44, 45)
**Project:** systify
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-logic-bug`

## Owners

**Suggested assignee:** `eric492718@gmail.com` _(via last-committer)_

## Finding

parseGitHubUrl only uses segments[3] as the branch when parsing /tree/... URLs. GitHub branch names commonly contain slashes, such as feature/foo, and GitHub represents those as /tree/feature/foo. This code parses that URL as branch "feature" instead of "feature/foo", which can make repository import fail or import the wrong branch if a shorter branch with that name exists.

## Recommendation

When segments[2] is "tree", parse the branch as segments.slice(3).join("/") and add tests for slash-containing branch names. Consider validating owner and repo names against GitHub's allowed repository path syntax at the same boundary.

## Recent committers (`git log`)

- Eric Tsai <eric492718@gmail.com> (2026-05-01)
