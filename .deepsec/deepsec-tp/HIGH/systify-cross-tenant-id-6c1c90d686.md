# [HIGH] GitHub installation IDs can be bound to the wrong owner

**File:** [`convex/github.ts`](https://github.com/EricTsai83/systify/blob/main/convex/github.ts#L148-L280) (lines 148, 154, 162, 195, 280)
**Project:** systify
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `cross-tenant-id`

## Owners

**Suggested assignee:** `eric492718@gmail.com` _(via last-committer)_

## Finding

saveInstallation only checks active installations for the supplied ownerTokenIdentifier, then stores the supplied installationId under that owner. It never verifies that the GitHub installation is controlled by that Systify user, nor that the installationId is not already associated with a different owner. The public callback consumes a valid Systify state and passes the URL installation_id into this mutation; downstream getInstallationIdForOwner returns that stored ID and the app can mint an installation access token for it. An authenticated attacker who gets their own state and supplies a known victim installation_id could attach that installation to their Systify account and access private repositories granted to the victim GitHub App installation.

## Recommendation

Treat installation_id as untrusted. Verify the authenticated user controls the installation, for example with a GitHub OAuth user token and GitHub's accessible-installations API, before saving it. Also enforce a one-active-owner-per-installation invariant by checking by_installationId in the same mutation and rejecting foreign active rows.

## Revalidation

**Verdict:** true-positive

The current saveInstallation mutation now checks by_installationId and rejects an installation ID that is already active for another owner, so one branch of the finding has been mitigated. However, it still treats the callback installation_id as sufficient proof that the Systify user controls that GitHub installation. The /api/github/callback handler consumes a Systify OAuth state, fetches installation details with the app JWT, and then calls saveInstallation with the ownerTokenIdentifier from the state; none of those steps uses a GitHub user OAuth token or GitHub accessible-installations check to bind the installation to the browser user. If an attacker has their own valid Systify state and supplies a known victim installation_id that is not already active in Systify, saveInstallation will create an active githubInstallations row for the attacker. Downstream getInstallationIdForOwner returns that ID, and getInstallationAccessToken mints a GitHub installation token using the app private key for whatever installation ID is stored. That token is then used by list/search/import/sandbox access paths to read repositories granted to the victim installation. The exploit requires knowledge of a target installation ID and fails if that installation is already active under another owner, but private repository exposure remains possible for unbound or previously deleted installations. The remaining missing control is server-side verification that the authenticated GitHub account actually controls the installation before saving it.

## Recent committers (`git log`)

- Eric Tsai <eric492718@gmail.com> (2026-05-03)
