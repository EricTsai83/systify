# systify

## What this codebase does

Systify is a Bun + React + Convex app for importing GitHub repositories
through a GitHub App, storing repository knowledge in Convex, and exploring
it through Discuss chat, Library artifacts, and sandbox-backed System Design
generation. Convex is the backend API, database, scheduler, HTTP endpoint
layer, and cron runtime; there is no separate Express/Nest server. Daytona
sandboxes are provisioned lazily only for Discuss Sandbox grounding or
LLM-backed System Design, not for ordinary repository import.

## Auth shape

- Browser auth comes from WorkOS AuthKit through `ConvexProviderWithAuthKit`;
  Convex validates a WorkOS custom JWT in `auth.config.ts`.
- Backend entry points should derive identity with `requireViewerIdentity(ctx)`
  / `ctx.auth.getUserIdentity()` and use `identity.tokenIdentifier`, not a
  client-supplied user id.
- Owner-scoped tables use `ownerTokenIdentifier`; common gates are
  `requireOwnedDoc`, `loadOwnedDoc`, `assertOwnedBy`, and `isOwnedBy`.
- Repository-scoped flows should use `requireActiveRepositoryForViewer` or
  `loadAccessibleRepositoryForViewer` so archived/deleting repositories are
  handled consistently.
- GitHub access is tied to active `githubInstallations` for the owner; token
  resolution runs through `resolveInstallationTokenForOwner` /
  `getInstallationTokenForOwner`.

## Threat model

Highest impact is cross-user exposure of private repo data through Convex
public functions that load repositories, threads, artifacts, messages, jobs,
or sandbox sessions without an owner gate. GitHub App callback/webhook
mistakes can bind an installation to the wrong owner or leave stale permission
state trusted. Sandbox-backed LLM flows can leak private source, installation
tokens, or hard-coded repo secrets into durable `messages` unless clone
scrubbing, network posture, tool redaction, and audit-log redaction all stay
intact. Resource abuse matters too: imports, chat replies, System Design jobs,
sandbox activation, and Daytona cleanup must preserve rate limits, leases, and
active-job dedup.

## Project-specific patterns to flag

- New public `query`, `mutation`, or `action` that accepts an owner/user token
  from the client, or reads owner-scoped docs without `requireViewerIdentity`
  plus an owner gate.
- Repository/chat/library paths that bypass `requireActiveRepositoryForViewer`,
  `assertRepositoryModeEligible`, or `resolveDiscussGrounding`, especially for
  Library mode and Discuss Sandbox grounding.
- GitHub App flows that skip `githubOAuthStates` consumption,
  `normalizeReturnToUrl`, active-installation lookup, or `verifyRepoAccess` /
  `checkRepoAccess` before importing or provisioning.
- Daytona/LLM tool paths that bypass `ensureSandboxReady`,
  `verifyAndSyncSandbox`, `createSandboxTools`, `resolveSandboxPath`,
  `COMMAND_DENY_LIST`, `redact()`, or `sandboxToolCallLog`.
- Long-running background work that skips `enqueueJob`, `findActiveJob`, lease
  refresh/stale recovery, or `consume*RateLimit` before imports, chat, System
  Design, sandbox activation, or cleanup.

## Known false-positives

- `convex/http.ts` exposes `/api/github/callback`, `/api/github/webhook`, and
  `/api/daytona/webhook` publicly by design; check OAuth state, HMAC, and Svix
  verification rather than WorkOS auth there.
- `convex/daytona.ts` intentionally clones with a GitHub installation token,
  then rewrites `origin` and optionally blocks egress; the risky finding is
  missing or reordered scrub/block logic.
- `convex/chat/sandboxTools.ts` intentionally offers `read_file`, `list_dir`,
  and `run_shell` to the LLM inside Daytona; evaluate repo-root path validation,
  caps, deny list, redaction, and logging.
- `docs/sandbox-mode-security-system-design.md` and redaction tests contain
  fake secret-shaped strings to document and test scrubbing behavior.
- Frontend route guards and WorkOS UI state are UX boundaries; backend Convex
  auth and owner checks are the authoritative security controls.
