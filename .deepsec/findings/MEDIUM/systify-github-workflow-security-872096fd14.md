# [MEDIUM] CI uses mutable action refs and a floating Bun version

**File:** [`.github/workflows/ci.yml`](https://github.com/EricTsai83/systify/blob/main/.github/workflows/ci.yml#L15-L20) (lines 15, 18, 20)
**Project:** systify
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `github-workflow-security`

## Owners

**Suggested assignee:** `eric492718@gmail.com` _(via last-committer)_

## Finding

The CI workflow executes GitHub Actions from mutable major-version tags: `actions/checkout@v4` and `oven-sh/setup-bun@v2`. If an upstream action tag is moved or the action publisher is compromised, attacker-controlled code would run in this workflow with access to the checked-out repository, job environment, and the job's GitHub token. The workflow also installs `bun-version: latest`, which makes the CI toolchain non-reproducible and increases supply-chain drift. No deployment secrets are evident in this file, so impact is limited, but this is still a real CI supply-chain risk.

## Recommendation

Pin third-party actions to full commit SHAs, pin Bun to an explicit version, and add minimal workflow permissions such as `permissions: contents: read` for this verification job.

## Recent committers (`git log`)

- Eric Tsai <eric492718@gmail.com> (2026-04-21)
