# Auth And Access

## Purpose

This document explains how Systify connects WorkOS, Convex, and the GitHub App, and describes where authentication and access control are enforced across the current system.

## Authentication Boundary Overview

```mermaid
flowchart TD
  User[User]
  Frontend[ReactFrontend]
  WorkOS[WorkOSAuthKit]
  ConvexClient[ConvexProviderWithAuthKit]
  ConvexServer[ConvexFunctions]
  GitHubApp[GitHubApp]

  User --> Frontend
  Frontend --> WorkOS
  WorkOS --> Frontend
  Frontend --> ConvexClient
  ConvexClient --> ConvexServer
  ConvexServer --> GitHubApp
```



## Frontend Identity Flow

### 1. WorkOS AuthKit creates the user session

The frontend wraps the application with `AuthKitProvider` in `src/App.tsx` (mounted from `src/main.tsx`, which only sets up the React root) and uses:

- `VITE_WORKOS_CLIENT_ID`
- the current browser origin to build `/callback`

WorkOS is the source of the browser-side sign-in experience.

### 2. Convex uses the WorkOS token

Systify does not treat local WorkOS state as the application's source of truth for auth. Instead, it passes the WorkOS access token into Convex through `ConvexProviderWithAuthKit`.

This wrapper has two responsibilities:

- adapt the WorkOS hook to the `useAuth` interface expected by `ConvexProviderWithAuth`
- surface `authError` when token fetching fails so the UI can ask the user to refresh

The frontend auth boundary can therefore be summarized as:

- WorkOS: produces sign-in state and an access token
- `ConvexProviderWithAuthKit`: attaches that token to all Convex requests
- `ProtectedLayout`: protects every authenticated route via `useConvexAuth()`. From `src/router.tsx`, that includes `/chat`, `/chat/:threadId`, `/r/:repositoryId`, `/r/:repositoryId/discuss`, `/r/:repositoryId/discuss/:threadId`, `/r/:repositoryId/library`, `/r/:repositoryId/library/a/:artifactId`, `/archive`, and `/resources` — not just `/chat`.
- `LandingRoute`: redirects authenticated users from `/` to `/chat`

## Backend Authentication

### Convex custom JWT

`convex/auth.config.ts` configures WorkOS as Convex's custom JWT provider. The key validation parameters are:

- issuer: `https://api.workos.com/user_management/${WORKOS_CLIENT_ID}`
- algorithm: `RS256`
- jwks: `https://api.workos.com/sso/jwks/${WORKOS_CLIENT_ID}`

In other words, backend sign-in is not determined by local frontend state. It is determined by whether Convex accepts the JWT.

### `requireViewerIdentity()`

Most backend entry points begin by calling `requireViewerIdentity(ctx)`. The helper is small, but it standardizes the security assumptions:

- unauthenticated access is rejected immediately
- all later data access assumes that a verified `identity` is already available

## Authorization Pattern

### Never trust a frontend-provided user id

The current backend design does not rely on a frontend-provided `userId` for authorization. It always derives the current user from `ctx.auth.getUserIdentity()`.

This is one of the most important authorization rules in the system.

### Use `tokenIdentifier` as the owner key

Tables generally store resource ownership in `ownerTokenIdentifier` and validate against `identity.tokenIdentifier`. This means:

- the repository layer is owner-scoped
- threads, messages, and installations are also owner-scoped
- queries and mutations typically perform an owner check after loading the document

This pattern is more stable than using email or display name and prevents users from impersonating others by forging ids.

### Frontend route guards are not the only security layer

`ProtectedLayout` and `LandingRoute` are UX guards, not the sole access-control mechanism. Actual security still depends on:

- Convex auth configuration
- `requireViewerIdentity()`
- document ownership checks

So even if someone bypasses the frontend route guard, the backend will still reject unauthorized access.

## How the GitHub App Relates to User Identity

Systify does not ask users to provide a GitHub personal access token. Instead, it manages repository access through GitHub App installations.

### Installation flow

1. A signed-in user calls `initiateGitHubInstall`.
2. The backend generates a random state plus a GitHub OAuth PKCE verifier / challenge, then stores them in `githubOAuthStates` together with the frontend origin that started the flow.
3. The user is redirected to the GitHub App installation page.
4. After installation, GitHub redirects back to `/api/github/callback` with `installation_id`.
5. The callback treats `installation_id` as untrusted. It validates the Systify state, stores the installation id as pending, and redirects the browser through GitHub user OAuth using the stored PKCE challenge.
6. GitHub redirects back with an OAuth `code`.
7. The backend exchanges the code for a GitHub user access token, then calls GitHub's accessible-installations API to verify that the authenticated GitHub user can see the pending installation id.
8. Only after that user-installation binding check passes does the backend fetch installation details and write the installation into `githubInstallations`.
9. If a stored frontend origin exists, the callback redirects back to it.
10. If GitHub calls back without a usable state, the HTTP endpoint returns an explicit error response instead of guessing a frontend URL.
11. If installation succeeds but no return target is available, the endpoint returns a small success page instead of a misleading server error.

### Threat model: callback ids are not proof of control

The setup callback is a cross-system trust boundary. The browser can arrive with a valid Systify state and a GitHub-provided `installation_id`, but the `installation_id` alone does not prove that the Systify user controls that GitHub installation.

