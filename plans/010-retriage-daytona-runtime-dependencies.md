# Plan 010: Re-triage Daytona runtime dependency advisories

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan in
> `plans/README.md` unless a reviewer dispatched you and told you they maintain
> the index.
>
> **Drift check (run first)**: `git diff --stat 5d75710..HEAD -- package.json bun.lock convex/daytona.ts convex/daytona.test.ts convex/lib/daytonaRetry.ts convex/lib/daytonaRetry.test.ts src/components/mermaid-diagram.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security / migration
- **Planned at**: commit `5d75710`, 2026-06-27

## Why this matters

`bun audit --production` currently exits nonzero with 41 advisories, including
15 high advisories. The highest-leverage production paths are through
`@daytona/sdk`, which powers sandbox provisioning, sandbox listing, clone,
network lockdown, file access, and shell execution, and through `convex`, which
pins a vulnerable `ws` version in the current lockfile. Some Daytona transitive
advisories may remain unreachable in Systify's usage, but the current direct
packages are no longer latest and the advisory set has changed since plan 001.
This plan upgrades the direct packages first, fixes only narrow API drift, then
documents any remaining high advisories with concrete reachability analysis.

## Current state

- `package.json` pins or ranges the direct packages that own most current audit
  paths:

```json
// package.json:44,57,60,68
"@daytona/sdk": "0.187.0",
"convex": "^1.39.1",
"mermaid": "^11.15.0",
"streamdown": "^2.5.0",
```

- At plan time, read-only registry probes reported:
  - `bun pm view @daytona/sdk version` -> `0.191.0`
  - `bun pm view convex version` -> `1.42.0`
  - `bun pm view mermaid version` -> `11.16.0`
  - `bun pm view streamdown version` -> `2.5.0`

  Treat these as evidence that newer direct versions exist, not as hard-coded
  targets if the registry has advanced by the time this plan runs.

- `bun audit --production` at plan time reported 41 advisories: 15 high, 22
  moderate, 4 low. High advisory paths included:
  - `@daytona/sdk -> form-data`
  - `@daytona/sdk -> @opentelemetry/... -> @grpc/grpc-js`
  - `@daytona/sdk -> @opentelemetry/... -> protobufjs`
  - `@daytona/sdk -> @aws-sdk/... -> fast-xml-builder`
  - `@daytona/sdk -> isomorphic-ws -> ws`
  - `convex -> ws`

- `bun.lock` currently resolves these relevant package versions:

```text
// bun.lock:270
"@daytona/sdk": ["@daytona/sdk@0.187.0", "", { "dependencies": { ... "form-data": "^4.0.4", "isomorphic-ws": "^5.0.0", "tar": "^7.5.11" } }, ...]

// bun.lock:364
"@grpc/grpc-js": ["@grpc/grpc-js@1.14.3", ...]

// bun.lock:1132
"convex": ["convex@1.39.1", "", { "dependencies": { "esbuild": "0.27.0", "prettier": "^3.0.0", "ws": "8.18.0" } }, ...]

// bun.lock:1404
"form-data": ["form-data@4.0.5", ...]

// bun.lock:1932
"protobufjs": ["protobufjs@8.0.1", ...]

// bun.lock:2276
"ws": ["ws@8.18.0", ...]
```

- The Daytona runtime surface lives in `convex/daytona.ts`:

```ts
// convex/daytona.ts:3
import { CodeLanguage, Daytona, DaytonaError, DaytonaNotFoundError, DaytonaTimeoutError } from "@daytona/sdk";

// convex/daytona.ts:119-134
const sandbox = await withDaytonaRetry(
  () =>
    daytona.create({
      name: sandboxName,
      language: CodeLanguage.TYPESCRIPT,
      labels: { ... },
      autoStopInterval: readNumberEnv("DAYTONA_AUTO_STOP_MINUTES", DEFAULT_AUTO_STOP_MINUTES),
      autoArchiveInterval: readNumberEnv("DAYTONA_AUTO_ARCHIVE_MINUTES", DEFAULT_AUTO_ARCHIVE_MINUTES),
      autoDeleteInterval: readNumberEnv("DAYTONA_AUTO_DELETE_MINUTES", DEFAULT_AUTO_DELETE_MINUTES),
      networkBlockAll: false,
    }),
  { operation: "sandbox.create", resourceId: sandboxName },
);

