# [BUG] Gateway does not enforce catalog capability before dispatch

**File:** [`convex/lib/llmGateway.ts`](https://github.com/EricTsai83/systify/blob/main/convex/lib/llmGateway.ts#L246-L521) (lines 246, 315, 389, 506, 521)
**Project:** systify
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-model-capability-validation`

## Owners

**Suggested assignee:** `eric492718@gmail.com` _(via last-committer)_

## Finding

The gateway is documented as the single chokepoint for LLM calls, but assertCatalogPick() only verifies that a provider/modelName exists in MODEL_CATALOG. generateViaGateway() and streamViaGateway() do not reject embedding-capability models, and embedViaGateway() only checks the caller-supplied callCtx.capability string rather than the catalog entry's capability. This allows a misconfigured internal caller or crafted public model selection accepted upstream to route an embedding model into text generation, or a generation model into the embedding path, producing provider errors instead of a clear local rejection.

## Recommendation

Load the catalog entry once at the gateway boundary and assert the route matches it: generation/streaming should reject capability === "embedding", and embedding should require entry.capability === "embedding". Prefer returning the catalog entry from the assertion so dispatch, pricing, and provider options share the same validated object.

## Recent committers (`git log`)

- Eric Tsai <eric492718@gmail.com> (2026-06-02)
