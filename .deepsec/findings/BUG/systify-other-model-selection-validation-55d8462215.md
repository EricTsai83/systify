# [BUG] Public model validation accepts hidden and embedding-only catalog entries

**File:** [`convex/lib/llmCatalog.ts`](https://github.com/EricTsai83/systify/blob/main/convex/lib/llmCatalog.ts#L252-L321) (lines 252, 301, 321)
**Project:** systify
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-model-selection-validation`

## Owners

**Suggested assignee:** `eric492718@gmail.com` _(via last-committer)_

## Finding

The catalog correctly distinguishes UI-visible models via userPickable and listPickableModels(), but isValidPick() only checks raw catalog membership. Public callers such as chat send and System Design generation use isValidPick() for client-supplied provider/modelName pairs, so a crafted client can select entries intentionally hidden from the picker, including embedding-only rows marked userPickable: false. This is not an auth bypass or cross-tenant issue, but it lets invalid model classes be persisted and routed into generation flows, causing failed replies/jobs and avoidable resource use.

## Recommendation

Split catalog membership from public pick validation. Add a helper such as isUserPickableModel(provider, modelName, capability?) that requires userPickable: true and, where appropriate, a generation capability, then use it in public mutations. Keep a separate internal isCatalogEntry check for role/default/internal model use.

## Recent committers (`git log`)

- Eric Tsai <eric492718@gmail.com> (2026-06-02)
