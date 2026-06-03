# [BUG] Cached System Design runs drop the artifact reference

**File:** [`convex/systemDesignNode.ts`](https://github.com/EricTsai83/systify/blob/main/convex/systemDesignNode.ts#L228-L362) (lines 228, 230, 337, 362)
**Project:** systify
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-telemetry-linkage`

## Owners

**Suggested assignee:** `eric492718@gmail.com` _(via last-committer)_

## Finding

On a cache hit the action stores cached._id in the local artifactId variable, but recordKindRun is called without any artifactId field and linkKindRun is deliberately skipped for cached_hit runs. As a result, cached_hit systemDesignKindRuns rows cannot point back to the artifact they reused, despite the schema comments expecting artifactId on cached_hit rows. This breaks audit and reporting traceability for cached runs.

## Recommendation

Add an optional artifactId argument to recordKindRun and persist it on the kind-run row for cached_hit runs, without overwriting the artifact's original kindRunId provenance.

## Recent committers (`git log`)

- Eric Tsai <eric492718@gmail.com> (2026-06-02)