The security invariant is:

- Systify state proves which signed-in Systify owner initiated the flow.
- GitHub user OAuth proves which GitHub user is currently authorizing the callback.
- GitHub's accessible-installations API proves whether that GitHub user can access the installation id.
- `saveInstallation` still enforces the local invariant that one current installation id cannot be bound to a different current owner. Current means `active` or `suspended`.

This prevents cross-tenant installation binding: a user who knows another installation id cannot attach it to their Systify account unless GitHub also says their authenticated GitHub user can access that installation.

### Why `githubOAuthStates` exists

This table exists for callback CSRF protection rather than long-term business data. It stores:

- `state`
- `ownerTokenIdentifier`
- `returnTo`
- `githubCodeVerifier`
- `githubCodeChallenge`
- `pendingInstallationId`
- `githubUserAuthorizationStartedAt`
- `expiresAt`
- `consumed`

Only after the state is successfully validated does the system know which signed-in Systify user initiated the flow. The installation is still not trusted until the GitHub user-token verification step confirms that the GitHub user can access the pending installation.

### Installation state synchronization

GitHub webhooks synchronize installation state back into Convex, including:

- `deleted`
- `suspend`
- `unsuspend`

Other actions on the `installation` event (notably `update`, where a user changes the GitHub App's repository selection without uninstalling) are intentionally ignored by the webhook receiver — the handler still returns `200 OK` so GitHub does not retry, but no mutation runs. Repository selection is re-read on demand from the GitHub API the next time the frontend or backend needs it.

As a result, `githubInstallations` is not just a callback record. It is the local projection of GitHub installation lifecycle state. `active` is current and usable, `suspended` is current but unusable, and `deleted` is historical.

Webhook transitions never create a new authorization proof. A suspended row can become active through an unambiguous signed `unsuspend` webhook because it is still the same current owner binding. A deleted row cannot be revived by webhook; the only path back to a usable binding is the fresh OAuth-verified installation flow that proves the Systify owner and GitHub user can access the installation before `saveInstallation` writes `active`.

## Repository Access Control

### Check the GitHub installation before import

Before creating an import or sync, the system first checks whether the current signed-in user has an active installation. If not, the request is rejected immediately.

### Check repository access again inside the import flow

Even if the user has already connected GitHub, the import flow still calls the GitHub API again before fetching the repository snapshot to confirm:

- whether the installation can access the target repository
- whether the repository is actually public or private

This check fails fast (one API round trip) when the repository is not actually accessible, so an unreachable repo never gets as far as the tree / blob fetches. The same probe is reused by the on-demand sandbox path (`ensureSandboxReady`) before any sandbox-grounded reply or System Design generation provisions a Daytona sandbox, so a user who lost access to a repository between import and sandbox activation gets the same actionable error without burning sandbox cost.

## Sandbox grounding (per-message in Discuss)

Sandbox grounding is the per-message Discuss toggle that lets a single reply read files out of a Daytona sandbox. Availability is driven more by sandbox state than by auth, but turning the toggle on for a message still requires all of the following preconditions to hold:

- being signed in (`requireViewerIdentity` on the send path)
- passing the repository ownership check (`ownerTokenIdentifier` matches `identity.tokenIdentifier`)
- `ensureSandboxReady` succeeding for that repository — the on-demand sandbox path reconfirms GitHub installation access, then provisions or resumes a Daytona sandbox before the reply runs

So sandbox grounding is constrained by both auth and runtime resource boundaries, and the toggle is the only thing in Discuss mode that pulls in a sandbox — Library mode never provisions one.

## Environment Variable Split

### Frontend env

These values are exposed to the browser:

- `VITE_CONVEX_URL`
- `VITE_WORKOS_CLIENT_ID`

### Convex runtime env

These values must exist only in the Convex runtime. This list intentionally matches `integrations/integrations-and-operations.md`:

- `WORKOS_CLIENT_ID`
- `GITHUB_APP_ID`
- `GITHUB_APP_CLIENT_ID`
- `GITHUB_APP_CLIENT_SECRET`
- `GITHUB_APP_SLUG`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_APP_WEBHOOK_SECRET`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `DAYTONA_API_KEY`
- `DAYTONA_API_URL`
- `DAYTONA_TARGET`
- `DAYTONA_AUTO_STOP_MINUTES`
- `DAYTONA_AUTO_ARCHIVE_MINUTES`
- `DAYTONA_AUTO_DELETE_MINUTES`
- `DAYTONA_CPU_LIMIT`
- `DAYTONA_MEMORY_GIB`
- `DAYTONA_DISK_GIB`
- `DAYTONA_POST_CLONE_BLOCK_NETWORK`

This separation matters because the GitHub App private key, OAuth client secret, webhook secret, and OpenAI key must never leak into the frontend.

## Known Limitations

- Auth errors are currently handled mostly through a UI banner plus a refresh prompt, so recovery behavior is still basic.
- The relationship between users and GitHub installations is currently a single-layer owner-scoped model and has not yet expanded to a team or organization level.
- GitHub authorization depends heavily on correct installation-state synchronization, so webhook issues can temporarily leave local data behind the real GitHub state.
