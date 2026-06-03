# [HIGH] Clone failure wrapper can persist unredacted credential-bearing SDK errors

**File:** [`convex/daytona.ts`](https://github.com/EricTsai83/systify/blob/main/convex/daytona.ts#L369-L550) (lines 369, 374, 375, 537, 549, 550)
**Project:** systify
**Severity:** HIGH  •  **Confidence:** medium  •  **Slug:** `secret-in-log`

## Owners

**Suggested assignee:** `eric492718@gmail.com` _(via last-committer)_

## Finding

cloneRepositoryInSandbox passes the GitHub installation token into sandbox.git.clone, then wrapDaytonaCloneError appends the raw upstream error.message and attaches the raw error as cause. The wrapped message is later logged and stored in sandbox failure state by callers. If Daytona or git includes the credentialized clone URL, username/password, or Authorization material in a clone failure message, the one-hour GitHub installation token can be exposed in durable logs or user-visible error state. The code comments assert the token is never included, but the implementation does not redact the upstream message or cause.

## Recommendation

Redact credential patterns from upstream clone error messages before adding them to wrapped errors, avoid attaching raw credential-adjacent SDK errors as logged causes, and store only sanitized status/code/host/branch diagnostics in user-visible error fields.

## Recent committers (`git log`)

- Eric Tsai <eric492718@gmail.com> (2026-05-31)
