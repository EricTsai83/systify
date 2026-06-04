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

## Recent committers (`git log`)

- Eric Tsai <eric492718@gmail.com> (2026-05-03)
