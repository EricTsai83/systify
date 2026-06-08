# GitHub App Integration System Design

## Purpose

This document explains how Systify communicates with GitHub through its GitHub App, how a GitHub installation becomes trusted for a signed-in Systify owner, and how repository access is checked before import, sync, and sandbox-backed features.

The design covers the current implementation in:

- `convex/githubAppNode.ts`
- `convex/github.ts`
- `convex/http.ts`
- `convex/githubRepoFetcher.ts`
- `convex/importsNode.ts`
- `src/components/import-repo-dialog.tsx`

## Scope

The GitHub App integration owns:

- installing or reconnecting the GitHub App
- proving that a Systify owner controls the installation GitHub returned
- storing a local installation projection in Convex
- minting installation access tokens
- listing and searching repositories visible to the installation
- verifying repository access before import, sync, sandbox activation, or System Design generation
- fetching repository metadata and selected file contents through the GitHub API
- receiving installation lifecycle webhooks

It does not own:

- WorkOS sign-in
- Daytona sandbox lifecycle
- LLM generation
- repository knowledge persistence after the GitHub snapshot has been fetched

## High-Level Boundary

```mermaid
flowchart TD
  User[Signed-in user]
  Frontend[React frontend]
  ConvexPublic[Convex public queries and actions]
  ConvexHttp[Convex HTTP routes]
  ConvexInternal[Convex internal mutations and actions]
  DB[(Convex DB)]
  GitHubInstall[GitHub App installation UI]
  GitHubOAuth[GitHub user OAuth]
  GitHubAPI[GitHub REST API]
  GitHubWebhook[GitHub webhook delivery]

  User --> Frontend
  Frontend --> ConvexPublic
  Frontend --> GitHubInstall
  GitHubInstall --> ConvexHttp
  ConvexHttp --> GitHubOAuth
  GitHubOAuth --> ConvexHttp
  ConvexPublic --> ConvexInternal
  ConvexHttp --> ConvexInternal
  ConvexInternal --> DB
  ConvexInternal --> GitHubAPI
  GitHubWebhook --> ConvexHttp
  ConvexHttp --> DB
```

The important security shape is that the browser can carry GitHub callback parameters, but those parameters do not become trusted owner-scoped state until Convex validates them against Systify state and GitHub APIs.

## Runtime Components

```mermaid
flowchart LR
  subgraph Frontend
    ImportDialog[ImportRepoDialog]
  end

  subgraph Convex V8
    GithubTs[convex/github.ts]
    HttpTs[convex/http.ts]
    ImportsTs[convex/imports.ts]
    SystemDesignTs[convex/systemDesign.ts]
  end

  subgraph Convex Node
    GithubAppNode[convex/githubAppNode.ts]
    ImportsNode[convex/importsNode.ts]
    RepoFetcher[convex/githubRepoFetcher.ts]
    SandboxLiveness[convex/lib/sandboxLiveness.ts]
  end

  subgraph GitHub
    InstallUI[App installation pages]
    OAuthEndpoint[login/oauth endpoints]
    Api[REST API]
    Webhooks[Installation webhooks]
  end

  ImportDialog --> GithubAppNode
  ImportDialog --> GithubTs
  InstallUI --> HttpTs
  OAuthEndpoint --> HttpTs
  HttpTs --> GithubTs
  HttpTs --> GithubAppNode
  Webhooks --> HttpTs
  ImportsTs --> ImportsNode
  ImportsNode --> GithubAppNode
  ImportsNode --> RepoFetcher
  RepoFetcher --> Api
  SystemDesignTs --> SandboxLiveness
  SandboxLiveness --> GithubAppNode
```

The split is intentional:

- HTTP ingress stays in `convex/http.ts`.
- persistent installation and OAuth-state rows stay in `convex/github.ts`.
- GitHub network calls that need Node runtime APIs stay in `convex/githubAppNode.ts` and `convex/githubRepoFetcher.ts`.
- import orchestration stays in `convex/importsNode.ts`.

## Data Model

