# [BUG] Eval runner uses synthetic owner for owner-scoped sandbox preparation

**File:** [`convex/eval/systemDesign/runner.ts`](https://github.com/EricTsai83/systify/blob/main/convex/eval/systemDesign/runner.ts#L52-L112) (lines 52, 77, 110, 112)
**Project:** systify
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-logic-bug`

## Owners

**Suggested assignee:** `eric492718@gmail.com` _(via last-committer)_

## Finding

The eval action accepts operator-supplied repository IDs and documents that operators should pre-import repositories through the normal app flow, but sandbox preparation is called with the hard-coded ownerTokenIdentifier "eval:harness". The imported ensureSandboxReady path calls getRepositorySandboxForPreparation, which returns null unless the repository is owned by the supplied token. Normal app-imported repositories are owned by the operator's real WorkOS token, so valid repository IDs will be skipped as sandbox_preparation_failed/repository_not_found and the eval run can produce zero records. This is not a security vulnerability because runEval is an internal action and the owner check fails closed, but it breaks the documented eval workflow.

## Recommendation

Make the owner contract explicit and consistent. Either pass the operator owner token into runEval and verify each repository against it, or load the repository first and use repository.ownerTokenIdentifier for ensureSandboxReady while keeping eval:harness only for eval LLM cost/rate-limit attribution.

## Recent committers (`git log`)

- Eric Tsai <eric492718@gmail.com> (2026-06-02)