// convex/daytona.ts:173-180
export async function listSandboxesByLabel(labels: Record<string, string>): Promise<ListedSandbox[]> {
  const daytona = createDaytonaClient();
  return withDaytonaRetry(
    async () => {
      const sandboxes: ListedSandbox[] = [];
      for await (const sandbox of daytona.list({ labels, limit: 100 })) {
```

- The same file also performs clone, token scrub, post-clone network lockdown,
  and shell execution. These behaviors are load-bearing and must survive SDK
  upgrades:

```ts
// convex/daytona.ts:368-375
sandbox.git.clone(args.url, "repo", args.branch, undefined, args.token ? "x-access-token" : undefined, args.token)

// convex/daytona.ts:402-404
sandbox.process.executeCommand(`git remote set-url origin ${posixSingleQuote(args.url)}`, "repo")

// convex/daytona.ts:435-436
sandbox.updateNetworkSettings({ networkBlockAll: true })

// convex/daytona.ts:849
sandbox.process.executeCommand(commandToRun, options.cwd, env, options.timeoutSeconds)
```

- There is a stale comment at `convex/daytona.ts:418` saying this project pins
  `@daytona/sdk` at `0.173.0`; `package.json` actually pins `0.187.0`. If this
  area is touched by the upgrade, update or remove the stale version reference.

- Sandbox security design constraints to preserve:
  - `docs/sandbox/sandbox-mode-security-system-design.md:201` says clone-time
    scrubbing must remove the GitHub token from `.git/config` before later
    commands can expose it.
  - `docs/sandbox/sandbox-mode-security-system-design.md:202` says post-clone
    egress blocking via `sandbox.updateNetworkSettings({ networkBlockAll: true })`
    is the load-bearing network exfiltration defense when available.
  - `docs/sandbox/sandbox-mode-system-design.md:32` describes Daytona as the
    control plane for create, delete, list, `executeCommand`, filesystem calls,
    and `updateNetworkSettings`.

Repo conventions: this is a Bun + TypeScript + Convex project. Do not use
`any` unless unavoidable. Keep edits direct and narrow. Existing Daytona tests
in `convex/daytona.test.ts` are the first place to adapt or extend SDK API
compatibility coverage.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Initial prod audit | `bun audit --production` | currently exits nonzero and lists target advisories |
| Initial full audit | `bun audit` | currently exits nonzero; use to identify dev-only residue separately |
| Check direct latests | `bun pm view @daytona/sdk version && bun pm view convex version && bun pm view mermaid version && bun pm view streamdown version` | exits 0 and prints versions |
| Upgrade direct runtime deps | `bun update @daytona/sdk convex mermaid streamdown` | exits 0 and updates `bun.lock`; `streamdown` may remain unchanged |
| Targeted Daytona tests | `bun run test -- daytona daytonaRetry` | all matching tests pass |
| Targeted Mermaid tests | `bun run test -- mermaid` | all matching tests pass, or reports no matching tests if none exist |
| Typecheck | `bun run typecheck` | exit 0, no errors |
| Convex typecheck | `bun run typecheck:convex` | exit 0, no errors |
| Lint | `bun run lint` | exit 0 |
| Tests | `bun run test` | all tests pass |
| Format | `bun run format` | exit 0 |
| Final prod audit | `bun audit --production` | no high reachable runtime advisories, or documented residuals with blockers |

Do not run dev servers or builds.

## Scope

**In scope**:
- `package.json`
- `bun.lock`
- `convex/daytona.ts`
- `convex/daytona.test.ts`
- `convex/lib/daytonaRetry.ts`
- `convex/lib/daytonaRetry.test.ts`
- `src/components/mermaid-diagram.tsx` only if a Mermaid upgrade changes the API
- `plans/README.md` for status and residual-advisory notes

**Out of scope**:
- Replacing Daytona, Convex, Mermaid, Streamdown, Vite, or the package manager.
- Broad dependency modernization unrelated to current audit paths.
- Forcing deep transitive overrides under Daytona or Convex before trying direct
  package upgrades and assessing reachability.
- Changing sandbox lifecycle semantics, clone security posture, network-block
  defaults, prompt behavior, or repository import behavior.
- Solving dev-only Vite/esbuild advisories unless they still appear in the
  production audit after runtime package updates. If Vite remains a separate
  dev-tooling issue, report it as follow-up instead of expanding this plan.

## Git workflow

- Branch: `advisor/010-retriage-daytona-runtime-dependencies`
- Commit message style in recent history is imperative, e.g. `Handle partial system design completion and overview tab focus`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Capture current advisory baseline

Run:

```sh
bun audit --production
bun audit
```

In your notes, group advisories into:

1. Production advisories through direct runtime packages (`@daytona/sdk`,
   `convex`, `mermaid`, `streamdown`).
2. Dev-only advisories (`vite`, `vitest`, `jsdom`, lint tooling, shadcn).
3. Unknown or surprising paths that need source confirmation.

Do not edit files in this step.

**Verify**: `bun audit --production` exits nonzero and still includes at least
one of the target production paths listed in "Current state", unless the repo
has drifted and someone already fixed them.

### Step 2: Upgrade direct runtime packages

Run:

```sh
bun update @daytona/sdk convex mermaid streamdown
```

If Bun does not update a package despite a newer compatible version existing,
inspect the semver constraint. Make the smallest `package.json` change needed
for these direct packages, then run `bun install` once to refresh `bun.lock`.

Do not add deep overrides in this step. In particular, do not force
OpenTelemetry, protobuf, AWS SDK, or ws subtrees under Daytona unless later
evidence shows no direct package upgrade can resolve a reachable high advisory.

**Verify**: `git diff -- package.json bun.lock` shows only dependency version
and lockfile resolution changes at this point.

### Step 3: Fix narrow API drift only

Run:

```sh
bun run typecheck
bun run typecheck:convex
```

If the Daytona SDK changed types or method signatures, update only the
compatibility points in `convex/daytona.ts` and tests. Preserve these behaviors:

- `provisionSandbox` still creates TypeScript sandboxes with Systify labels,
  auto-stop/archive/delete intervals, and `networkBlockAll: false` before clone.
- `listSandboxesByLabel` still lists Systify-managed sandboxes by label with a
  bounded page/limit strategy.
- `cloneRepositoryInSandbox` still scrubs the credentialed remote URL before
  branch/SHA inspection and before user-visible sandbox tools can run.
- `cloneRepositoryInSandbox` still attempts post-clone network lockdown by
  default and fails closed when `DAYTONA_POST_CLONE_BLOCK_NETWORK` resolves true.
- `executeCommand` timeout errors still map to the structured timeout outcome.
- `deleteSandbox`, `stopSandbox`, `startSandbox`, and `probeLiveSandbox` keep
  their current not-found/error classification semantics.

If a Mermaid upgrade changes rendering APIs, make only the compatibility edit in
`src/components/mermaid-diagram.tsx`. Preserve strict Mermaid security mode.

Also update the stale `@daytona/sdk` version comment at
`convex/daytona.ts:418` if the surrounding block changes.

**Verify**: `bun run typecheck && bun run typecheck:convex` exits 0.

### Step 4: Run targeted regression tests

Run:

```sh
bun run test -- daytona daytonaRetry
bun run test -- mermaid
```

If `bun run test -- mermaid` reports no matching tests, do not create a test
only for that reason. If you changed `src/components/mermaid-diagram.tsx`, add
or update focused coverage following the nearest existing component test
pattern, then re-run the targeted test.

**Verify**: targeted Daytona tests pass; Mermaid tests pass or no matching
tests exist and Mermaid source was untouched.

### Step 5: Re-run audits and decide on residuals

Run:

```sh
bun audit --production
bun audit
```

For every remaining high advisory in `bun audit --production`, document:

- package name and advisory severity,
- dependency path,
- whether Systify's code reaches that package path,
- whether a compatible patched direct dependency exists,
- whether a transitive override would be safer than waiting for upstream.

Be conservative:

- A Daytona path used by create/list/clone/network block/executeCommand should
  be treated as reachable unless source review proves otherwise.
- OpenTelemetry exporters bundled by Daytona may be unreachable if Systify never
  enables OTel in `createDaytonaClient`; confirm from code before documenting
  them as unreachable.
- Daytona AWS/S3 helper paths may be unreachable if Systify never calls SDK
  storage APIs; confirm from code before documenting them as unreachable.
- Convex `ws` should be treated as runtime-relevant unless the updated Convex
  version removes the advisory.

If high reachable production advisories remain and a direct patched version
exists, return to Step 2. If only unreachable or upstream-blocked high advisories
remain, document them in `plans/README.md` near the plan 010 status note.

**Verify**: final `bun audit --production` either exits 0, or every remaining
high production advisory is documented with reachability and blocker.

### Step 6: Run the full project gate

Run the repo-required completion commands:

```sh
bun run format
bun run lint
bun run typecheck
bun run test
```

Expected: all exit 0. Existing JSDOM `scrollTo` or `TimeoutNegativeWarning`
warnings are acceptable only if tests pass and the warnings are unchanged from
the pre-plan baseline.

**Verify**: all four commands exit 0.

## Test plan

- Existing Daytona coverage is the primary regression suite:
  - `convex/daytona.test.ts`
  - `convex/lib/daytonaRetry.test.ts`
- Add Daytona tests only if the SDK upgrade requires a compatibility shim or
  changed error-shape handling.
- Mermaid coverage is required only if `src/components/mermaid-diagram.tsx` is
  changed.
- Full `bun run test` is required because dependency upgrades can affect shared
  runtime behavior outside the files edited directly.

## Done criteria

- [ ] `package.json` and `bun.lock` are updated for the targeted direct runtime
      packages, or the executor documents why no update was available at run
      time.
- [ ] No files outside Scope are modified, except tests added only to cover an
      in-scope compatibility shim.
- [ ] `bun run format` exits 0.
- [ ] `bun run lint` exits 0.
- [ ] `bun run typecheck` exits 0.
- [ ] `bun run typecheck:convex` exits 0.
- [ ] `bun run test` exits 0.
- [ ] `bun audit --production` exits 0, or every remaining high production
      advisory is documented with package path, reachability, and blocker.
- [ ] `plans/README.md` status row for plan 010 is updated.

## STOP conditions

Stop and report back if:

- The drift check shows the dependency set or Daytona integration was already
  substantially changed after commit `5d75710`.
- A Daytona SDK upgrade removes or materially changes create, get, list, delete,
  git clone, process execution, timeout errors, or network settings APIs in a
  way that requires a broad sandbox lifecycle rewrite.
- Fixing an advisory appears to require replacing Daytona, replacing Convex, or
  disabling the post-clone network block.
- A transitive override would cross major versions under Daytona, Convex, AWS
  SDK, OpenTelemetry, protobuf, or ws without upstream documentation that the
  combination is supported.
- Full verification fails twice after reasonable narrow fixes.

## Maintenance notes

This plan intentionally separates "audit is clean" from "runtime risk is
handled". Some advisories may remain in package-manager output because direct
dependencies bundle unused optional stacks or upstream has not released a
compatible patched version. Reviewers should look for a clear, current residual
advisory note rather than only checking whether `bun audit` exits 0.

If this plan leaves dev-only Vite/esbuild advisories, handle them in a separate
tooling plan. Keep this plan focused on production dependency risk and the
Daytona/Convex runtime paths.