```mermaid
erDiagram
  githubOAuthStates {
    string state
    string ownerTokenIdentifier
    string returnTo
    string githubCodeVerifier
    string githubCodeChallenge
    number pendingInstallationId
    number githubUserAuthorizationStartedAt
    number createdAt
    number expiresAt
    boolean consumed
  }

  githubInstallations {
    string ownerTokenIdentifier
    number installationId
    string accountLogin
    string accountType
    string status
    string repositorySelection
    number connectedAt
    number suspendedAt
    number deletedAt
  }

  repositories {
    string ownerTokenIdentifier
    string owner
    string name
    string visibility
    string latestImportId
    string latestSandboxId
    string lastSyncedCommitSha
  }

  imports {
    string ownerTokenIdentifier
    string repositoryId
    string status
    string commitSha
  }

  githubOAuthStates ||--o| githubInstallations : "causes after verification"
  githubInstallations ||--o{ repositories : "authorizes access for owner"
  repositories ||--o{ imports : "records snapshots"
```

`githubOAuthStates` is a one-shot flow-control table. It is not long-term business data. It binds a GitHub callback to the Systify owner that started the install flow and carries the PKCE verifier needed for the GitHub user authorization step.

`githubInstallations` is Systify's local projection of GitHub installation state. It is useful for fast owner-scoped decisions, but the GitHub API remains the authority for current repository selection.

## End-to-End Install And Trust Flow

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant FE as Frontend
  participant A as initiateGitHubInstall
  participant DB as Convex DB
  participant GHInstall as GitHub install UI
  participant HTTP as /api/github/callback
  participant GHOAuth as GitHub OAuth
  participant GHAPI as GitHub API
  participant Save as saveInstallation

  U->>FE: Click Install GitHub App
  FE->>A: action with returnTo
  A->>A: requireViewerIdentity
  A->>A: consumeGitHubInstallInitiation rate limit
  A->>A: create state, PKCE verifier, PKCE challenge
  A->>DB: insert githubOAuthStates
  A-->>FE: https://github.com/apps/{slug}/installations/new?state=...
  FE->>GHInstall: Open popup or redirect
  GHInstall->>HTTP: GET callback with installation_id and state
  HTTP->>DB: prepareInstallationUserAuthorization
  DB-->>HTTP: returnTo and PKCE challenge
  HTTP-->>GHOAuth: 302 authorize with client_id, state, redirect_uri, code_challenge
  GHOAuth->>HTTP: GET callback with code and state
  HTTP->>DB: consumeOAuthStateForInstallationVerification
  DB-->>HTTP: ownerTokenIdentifier, installationId, codeVerifier
  HTTP->>GHAPI: exchange code for GitHub user token
  HTTP->>GHAPI: GET /user/installations
  GHAPI-->>HTTP: installations visible to GitHub user
  HTTP->>GHAPI: fetch installation details as GitHub App
  GHAPI-->>HTTP: account login, type, repository selection
  HTTP->>Save: saveInstallation for owner
  Save->>DB: insert or refresh githubInstallations
  Save-->>HTTP: connected or conflict
  HTTP-->>FE: callback success, popup close, or redirect with status params
```

### Why There Are Two GitHub Round Trips

The installation callback and the user OAuth callback answer different questions:

```mermaid
flowchart TD
  Callback[GitHub setup callback]
  InstallationId[installation_id]
  QuestionA{Does this id prove owner control?}
  OAuth[GitHub user OAuth with PKCE]
  UserToken[GitHub user access token]
  AccessibleInstallations[GET /user/installations]
  QuestionB{Can the GitHub user access this installation?}
  Save[Save installation for Systify owner]
  Reject[Reject callback]

  Callback --> InstallationId
  InstallationId --> QuestionA
  QuestionA -->|No| OAuth
  OAuth --> UserToken
  UserToken --> AccessibleInstallations
  AccessibleInstallations --> QuestionB
  QuestionB -->|Yes| Save
  QuestionB -->|No| Reject
```

`installation_id` crosses through the browser and is treated as untrusted. The callback is only allowed to persist the installation after GitHub confirms that the OAuth-authenticated GitHub user can see that installation.

## Callback State Machine

```mermaid
stateDiagram-v2
  [*] --> StateCreated: initiateGitHubInstall
  StateCreated --> PendingInstallation: callback has installation_id and state
  PendingInstallation --> GitHubUserAuthorization: redirect to GitHub OAuth
  GitHubUserAuthorization --> Verified: callback has code and state, user can access installation
  GitHubUserAuthorization --> Unauthorized: user denied OAuth or cannot access installation
  Verified --> Connected: saveInstallation connected
  Verified --> Conflict: owner or installation already bound differently
  StateCreated --> Invalid: missing, expired, or consumed state
  PendingInstallation --> Invalid: mismatched installation_id
  Connected --> [*]
  Conflict --> [*]
  Unauthorized --> [*]
  Invalid --> [*]
