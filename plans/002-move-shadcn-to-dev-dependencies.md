# Plan 002: Move CLI-only shadcn out of production dependencies

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report; do not improvise. When done, update the status row for this plan in `plans/README.md` unless a reviewer told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 962761d..HEAD -- package.json bun.lock`
> If either in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-upgrade-vulnerable-runtime-dependencies.md
- **Category**: dx
- **Planned at**: commit `962761d`, 2026-06-13

## Why this matters

The app uses shadcn-generated components, but runtime source does not import the `shadcn` CLI package. Keeping the CLI under production `dependencies` pulls a large toolchain into production installs and makes dependency audit output noisier. Moving it to `devDependencies` keeps the CLI available for development while shrinking the production dependency graph.

## Current state

- `package.json` currently lists `shadcn` in production dependencies:

```json
// package.json:63
"shadcn": "^4.2.0",
```

- Source search at plan time found no app import of the package. The only references are docs/comments and the manifest:

```text
package.json:63:    "shadcn": "^4.2.0",
README.md:51:- shadcn/ui and Radix primitives
src/components/ui/button-group.tsx:1:/* eslint-disable ... -- shadcn-generated ... */
```

- `bun.lock` shows the CLI has many transitive dependencies:

```text
// bun.lock:2060
"shadcn": ["shadcn@4.2.0", "", { "dependencies": { "@babel/core": "...", "@modelcontextprotocol/sdk": "...", ... } }, ...]
```

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Confirm no runtime imports | `rg -n "from ['\\\"]shadcn|import\\(['\\\"]shadcn" src convex scripts test` | no matches |
| Update manifest/lock | edit `package.json`, then `bun install` | exits 0 and refreshes `bun.lock` if needed |
| Format | `bun run format` | exits 0 |
| Lint | `bun run lint` | exits 0 |
| Tests | `bun run test` | all tests pass |
| Audit | `bun audit` | no new critical/high production-runtime findings caused by this move |

## Scope

**In scope**:
- `package.json`
- `bun.lock`

**Out of scope**:
- Editing generated shadcn UI components.
- Updating shadcn component source.
- Changing styling, Tailwind, Radix, or UI behavior.
- Fixing unrelated dependency advisories; plan 001 owns runtime upgrades.

## Git workflow

- Branch: `advisor/002-move-shadcn-to-dev-dependencies`
- Commit message style: imperative, e.g. `Move shadcn CLI to dev dependencies`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Reconfirm shadcn is not imported by runtime code

Run:

```sh
rg -n "from ['\"]shadcn|import\\(['\"]shadcn" src convex scripts test
```

**Verify**: command prints no matches. If it prints an actual import, stop.

### Step 2: Move `shadcn` to `devDependencies`

Edit `package.json` so `shadcn` is removed from `dependencies` and added to `devDependencies` with the same version range unless plan 001 already upgraded it.

Then run `bun install` to let Bun update `bun.lock`.

**Verify**:

```sh
rg -n '"shadcn"' package.json bun.lock
```

Expected: `package.json` has `shadcn` under `devDependencies`; `bun.lock` remains internally consistent.

### Step 3: Run required checks

Run:

```sh
bun run format
bun run lint
bun run test
```

**Verify**: all exit 0.

### Step 4: Check audit impact

Run `bun audit`. If advisories remain from dev-only tools, document that in the final executor response rather than trying to remove unrelated tools.

**Verify**: audit output no longer treats `shadcn` as a production runtime dependency. If Bun audit cannot distinguish production/dev, note that limitation.

## Test plan

No new app tests should be necessary because this is dependency classification only. Existing lint, typecheck, and tests are the regression suite.

## Done criteria

- [ ] `shadcn` is in `devDependencies`, not `dependencies`.
- [ ] `bun.lock` is updated consistently.
- [ ] No source files are modified.
- [ ] `bun run format` exits 0.
- [ ] `bun run lint` exits 0.
- [ ] `bun run test` exits 0.
- [ ] `plans/README.md` status row for plan 002 is updated.

## STOP conditions

Stop and report back if:

- A real import of `shadcn` exists in runtime code.
- Bun refuses to produce a consistent lockfile without unrelated upgrades.
- Moving the package changes generated UI source files.

## Maintenance notes

If future work uses the shadcn CLI, run it through `bunx shadcn` or the dev dependency. Do not move the CLI back to production dependencies unless app runtime code imports it directly, which would be unusual.
