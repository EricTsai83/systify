# Systify

Every answer points to its source.

Systify is an open source repository analysis app for understanding unfamiliar codebases through grounded, repository-specific context. A user signs in with WorkOS, connects a GitHub App installation, imports a repository's metadata, README, and key files directly through the GitHub API into Convex, and then explores it through two AI surfaces. Daytona sandboxes are provisioned lazily — only when the user sends a Discuss-mode Sandbox-grounded message or generates Design Docs — so the rest of the app works without ever paying sandbox cost:

- **Chat** with two top-level modes:
  - `discuss` (UI label "Discuss") — free-form chat with two independent per-message grounding toggles the composer surfaces:
    - **Library** grounds the reply in your design artifacts (architecture overviews, diagrams, deep analyses) with `[A#]` citations.
    - **Sandbox** grounds the reply in the live sandbox source tree with `[path:line]` citations and read-only tool calls.
    - Both off → training-only chat; both on → combined citation contract.
  - `library` (UI label "Library") — artifact reader with the always-visible Ask panel for artifact-grounded questions.
- **Design Docs**: optional templates that generate reusable docs (README summary, architecture / data model / API / deployment / security / operations overviews) in the Library. Users can generate only the docs that are useful for the repository, and later chat replies can cite the generated docs.

The app uses a React frontend and a Convex backend. Convex owns the database, backend functions, background jobs, cron work, and HTTP endpoints, so there is no separate Express or Nest server in this repo.

## Status

Systify is an early-access project. Repository import, chat, artifact generation, sync, and sandbox lifecycle flows are implemented. Sandbox reliability and Daytona webhook reconciliation are still active areas of iteration.

This repository is standardized on Bun for package management and script execution.

## What Systify does

- Import GitHub repositories through a GitHub App instead of personal access tokens
- Index repository structure, files, chunks, summaries, and reusable analysis artifacts
- Answer architecture, data-flow, and risk-oriented questions from grounded repository data
- Generate optional Design Docs with sandbox-backed live validation when indexed data needs deeper analysis
- Persist threads, messages, jobs, and artifacts for later review
- Sync imported repositories against newer upstream commits
- Reconcile sandbox lifecycle through request-path cleanup, webhooks, and cron sweeps

## End-to-end flow

1. The user signs in with WorkOS AuthKit.
2. The user connects a GitHub App installation.
3. Systify verifies repository access and creates an import workflow.
4. The import pipeline scans the repository via the GitHub API and writes files, chunks, summaries, and artifacts into Convex.
5. The user explores the repository through chat (top-level `discuss` and `library` modes; `discuss` exposes per-message **Library** and **Sandbox** grounding toggles in the composer) or by generating optional Design Docs from the Library.
6. When the user sends a **Sandbox**-grounded `discuss` message or generates Design Docs that need live validation, a Daytona sandbox is provisioned on-demand and the repository is cloned.
7. Later syncs refresh the active snapshot without mixing old and new import data.

## Stack

### Frontend

- React 19
- Vite 7
- React Router 7
- Tailwind CSS 4
- shadcn/ui and Radix primitives

### Backend

- Convex queries, mutations, actions, internal actions, HTTP actions, and cron jobs
- Convex as the database, backend runtime, scheduler, and integration entrypoint

### External services

- WorkOS AuthKit for browser-side sign-in
- GitHub App for repository authorization and installation lifecycle
- Daytona for repository sandboxes and deep inspection
- OpenAI and Anthropic for model-backed chat generation, with a heuristic fallback when no provider API key is configured

## Repository layout

```text
.
├── src/        # React app, routing, layout, and UI
├── convex/     # Convex schema, backend functions, HTTP endpoints, and crons
├── docs/       # System design and architecture documentation
├── public/     # Static assets
└── .env.example
```

## Prerequisites

Before running Systify locally, make sure you have:

- Bun 1.3+
- A Convex deployment
- A WorkOS application
- A GitHub App with installation access to the repositories you want to import
- A Daytona account and API key
- An OpenAI API key for the default model-backed chat path; optionally an Anthropic API key for Claude models

## Local development

### 1. Install dependencies

```bash
bun install
```

### 2. Configure frontend variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

The frontend reads these browser-exposed values from `.env`:

- `VITE_CONVEX_URL`
- `VITE_WORKOS_CLIENT_ID`

`env.ts` validates them at build time. In local development, `npx convex dev` will usually write `VITE_CONVEX_URL` for you automatically.

### 3. Configure Convex runtime variables

Backend secrets should not live only in `.env`. Set them in the Convex environment with `npx convex env set` or through the Convex dashboard.

Common runtime variables:

- WorkOS
  - `WORKOS_CLIENT_ID`
- GitHub App
  - `GITHUB_APP_ID`
  - `GITHUB_APP_SLUG`
  - `GITHUB_APP_PRIVATE_KEY`
  - `GITHUB_APP_WEBHOOK_SECRET`
- LLM providers
  - `OPENAI_API_KEY`
  - `ANTHROPIC_API_KEY`
- Daytona
  - `DAYTONA_API_KEY`
  - `DAYTONA_API_URL`
  - `DAYTONA_TARGET`
  - `DAYTONA_WEBHOOK_SIGNING_SECRET`
  - `DAYTONA_WEBHOOK_ORGANIZATION_ID`
  - `DAYTONA_AUTO_STOP_MINUTES`
  - `DAYTONA_AUTO_ARCHIVE_MINUTES`
  - `DAYTONA_AUTO_DELETE_MINUTES`
  - `DAYTONA_CPU_LIMIT`
  - `DAYTONA_MEMORY_GIB`
  - `DAYTONA_DISK_GIB`
  - `DAYTONA_POST_CLONE_BLOCK_NETWORK`

