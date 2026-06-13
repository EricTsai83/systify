# Plan 001: Upgrade vulnerable runtime dependencies

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report; do not improvise. When done, update the status row for this plan in `plans/README.md` unless a reviewer told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 962761d..HEAD -- package.json bun.lock convex/daytona.ts convex/lib/daytonaRetry.ts src/components/mermaid-diagram.tsx src/router.tsx src/App.tsx`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `962761d`, 2026-06-13

## Why this matters

`bun audit` currently fails with high and critical advisories in packages that are on real runtime paths: `@daytona/sdk` powers sandbox provisioning and tool execution, `react-router-dom` powers all app routing, and `mermaid` renders user-visible diagrams. Leaving these pinned means security review and CI audit checks cannot distinguish stale transitive noise from real risk. This plan upgrades direct runtime dependencies and verifies the app still typechecks, lints, and passes tests.

## Current state

- `package.json` declares the direct dependencies to upgrade:

```json
// package.json:40,56,62
"@daytona/sdk": "0.173.0",
"mermaid": "^11.14.0",
"react-router-dom": "^7.14.1",
```

- `convex/daytona.ts` imports Daytona SDK classes directly. Treat SDK API changes here as in scope:

```ts
// convex/daytona.ts:3
import { CodeLanguage, Daytona, DaytonaError, DaytonaNotFoundError, DaytonaTimeoutError } from "@daytona/sdk";
```

- `src/components/mermaid-diagram.tsx` dynamically imports Mermaid. Rendering behavior must still work after upgrade:

```ts
// src/components/mermaid-diagram.tsx:160
const mermaidModule = await import("mermaid");
```

- React Router is imported across app routing and pages. Do not rewrite routing unless an upgrade requires a targeted API adjustment:

```ts
// src/router.tsx:1
import { createBrowserRouter, createMemoryRouter, useParams, type RouteObject } from "react-router-dom";
```

- `bun audit` at plan time reported 51 vulnerabilities, including high advisories for `react-router`, `axios`, `@grpc/grpc-js`, `protobufjs`, `@opentelemetry/sdk-node`, `esbuild`, and critical `shell-quote`. `axios`, OpenTelemetry, gRPC, protobuf, and shell-quote are pulled through `@daytona/sdk` in `bun.lock`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Current audit | `bun audit` | currently exits nonzero; use output to confirm target advisories |
| Upgrade direct runtime deps | `bun update @daytona/sdk react-router-dom mermaid streamdown` | exits 0 and updates `bun.lock` |
| Typecheck | `bun run typecheck && bun run typecheck:convex` | exits 0, no errors |
| Lint | `bun run lint` | exits 0 |
| Tests | `bun run test` | all tests pass |
| Format | `bun run format` | exits 0; may update formatting |
| Final audit | `bun audit` | no critical/high advisories in reachable runtime deps, or documented remaining advisories with no available patched version |

## Scope

**In scope**:
- `package.json`
- `bun.lock`
- `convex/daytona.ts`
- `convex/lib/daytonaRetry.ts`
- `src/components/mermaid-diagram.tsx`
- `src/router.tsx`
- `src/App.tsx`
- Narrow tests only if required by an upgraded API

**Out of scope**:
- Feature changes to sandbox lifecycle, routing, or diagram UX.
- Replacing Daytona, React Router, Mermaid, or Streamdown.
- Broad dependency modernization unrelated to audit findings.
- Moving `shadcn` between dependency sections; that is plan 002.

## Git workflow

- Branch: `advisor/001-upgrade-vulnerable-runtime-dependencies`
- Commit message style in recent history is imperative, e.g. `Harden model picker defaults and move chat budget checks`. Use the same style.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Capture the exact advisories being targeted

Run `bun audit` and save the important package names in your notes. Confirm the output still includes advisories for at least one of: `@daytona/sdk` transitives, `react-router`, or `mermaid`.

**Verify**: `bun audit` -> nonzero exit with the vulnerable packages listed, unless the repo already drifted and was fixed.

### Step 2: Upgrade the direct runtime packages

Run:

```sh
bun update @daytona/sdk react-router-dom mermaid streamdown
```

`streamdown` is included because it also depends on Mermaid. If Bun refuses a compatible update, inspect the package constraints and update `package.json` manually only for these direct packages, then run `bun install` to refresh `bun.lock`.

**Verify**: `git diff -- package.json bun.lock` -> only dependency version and lockfile resolution changes at this point.

### Step 3: Fix narrow API breakages only

Run typecheck. If the upgraded Daytona SDK, Mermaid, or React Router changed types, make the smallest compatibility edits in the in-scope files. Keep current behavior:

- Daytona sandbox clone, network block, retry, and error classification still work.
- Mermaid diagrams still render through the lazy import path.
- Existing Vite/React Router route creation stays equivalent.

**Verify**: `bun run typecheck && bun run typecheck:convex` -> exit 0.

### Step 4: Run the full verification gate

Run the required project checks.

**Verify**:

```sh
bun run format
bun run lint
bun run test
```

Expected: all exit 0. Tests may still print existing JSDOM warnings, but there must be no failed tests.

### Step 5: Re-run dependency audit

Run `bun audit`. If critical/high advisories remain, determine whether they are still reachable through direct runtime dependencies and whether a patched version exists.

**Verify**: `bun audit` -> either exit 0, or only remaining advisories are documented in the final executor response with package path and why no compatible upgrade exists.

## Test plan

- Prefer existing tests first: `convex/daytona.test.ts`, `convex/lib/daytonaRetry.test.ts`, routing/page tests, and Mermaid component tests if present.
- Add targeted tests only if a compatibility shim is introduced.
- Full verification is required because dependency upgrades can affect many surfaces.

## Done criteria

- [ ] `package.json` and `bun.lock` upgrade the targeted direct runtime packages.
- [ ] No source files outside Scope are modified.
- [ ] `bun run format` exits 0.
- [ ] `bun run lint` exits 0.
- [ ] `bun run test` exits 0.
- [ ] `bun audit` has no critical/high runtime advisories, or remaining critical/high items are explicitly documented with package path and blocker.
- [ ] `plans/README.md` status row for plan 001 is updated.

## STOP conditions

Stop and report back if:

- The drift check shows these dependencies were already substantially changed.
- A required fix needs a broad route rewrite, sandbox lifecycle rewrite, or Mermaid renderer replacement.
- A new major version removes a Daytona capability Systify relies on, especially clone, process execution, timeout errors, or network blocking.
- `bun run test` fails after two reasonable fix attempts.

## Maintenance notes

Reviewers should scrutinize lockfile changes, not just TypeScript fixes. Confirm no dependency was downgraded to satisfy a transitive constraint. After this lands, plan 002 should still be executed because `shadcn` is a separate production dependency hygiene issue.