```

The state row expires after 10 minutes and is consumed once. A scheduled cleanup removes expired OAuth states in batches.

## Callback Branches

```mermaid
flowchart TD
  Start[GET /api/github/callback]
  HasError{error and state?}
  HasCode{code and state?}
  HasInstallation{installation_id present?}
  ValidInstallation{installation_id valid positive safe integer?}
  UpdateNoState{setup_action update and no state?}
  HasState{state present?}
  Prepare[prepareInstallationUserAuthorization]
  RedirectOAuth[302 GitHub user OAuth]
  Consume[consumeOAuthStateForInstallationVerification]
  VerifyUser[verifyInstallationAccessWithGitHubUser]
  Details[fetchInstallationDetails]
  Save[saveInstallation]
  Success[callbackSuccess]
  Error[callbackError]
  PermissionsUpdated[callbackPermissionsUpdated]

  Start --> HasError
  HasError -->|Yes| Error
  HasError -->|No| HasCode
  HasCode -->|Yes| Consume
  Consume --> VerifyUser
  VerifyUser -->|unauthorized| Error
  VerifyUser -->|verified| Details
  Details --> Save
  Save -->|connected| Success
  Save -->|conflict| Error
  HasCode -->|No| HasInstallation
  HasInstallation -->|No| Error
  HasInstallation -->|Yes| ValidInstallation
  ValidInstallation -->|No| Error
  ValidInstallation -->|Yes| UpdateNoState
  UpdateNoState -->|Yes| PermissionsUpdated
  UpdateNoState -->|No| HasState
  HasState -->|No| Error
  HasState -->|Yes| Prepare
  Prepare --> RedirectOAuth
```

The update branch is intentionally read-only. GitHub can redirect back after the user adjusts repository permissions without a Systify state. Because that callback is unauthenticated, Systify does not mutate local installation rows in that branch. The frontend refreshes repository visibility by calling GitHub-backed actions again.

## Installation Conflict Rules

```mermaid
flowchart TD
  Save[saveInstallation]
  SameInstallationRows[Load current rows by installationId]
  ForeignCurrent{Active or suspended row belongs to another owner?}
  OwnerCurrentRows[Load owner active and suspended rows]
  OtherOwnerInstallation{Owner already has another current installation?}
  SameOwnedRow{Owner has same active, suspended, or deleted installation?}
  Patch[Patch existing row active and fresh details]
  Insert[Insert new active installation row]
  Conflict[Return conflict]
  Connected[Return connected]

  Save --> SameInstallationRows
  SameInstallationRows --> ForeignCurrent
  ForeignCurrent -->|Yes| Conflict
  ForeignCurrent -->|No| OwnerCurrentRows
  OwnerCurrentRows --> OtherOwnerInstallation
  OtherOwnerInstallation -->|Yes| Conflict
  OtherOwnerInstallation -->|No| SameOwnedRow
  SameOwnedRow -->|Yes| Patch
  SameOwnedRow -->|No| Insert
  Patch --> Connected
  Insert --> Connected
```

The product invariant is one current GitHub installation per Systify owner, where current means `active` or `suspended`. A second different current installation is a conflict, not an implicit replacement. A foreign `active` or `suspended` row also conflicts. A foreign `deleted` row is historical and is never patched or revived by another owner's OAuth flow.

## Installation Lifecycle

```mermaid
stateDiagram-v2
  [*] --> Active: fresh OAuth verified
  Active --> Suspended: signed webhook suspend
  Suspended --> Active: signed webhook unsuspend
  Active --> Deleted: disconnect or deleted webhook
  Suspended --> Deleted: disconnect or deleted webhook
  Deleted --> Active: fresh OAuth verified only
