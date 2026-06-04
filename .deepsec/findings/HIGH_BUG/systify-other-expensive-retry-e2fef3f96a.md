# [HIGH_BUG] Embedding model override can repeatedly spend on doomed indexing retries

**File:** [`convex/artifactIndexing.ts`](https://github.com/EricTsai83/systify/blob/main/convex/artifactIndexing.ts#L21-L211) (lines 21, 118, 184, 189, 211)
**Project:** systify
**Severity:** HIGH_BUG  •  **Confidence:** high  •  **Slug:** `other-expensive-retry`

## Owners

**Suggested assignee:** `eric492718@gmail.com` _(via last-committer)_

## Finding

The file explicitly allows ARTIFACT_EMBEDDING_MODEL to select text-embedding-3-large and then sends that model to embedViaGateway. With the schema's 1536-dimensional vector index, 3072-dimensional large embeddings will fail or be unusable. The indexer settles embedding spend before writing vectors, marks the artifact failed on error, and the retry cron later reprocesses failed artifacts, so a bad supported configuration can repeatedly pay for embeddings without ever indexing successfully.

## Recommendation

Validate the selected embedding model's output dimension before making provider calls, pass a 1536-dimension option when using large embeddings, or restrict the env var to models matching the current index. Avoid charging/retrying indefinitely for deterministic dimension mismatches.

## Recent committers (`git log`)

- Eric Tsai <eric492718@gmail.com> (2026-06-01)