Optional rate-limit and lease overrides are also supported:

- `RATE_LIMIT_IMPORT_PER_HOUR`
- `RATE_LIMIT_SYSTEM_DESIGN_PER_HOUR`
- `RATE_LIMIT_CHAT_PER_MINUTE`
- `RATE_LIMIT_CHAT_BURST_CAPACITY`
- `RATE_LIMIT_GLOBAL_CHAT_PER_MINUTE`
- `RATE_LIMIT_GLOBAL_CHAT_BURST_CAPACITY`
- `RATE_LIMIT_DAYTONA_GLOBAL_PER_HOUR`
- `CHAT_JOB_LEASE_MS`
- `SYSTEM_DESIGN_JOB_LEASE_MS`

The fully annotated example lives in `.env.example`.

### 4. Start the app

```bash
bun run dev
```

This starts both app runtimes:

- `vite --open`
- `npx convex dev`

The `predev` hook waits for `npx convex dev` to become ready and opens the Convex dashboard.

## Important local URLs and callbacks

When wiring external services, these are the main endpoints:

- App URL: usually `http://localhost:5173`
- WorkOS redirect URI: `http://localhost:5173/callback`
- GitHub App callback: `https://<your-convex-site>/api/github/callback`
- GitHub App webhook: `https://<your-convex-site>/api/github/webhook`
- Daytona webhook: `https://<your-convex-site>/api/daytona/webhook`

For GitHub App installation, the frontend sends its current origin when the install flow starts. The Convex callback stores that origin in OAuth state and redirects back to it after installation when possible. If GitHub calls back without a usable state, the endpoint returns an explicit error instead of guessing a frontend URL. If the installation succeeds but no return target is available, the endpoint renders a small success page telling the user to return to Systify manually.

For Daytona, configure Svix signing on the webhook endpoint and store the signing secret in `DAYTONA_WEBHOOK_SIGNING_SECRET`. `DAYTONA_WEBHOOK_ORGANIZATION_ID` can be used as an additional allowlist check.

### Daytona webhook endpoint in local vs production

Daytona should always call Convex directly, not the frontend server:

- local development deployment:
  - `https://<your-local-convex-site>/api/daytona/webhook`
- production deployment:
  - `https://<your-production-convex-site>/api/daytona/webhook`

Recommended setup:

1. register the correct Convex endpoint URL in Daytona webhook settings
2. subscribe to:
   - `sandbox.created`
   - `sandbox.state.updated`
3. store the endpoint signing secret in Convex env as `DAYTONA_WEBHOOK_SIGNING_SECRET`

## Available scripts

| Command | Description |
| --- | --- |
| `bun run dev` | Run frontend and Convex backend in parallel |
| `bun run dev:frontend` | Start the Vite frontend |
| `bun run dev:backend` | Start `npx convex dev` |
| `bun run build` | Type-check and build the frontend |
| `bun run build:vercel` | Deploy Convex, inject `VITE_CONVEX_URL`, and build for Vercel |
| `bun run typecheck` | Run the app TypeScript build |
| `bun run typecheck:convex` | Type-check Convex code only |
| `bun run lint` | Run type checks and ESLint |
| `bun run test` | Run Vitest |
| `bun run preview` | Preview the production build |
| `bun run format` | Format the repo with Prettier |

## Access and analysis model

- Users sign in through WorkOS AuthKit in the browser.
- The frontend passes the WorkOS access token into Convex.
- Convex validates that token as a custom JWT.
- Repository access is enforced through GitHub App installation state, not personal access tokens.
- Most backend flows derive the current owner from authenticated identity and verify ownership server-side.
- Every import creates a new snapshot-oriented workflow instead of mutating repository knowledge in place.
- Chat reads from indexed repository knowledge stored in Convex; the per-mode contract is: `discuss` defaults to training-only and only consults repo knowledge when a grounding toggle is on — **Library** adds artifact context with `[A#]` citations, **Sandbox** adds live source context with `[path:line]` citations through read-only sandbox tools — while `library` is an artifact reader with an always-visible Ask panel grounded in artifacts.
- Design Docs generation (implemented internally as System Design generation) depends on a usable Daytona sandbox for LLM-backed templates and stores generated docs in the Library, which later chat replies (Library grounding in `discuss`, or the Ask panel in `library`) can then cite.
- Cleanup and reconciliation rely on cron jobs plus webhook-driven convergence so external Daytona resources do not drift too far from Convex state.

## Recommended reading

If you want the broader architecture, start with the system design docs in `docs/`:

1. `docs/core/system-overview.md`
2. `docs/core/domain-and-data-model.md`
3. `docs/core/auth-and-access.md`
4. `docs/repository/repository-lifecycle.md`
5. `docs/chat/chat-and-analysis-pipeline.md`
6. `docs/integrations/integrations-and-operations.md`
7. `docs/sandbox/orphan-resource-handling.md`

The document index lives in `docs/README.md`.

## Deployment model

The deployment model is intentionally simple:

- Frontend: static Vite build
- Backend: Convex cloud
- External services: WorkOS, GitHub, Daytona, and OpenAI
- Hosting and CD: Vercel Git integration running `bun run build:vercel`
- SPA deep links: handled by `vercel.json` rewrites for client routes, without rewriting `/api/*` or file-extension asset requests

There is no separate always-on custom API server in front of the backend.

## License

MIT
