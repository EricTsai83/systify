# [BUG] Invalid --budgets values silently fall back to the default paid eval budget

**File:** [`scripts/evalSystemDesign.ts`](https://github.com/EricTsai83/systify/blob/main/scripts/evalSystemDesign.ts#L150-L164) (lines 150, 151, 152, 153, 164)
**Project:** systify
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-input-validation`

## Owners

**Suggested assignee:** `eric492718@gmail.com` _(via last-committer)_

## Finding

The CLI parses --budgets by converting each token to Number and filtering out non-finite or non-positive values. If an operator passes --budgets=ten or --budgets=0, the resulting array is empty, queryArgs.budgets is omitted, and the Convex runner defaults to its DEFAULT_BUDGET of 20. Because this workflow performs real sandbox-backed LLM calls, a typo can run a different and potentially more expensive eval than intended instead of failing fast.

## Recommendation

When --budgets is provided, validate every token as a positive integer and exit with an error on any invalid value. Do not omit budgets after parsing an invalid or empty provided value.

## Recent committers (`git log`)

- Eric Tsai <eric492718@gmail.com> (2026-06-01)