```

`deleted` is terminal for webhook processing. Signed webhooks may project provider lifecycle changes for current rows, but they do not establish a new owner authorization proof. A deleted row can become usable again only when the same owner completes the fresh OAuth-verified installation flow and `saveInstallation` updates that owner-scoped row.

## Repository Discovery Flow

```mermaid
sequenceDiagram
  autonumber
  participant FE as ImportRepoDialog
  participant A as GitHub action
  participant RL as Rate limit mutation
  participant DB as Convex DB
  participant Auth as GitHub App auth
  participant GH as GitHub API

  FE->>A: listInstallationRepos or searchGitHubRepos
  A->>A: requireViewerIdentity
  A->>RL: consume repo-list or repo-search bucket
  A->>DB: getInstallationIdForOwner
  alt no active installation
    A-->>FE: empty result set
  else active installation
    A->>Auth: getInstallationAccessToken
    Auth-->>A: installation token
    alt list installed repos
      A->>GH: GET /installation/repositories
      GH-->>A: repository pages
    else search repositories
      A->>GH: GET /search/repositories
      GH-->>A: public plus installation-visible results
    end
    A-->>FE: normalized repo summaries
  end
```

Repository listing is page-limited so a signed-in user cannot force Systify to walk an unbounded GitHub pagination chain. Search input is trimmed, minimum-length checked, maximum-length checked, and server-side rate-limited before reaching GitHub.

## Repository Access Check Flow

```mermaid
flowchart TD
  Caller[Frontend, import pipeline, or sandbox liveness]
  Identity[Resolve Systify owner]
  Installation[Get active installationId for owner]
  Token[Mint GitHub installation token]
  RepoProbe[GET /repos/{owner}/{repo}]
  Accessible{HTTP 200?}
  Denied{HTTP 403 or 404?}
  OtherError{Other GitHub error?}
  Allow[Return accessible with visibility and default branch]
  FixSelection[Return actionable repo-selection error]
  ApiError[Return GitHub API error]

  Caller --> Identity
  Identity --> Installation
  Installation -->|missing| FixSelection
  Installation --> Token
  Token --> RepoProbe
  RepoProbe --> Accessible
  Accessible -->|Yes| Allow
  Accessible -->|No| Denied
  Denied -->|Yes| FixSelection
  Denied -->|No| OtherError
  OtherError --> ApiError
```

This probe is used in two forms:

- `verifyRepoAccess` is a public action for early UI feedback before import records are created.
- `checkRepoAccess` is an internal action used by import and sandbox-backed flows before they spend more resources.

The same GitHub probe protects import, sync, sandbox-grounded Discuss, and System Design generation. Losing GitHub access after import does not grant later sandbox-backed access.

## Import And Sync GitHub API Flow

```mermaid
sequenceDiagram
  autonumber
  participant User as User
  participant FE as Frontend
  participant Mut as createRepositoryImport or syncRepository
  participant Intake as repositoryImportWorkflow
  participant DB as Convex DB
  participant Job as importsNode.runImportPipeline
  participant App as githubAppNode
  participant Fetcher as githubRepoFetcher
  participant GH as GitHub REST API
  participant Persist as import persistence mutations

  User->>FE: Submit GitHub repo URL
  FE->>App: verifyRepoAccess
  App->>GH: GET /repos/{owner}/{repo} with installation token
  GH-->>App: accessible or denied
  FE->>Mut: create import or sync
  Mut->>Intake: start import intake
  Intake->>DB: create or restore repository/default thread as needed; create job and import records
  Intake->>DB: schedule runImportPipeline
  Job->>DB: load owner installation
  Job->>App: checkRepoAccess
  App->>GH: GET /repos/{owner}/{repo}
  GH-->>App: metadata and access result
  Job->>Fetcher: fetchRepositorySnapshot
  Fetcher->>GH: GET /repos/{owner}/{repo}
  Fetcher->>GH: GET /repos/{owner}/{repo}/commits/{branch}
  Fetcher->>GH: GET /repos/{owner}/{repo}/git/trees/{treeSha}?recursive=1
  Fetcher->>GH: GET /repos/{owner}/{repo}/git/blobs/{sha}
  Fetcher-->>Job: bounded repository snapshot
  Job->>Persist: write files, chunks, summaries, and import metadata in batches
  Persist->>DB: finalize latest import pointer
