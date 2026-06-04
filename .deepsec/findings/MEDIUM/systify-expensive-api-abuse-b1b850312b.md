# [MEDIUM] GitHub helper actions rely on client-side throttling

**File:** [`src/components/import-repo-dialog.tsx`](https://github.com/EricTsai83/systify/blob/main/src/components/import-repo-dialog.tsx#L357-L505) (lines 357, 386, 435, 505)
**Project:** systify
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `expensive-api-abuse`

## Owners

**Suggested assignee:** `eric492718@gmail.com` _(via last-committer)_

## Finding

The dialog invokes public Convex actions for GitHub install initiation, installation repo listing, GitHub search, and repo access verification. Tracing those actions in convex/githubAppNode.ts showed they require authentication but do not consume any server-side rate limit before writing OAuth state rows or calling GitHub APIs; the only throttle on search is the browser debounce at this component. A signed-in attacker can bypass the UI and call these public actions directly to exhaust GitHub installation/search rate limits or consume Convex/GitHub resources, especially listInstallationRepos because it walks every GitHub pagination page.

## Recommendation

Add server-side per-user/per-installation rate limits around initiateGitHubInstall, listInstallationRepos, searchGitHubRepos, and verifyRepoAccess. Consider paginating/caching repo listing and search results, and make frontend debounce purely a UX optimization.

## Recent committers (`git log`)

- Eric Tsai <eric492718@gmail.com> (2026-05-30)
