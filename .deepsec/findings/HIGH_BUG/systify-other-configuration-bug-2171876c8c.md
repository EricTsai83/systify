# [HIGH_BUG] Vector index dimension conflicts with supported embedding override

**File:** [`convex/schema.ts`](https://github.com/EricTsai83/systify/blob/main/convex/schema.ts#L1318-L1320) (lines 1318, 1320)
**Project:** systify
**Severity:** HIGH_BUG  •  **Confidence:** high  •  **Slug:** `other-configuration-bug`

## Owners

**Suggested assignee:** `eric492718@gmail.com` _(via last-committer)_

## Finding

The artifactChunks vector index is fixed at 1536 dimensions, but the indexing code permits ARTIFACT_EMBEDDING_MODEL=text-embedding-3-large. OpenAI text-embedding-3-large returns 3072-dimensional vectors by default unless a dimensions parameter is supplied, so that supported configuration can break embedding writes or semantic retrieval.

## Recommendation

Make embedding dimensions part of the model catalog and pass a matching dimensions option to the provider, or reject models whose output dimension does not match the Convex vector index.

## Recent committers (`git log`)

- Eric Tsai <eric492718@gmail.com> (2026-06-02)