```

Import and sync are GitHub-API-only. They do not clone the repository, provision Daytona, or patch `repositories.latestSandboxId`.

## Snapshot Fetch Shape

```mermaid
flowchart TD
  Start[fetchRepositorySnapshot]
  Repo[GET repository metadata]
  Commit[GET branch commit]
  Tree[GET recursive git tree]
  Select[Select README, manifests, and important files]
  BlobFanout[Fetch selected blobs in bounded parallelism]
  Retry[Retry 429 and 5xx with backoff and Retry-After]
  Degrade[Drop missing or oversized blob content]
  Snapshot[Return snapshot compatible with indexing pipeline]

  Start --> Repo
  Repo --> Commit
  Commit --> Tree
  Tree --> Select
  Select --> BlobFanout
  BlobFanout --> Retry
  Retry --> Degrade
  Degrade --> Snapshot
```

The tree request supplies file paths, file types, sizes, and blob SHAs. Blob fetches are intentionally limited to the README, package manifests, and a small set of heuristic important files so the import pipeline avoids cloning or reading an entire monorepo into Convex actions.

## Installation Token Flow

```mermaid
flowchart TD
  Caller[GitHub API caller]
  Owner[ownerTokenIdentifier]
  Lookup[getInstallationIdForOwner]
  HasInstallation{Active installation exists?}
  Jwt[create GitHub App JWT]
  TokenReq[POST /app/installations/{installationId}/access_tokens]
  Token[Installation access token]
  Null[Return null or fail with connect GitHub message]
  GitHubCall[Call GitHub API with installation token]

  Caller --> Owner
  Owner --> Lookup
  Lookup --> HasInstallation
  HasInstallation -->|No| Null
  HasInstallation -->|Yes| Jwt
  Jwt --> TokenReq
  TokenReq --> Token
  Token --> GitHubCall
```

Installation tokens are short-lived GitHub App tokens. They are used instead of personal access tokens and are scoped by the user's GitHub App repository selection.

## Webhook Flow

```mermaid
sequenceDiagram
  autonumber
  participant GH as GitHub
  participant HTTP as /api/github/webhook
  participant Crypto as Web Crypto HMAC
  participant DB as Convex DB

  GH->>HTTP: POST installation event with raw body and X-Hub-Signature-256
  HTTP->>HTTP: enforce max body size
  HTTP->>Crypto: compute HMAC-SHA256 with GITHUB_APP_WEBHOOK_SECRET
  Crypto-->>HTTP: computed sha256 signature
  HTTP->>HTTP: constant-time compare signature
  alt invalid signature
    HTTP-->>GH: 401
  else valid signature
    HTTP->>HTTP: parse JSON and X-GitHub-Event
    alt installation.deleted
      HTTP->>DB: markInstallationDeleted
    else installation.suspend
      HTTP->>DB: markInstallationSuspended
    else installation.unsuspend
      HTTP->>DB: markInstallationActive
    else other action
      HTTP->>HTTP: ignore but acknowledge
    end
    HTTP-->>GH: 200 OK
  end
```

The webhook receiver treats installation lifecycle events as provider-state projection only. It does not try to mirror every repository-selection update into Convex. Repository selection is re-read on demand from GitHub when the UI lists repositories or when access is checked.

Lifecycle transitions are intentionally narrow:

- `suspend` only changes `active` rows to `suspended`.
- `unsuspend` only changes unambiguous `suspended` rows to `active`.
- `deleted` only changes `active` or `suspended` rows to `deleted`.
- `deleted` rows are terminal for webhooks and never become `active` from `unsuspend`.

If an `unsuspend` webhook maps to more than one current owner for the same installation id, Systify logs the ambiguity and leaves all rows unchanged. The system fails closed because a webhook proves provider lifecycle, not which Systify owner should receive a usable binding.

## Trust Boundaries

```mermaid
flowchart TD
  Browser[Browser and callback URL params]
  State[state in githubOAuthStates]
  PKCE[PKCE verifier and challenge]
  GitHubUser[GitHub user OAuth token]
  GitHubInstallations[GitHub accessible-installations API]
  WebhookPayload[GitHub webhook raw body]
  WebhookSignature[X-Hub-Signature-256]
  InstallationToken[GitHub installation token]
  OwnerData[Owner-scoped Convex data]

  Browser -->|untrusted installation_id| State
  State -->|binds to Systify owner| PKCE
  PKCE --> GitHubUser
  GitHubUser --> GitHubInstallations
  GitHubInstallations -->|verified installation access| OwnerData
  WebhookPayload -->|untrusted body| WebhookSignature
  WebhookSignature -->|HMAC verified| OwnerData
  InstallationToken -->|scoped by GitHub installation| OwnerData
