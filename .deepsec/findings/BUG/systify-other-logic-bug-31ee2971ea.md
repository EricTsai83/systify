# [BUG] Eval CLI cannot use normally pre-imported repositories

**File:** [`scripts/evalSystemDesign.ts`](https://github.com/EricTsai83/systify/blob/main/scripts/evalSystemDesign.ts#L16-L170) (lines 16, 17, 161, 170)
**Project:** systify
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-logic-bug`

## Owners

**Suggested assignee:** `eric492718@gmail.com` _(via last-committer)_

## Finding

The CLI contract says operators pre-import corpus repositories through the normal app flow and pass only a slug-to-repositoryId map. The script builds queryArgs with repositoryIds only and invokes eval/systemDesign/runner:runEval. In the imported runner, however, sandbox preparation is called with the hard-coded ownerTokenIdentifier "eval:harness". The repository preparation query returns null unless the repository row is owned by that token, so repositories imported by the operator's real WorkOS identity will be skipped as sandbox_preparation_failed/repository_not_found. This breaks the documented eval workflow and can produce zero eval records for valid repository IDs.

## Recommendation

Make the owner contract explicit and consistent. Either pass an owner token from the CLI and verify each repository belongs to it, or have the runner load each repository and use repository.ownerTokenIdentifier for ensureSandboxReady while keeping eval:harness only for eval cost attribution.

## Recent committers (`git log`)

- Eric Tsai <eric492718@gmail.com> (2026-06-01)
