# Plan 004: Remove fixed-slice filtering from active repository lists

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report; do not improvise. When done, update the status row for this plan in `plans/README.md` unless a reviewer told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 962761d..HEAD -- convex/_generated/ai/guidelines.md convex/schema.ts convex/repositories.ts convex/repositories.archive.test.ts convex/repositories.test.ts`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S/M
- **Risk**: LOW
- **Depends on**: plans/003-hide-archived-repositories-from-switcher.md
- **Category**: bug
- **Planned at**: commit `962761d`, 2026-06-13

## Why this matters

Several active repository queries currently take the newest 200 owner rows and then filter archived rows in memory. If a user archives many recent repositories, older active repositories can disappear from active lists, resource inventory, and import summaries. The fix is to make "active repository" an indexed query predicate instead of a post-processing step.

## Current state

- Convex guidelines require using indexes rather than query filters, and bounded reads rather than unbounded collection. Read `convex/_generated/ai/guidelines.md` before editing Convex code.

- Active list currently takes before filtering:

```ts
// convex/repositories.ts:44-52
const repositories = await ctx.db
  .query("repositories")
  .withIndex("by_ownerTokenIdentifier_and_deletionRequestedAt_and_importedAt", (q) =>
    q.eq("ownerTokenIdentifier", identity.tokenIdentifier).eq("deletionRequestedAt", undefined),
  )
  .order("desc")
  .take(REPOSITORY_LIST_TAKE);

return repositories.filter((repo) => repo.archivedAt === undefined);
```

- Resource inventory repeats the same fixed-slice pattern:

```ts
// convex/repositories.ts:70-79
const repositories = await ctx.db
  .query("repositories")
  .withIndex("by_ownerTokenIdentifier_and_deletionRequestedAt_and_importedAt", (q) =>
    q.eq("ownerTokenIdentifier", identity.tokenIdentifier).eq("deletionRequestedAt", undefined),
  )
  .order("desc")
  .take(REPOSITORY_LIST_TAKE);

const activeRepositories = repositories.filter((repo) => repo.archivedAt === undefined);
```

- Import summaries also filter after the fixed slice:

```ts
// convex/repositories.ts:175-193
const repos = await ctx.db
  .query("repositories")
  .withIndex("by_ownerTokenIdentifier_and_deletionRequestedAt_and_importedAt", (q) =>
    q.eq("ownerTokenIdentifier", identity.tokenIdentifier).eq("deletionRequestedAt", undefined),
  )
  .take(REPOSITORY_LIST_TAKE);

for (const repo of repos) {
  if (repo.archivedAt !== undefined) {
    continue;
  }
```

- Existing tests cover simple exclusion but not the "many archived rows before active rows" edge case:

```ts
// convex/repositories.archive.test.ts:198-216
expect(active.map((repo) => repo._id)).toEqual([activeId]);
```

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Convex typecheck | `bun run typecheck:convex` | exits 0 |
| Target tests | `bun run test -- convex/repositories.archive.test.ts convex/repositories.test.ts` | all tests pass |
| Format | `bun run format` | exits 0 |
| Lint | `bun run lint` | exits 0 |
| Full tests | `bun run test` | all tests pass |

## Scope

**In scope**:
- `convex/schema.ts`
- `convex/repositories.ts`
- `convex/repositories.archive.test.ts`
- `convex/repositories.test.ts` only if resource inventory/import summary tests fit better there

**Out of scope**:
- Repository switcher and active repository persistence; plan 003 owns those.
- Archive listing behavior.
- Changing `REPOSITORY_LIST_TAKE`.
- Adding client-side pagination.

## Git workflow

- Branch: `advisor/004-remove-fixed-slice-active-repository-filtering`
- Commit message style: imperative, e.g. `Index active repository listings`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add an active-importedAt index

In `convex/schema.ts`, add an index to `repositories` that can query active rows by owner and imported time without post-filtering:

```ts
.index("by_owner_delete_archive_importedAt", [
  "ownerTokenIdentifier",
  "deletionRequestedAt",
  "archivedAt",
  "importedAt",
])
```

Use the exact local naming convention: include every indexed field in the name. Do not remove older indexes in this plan.

**Verify**: `bun run typecheck:convex` -> exit 0.

### Step 2: Update active repository list reads

In `convex/repositories.ts`, update these functions to use the new index with `.eq("archivedAt", undefined)`:

- `listRepositories`
- `listResourceInventory`
- `getImportedRepoSummaries`

The query shape should be:

```ts
.withIndex("by_owner_delete_archive_importedAt", (q) =>
  q
    .eq("ownerTokenIdentifier", identity.tokenIdentifier)
    .eq("deletionRequestedAt", undefined)
    .eq("archivedAt", undefined),
)
.order("desc")
.take(REPOSITORY_LIST_TAKE)
```

Remove the now-unneeded `repositories.filter((repo) => repo.archivedAt === undefined)` and equivalent loop `continue` checks in these active-list functions.

**Verify**: `bun run typecheck:convex` -> exit 0.

### Step 3: Add regression tests for archived rows crowding the fixed slice

Extend `convex/repositories.archive.test.ts` or `convex/repositories.test.ts` with cases that seed more than `REPOSITORY_LIST_TAKE` archived rows newer than an active row, then assert the active row still appears.

Required cases:

- `api.repositories.listRepositories` includes the active row even when 200+ archived rows are newer.
- `api.repositories.getImportedRepoSummaries` includes the active row under the same crowding condition.
- `api.repositories.listResourceInventory` includes the active row under the same crowding condition.

Keep test row counts as small as possible while still reproducing the old bug. If you need the actual constant, either seed 201 archived rows or locally factor the constant for tests without exporting public API.

**Verify**:

```sh
bun run test -- convex/repositories.archive.test.ts convex/repositories.test.ts
```

Expected: all target tests pass.

### Step 4: Run required checks

Run:

```sh
bun run format
bun run lint
bun run test
```

**Verify**: all exit 0.

## Test plan

Add regression tests for crowding by archived rows. Existing simple archive tests are not enough because the current bug only appears when archived rows consume the fixed take window.

## Done criteria

- [ ] Active repository list queries use an index that includes `archivedAt`.
- [ ] `listRepositories`, `listResourceInventory`, and `getImportedRepoSummaries` no longer take 200 rows and then filter archived rows in memory.
- [ ] Regression tests cover 200+ archived rows crowding out an older active row.
- [ ] `bun run format` exits 0.
- [ ] `bun run lint` exits 0.
- [ ] `bun run test` exits 0.
- [ ] `plans/README.md` status row for plan 004 is updated.

## STOP conditions

Stop and report back if:

- Convex query ordering cannot preserve the current active-list order with the proposed index.
- Existing tests reveal that `importedAt` ordering was not actually the intended ordering for one of these functions.
- Fixing this properly requires client pagination or changing response shapes.

## Maintenance notes

The same smell can recur anywhere a lifecycle field is filtered after `.take()`. Future lifecycle-aware lists should encode lifecycle state in the index whenever the field controls inclusion.