```

The core rules are:

- frontend-provided user ids are never used for authorization
- `ctx.auth.getUserIdentity()` is the source of the Systify owner
- `installation_id` is not proof of control
- callback state must be one-time, unexpired, and owner-bound
- GitHub user OAuth plus accessible-installations verifies ownership of the installation returned by GitHub
- webhook payloads must pass HMAC verification before mutating installation state
- repository access is checked against GitHub before expensive work starts

## Failure Handling

```mermaid
flowchart TD
  Failure[GitHub integration failure]
  MissingEnv{Missing required env?}
  BadState{Invalid, expired, or consumed state?}
  UserDenied{User denied GitHub OAuth?}
  UnauthorizedInstall{GitHub user cannot access installation?}
  Conflict{Installation conflicts with local invariant?}
  RepoDenied{Repo not in installation selection?}
  RateLimited{Systify or GitHub rate limited?}
  WebhookBad{Webhook bad signature or body?}
  ServerError{Unexpected error?}

  Failure --> MissingEnv
  Failure --> BadState
  Failure --> UserDenied
  Failure --> UnauthorizedInstall
  Failure --> Conflict
  Failure --> RepoDenied
  Failure --> RateLimited
  Failure --> WebhookBad
  Failure --> ServerError

  MissingEnv --> OperatorFix[Operator config fix]
  BadState --> RestartFlow[Ask user to restart GitHub connection]
  UserDenied --> ExplicitCallbackError[Return explicit callback error]
  UnauthorizedInstall --> ExplicitCallbackError
  Conflict --> AlreadyConnected[Return github_error already_connected]
  RepoDenied --> AdjustPermissions[Ask user to adjust GitHub App permissions]
  RateLimited --> RetryLater[Fail fast or retry where implemented]
  WebhookBad --> RejectWebhook[Return 400, 401, or 413]
  ServerError --> ErrorId[Return opaque error id and log details]
```

Callback responses are explicit status pages or redirects with explicit query parameters. The system does not guess a frontend target when state or return targets are missing.

## Environment Variables

```mermaid
flowchart LR
  subgraph GitHub App Runtime Env
    AppId[GITHUB_APP_ID]
    Slug[GITHUB_APP_SLUG]
    ClientId[GITHUB_APP_CLIENT_ID]
    ClientSecret[GITHUB_APP_CLIENT_SECRET]
    PrivateKey[GITHUB_APP_PRIVATE_KEY]
    WebhookSecret[GITHUB_APP_WEBHOOK_SECRET]
  end

  AppId --> Jwt[App JWT and installation-token requests]
  PrivateKey --> Jwt
  Slug --> InstallUrl[Install URL construction]
  ClientId --> UserOAuth[GitHub user OAuth authorization and code exchange]
  ClientSecret --> UserOAuth
  WebhookSecret --> WebhookVerify[Webhook HMAC verification]
```

`GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET` are required because Systify uses GitHub App user OAuth to verify that the GitHub user can access the installation id returned by the setup callback.

## Operational Invariants

- A Systify owner can have at most one current GitHub App installation, where current means `active` or `suspended`.
- A current installation id cannot be silently rebound to a different current owner.
- Callback `installation_id` is untrusted until verified by GitHub user OAuth and accessible-installations.
- Installation lifecycle webhooks update local status but do not create authorization proof or replace on-demand GitHub access checks.
- Deleted installation rows are webhook-terminal and can become usable only through a fresh OAuth-verified save for that owner.
- Import and sync read GitHub directly and never provision Daytona sandboxes.
- Sandbox-backed flows still re-check GitHub access before provisioning or using a sandbox.
- GitHub network-heavy paths consume server-side rate-limit buckets before calling GitHub.
- Expired OAuth state rows are cleanup data, not domain state.

## Related Documents

- `core/auth-and-access.md`
- `integrations/integrations-and-operations.md`
- `github-callback-returnto-allowlist-system-design.md`
- `repository/repository-lifecycle.md`
- `repository-remote-freshness-check-system-design.md`
- `sandbox-mode-security-system-design.md`
