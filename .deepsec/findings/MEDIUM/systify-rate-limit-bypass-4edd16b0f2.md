# [MEDIUM] Authenticated GitHub API actions lack server-side abuse limits

**File:** [`convex/githubAppNode.ts`](https://github.com/EricTsai83/systify/blob/main/convex/githubAppNode.ts#L157-L315) (lines 157, 173, 214, 237, 299, 302, 315)
**Project:** systify
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `rate-limit-bypass`

## Owners

**Suggested assignee:** `eric492718@gmail.com` _(via last-committer)_

## Finding

The public actions verifyRepoAccess, listInstallationRepos, and searchGitHubRepos all perform outbound GitHub API requests using the caller's installation token, but none consumes a backend rate limit or otherwise bounds repeated direct Convex calls. listInstallationRepos also follows every GitHub pagination link until exhaustion, so one call can fan out into many GitHub requests for a large installation. The search action explicitly relies on frontend debounce, which is not an enforceable security control. A signed-in attacker with a connected installation can bypass the UI and repeatedly drain GitHub installation/search API quota or create avoidable backend load.

## Recommendation

Add server-side per-viewer and/or per-installation rate limits for these GitHub API actions, cap list pagination or require explicit pagination from the client, and treat frontend debounce only as UX.

## Recent committers (`git log`)

- Eric Tsai <eric492718@gmail.com> (2026-06-02)
