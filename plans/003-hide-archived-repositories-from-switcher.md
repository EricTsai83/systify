# Plan 003: Hide archived and deleting repositories from active selection

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report; do not improvise. When done, update the status row for this plan in `plans/README.md` unless a reviewer told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 962761d..HEAD -- convex/_generated/ai/guidelines.md convex/schema.ts convex/repositoryPreferences.ts convex/repositories.archive.test.ts convex/repositoryPreferences.test.ts src/components/chat-shell-shared/use-repository-persistence.ts src/components/repository-switcher.tsx`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `962761d`, 2026-06-13

## Why this matters

Archived repositories are meant to leave active navigation and live workflows, while remaining available through archive-specific surfaces. Today the repository switcher and active-repository persistence path can still see archived or deletion-requested repositories. That lets stale rows become the current repository and can send users into routes where active repository operations reject the row later.

## Current state

- Convex guidelines require indexed, bounded reads and say not to use `filter` for database filtering. Read `convex/_generated/ai/guidelines.md` first, per `AGENTS.md`.

```md
// convex/_generated/ai/guidelines.md
Do NOT use `filter` in queries. Instead, define an index in the schema and use `withIndex` instead.
```

- `repositoryPreferences.listRepositoriesForSwitcher` currently queries by owner and last access only. It does not filter `deletionRequestedAt` or `archivedAt`:

```ts
// convex/repositoryPreferences.ts:22-32
return await ctx.db
  .query("repositories")
  .withIndex("by_ownerTokenIdentifier_and_lastAccessedAt", (q) =>
    q.eq("ownerTokenIdentifier", identity.tokenIdentifier),
  )
  .order("desc")
  .take(20);
```

- `listOwnedRepositoryIdsById` also treats archived/deleting rows as owned/live:

```ts
// convex/repositoryPreferences.ts:58-60
const repository = await ctx.db.get(repositoryId);
if (repository?.ownerTokenIdentifier === identity.tokenIdentifier) {
  uniqueIds.add(repositoryId);
}
```

- The frontend trusts these active-selection results:

```ts
// src/components/chat-shell-shared/use-repository-persistence.ts:109-115
return resolveRepositorySelection({
  urlRepositoryId,
  activeRepositoryId,
  dbRepositoryId: viewerPreferences?.lastActiveRepositoryId ?? null,
  switcherRepositoryIds: repositories.map((repo) => repo._id),
  ownerRepositoryIds: ownerRepositoryIdSet,
});
```

```tsx
// src/components/repository-switcher.tsx:69-76
<Combobox<Doc<"repositories">>
  items={repositories}
  value={activeRepository ?? null}
  onValueChange={(repo) => {
    setPopoverOpen(false);
    if (repo && repo._id !== activeRepositoryId) onSwitchRepository(repo._id);
  }}
```

- Existing archive tests already establish the intended active/archive split for `api.repositories.listRepositories`:

```ts
// convex/repositories.archive.test.ts:198-216
const active = await viewer.query(api.repositories.listRepositories, {});
const archived = await viewer.query(api.repositories.listArchivedRepositories, {
  paginationOpts: { numItems: 50, cursor: null },
});
expect(active.map((repo) => repo._id)).toEqual([activeId]);
expect(archived.page.map((repo) => repo._id)).toEqual([archivedId]);
```

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Convex typecheck | `bun run typecheck:convex` | exits 0 |
| Target tests | `bun run test -- convex/repositoryPreferences.test.ts convex/repositories.archive.test.ts` | all tests pass |
| Format | `bun run format` | exits 0 |
| Lint | `bun run lint` | exits 0 |
| Full tests | `bun run test` | all tests pass |

## Scope

**In scope**:
- `convex/schema.ts`
- `convex/repositoryPreferences.ts`
- `convex/repositoryPreferences.test.ts` (create if absent)
- `convex/repositories.archive.test.ts` only if you choose to extend existing archive-listing tests

**Out of scope**:
- Archive page UI.
- Repository deletion cascade.
- `api.repositories.listRepositories`; plan 004 owns broader active-list pagination/fixed-slice behavior.
- Frontend component changes unless backend behavior cannot preserve current props.

## Git workflow

- Branch: `advisor/003-hide-archived-repositories-from-switcher`
- Commit message style: imperative, e.g. `Hide archived repositories from switcher`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add an active-switcher index

In `convex/schema.ts`, add an index on `repositories` that can answer "active rows for owner ordered by lastAccessedAt" without in-memory filtering. Use the repo's naming convention that includes all index fields, for example:

```ts
.index("by_owner_delete_archive_lastAccessedAt", [
  "ownerTokenIdentifier",
  "deletionRequestedAt",
  "archivedAt",
  "lastAccessedAt",
])
```

Do not remove existing indexes in this plan.

**Verify**: `bun run typecheck:convex` -> exit 0.

### Step 2: Filter switcher rows through the new index

Update `listRepositoriesForSwitcher` to query:

```ts
.withIndex("by_owner_delete_archive_lastAccessedAt", (q) =>
  q
    .eq("ownerTokenIdentifier", identity.tokenIdentifier)
    .eq("deletionRequestedAt", undefined)
    .eq("archivedAt", undefined),
)
.order("desc")
.take(20)
```

Keep the return shape unchanged.

**Verify**: `bun run typecheck:convex` -> exit 0.

### Step 3: Treat archived/deleting ids as not live for active selection

Update `listOwnedRepositoryIdsById` so it only returns ids where:

- `ownerTokenIdentifier` matches the viewer
- `deletionRequestedAt === undefined`
- `archivedAt === undefined`

This function is used by active route/persistence validation. Archive-specific pages use archive-specific queries and should not depend on it accepting archived rows.

**Verify**: `bun run typecheck:convex` -> exit 0.

### Step 4: Add focused Convex tests

Create `convex/repositoryPreferences.test.ts` following the `createTestConvex` pattern from `convex/userPreferences.test.ts`.

Add tests for:

- `listRepositoriesForSwitcher` returns active rows and excludes archived/deletion-requested rows.
- `listOwnedRepositoryIdsById` returns active owned ids and excludes archived/deletion-requested rows.
- A foreign owner's active repo is still excluded.

Use seed data shaped like `convex/repositories.archive.test.ts:18-50`.

**Verify**:

```sh
bun run test -- convex/repositoryPreferences.test.ts
```

Expected: new tests pass.

### Step 5: Run required checks

Run:

```sh
bun run format
bun run lint
bun run test
```

**Verify**: all exit 0.

## Test plan

New tests should live in `convex/repositoryPreferences.test.ts`. Model the harness after `convex/userPreferences.test.ts`, and model repository seed fields after `convex/repositories.archive.test.ts`.

## Done criteria

- [ ] `listRepositoriesForSwitcher` excludes archived and deletion-requested repositories using an index.
- [ ] `listOwnedRepositoryIdsById` excludes archived and deletion-requested repositories.
- [ ] New Convex tests cover switcher and ownership-probe behavior.
- [ ] `bun run format` exits 0.
- [ ] `bun run lint` exits 0.
- [ ] `bun run test` exits 0.
- [ ] `plans/README.md` status row for plan 003 is updated.

## STOP conditions

Stop and report back if:

- Convex rejects the proposed index or query ordering.
- Any existing caller demonstrably needs `listOwnedRepositoryIdsById` to return archived repositories.
- Fixing the route/persistence behavior requires frontend rewrites outside Scope.

## Maintenance notes

Future active repository selectors should use active-only indexes rather than owner-only reads plus post-filtering. Archive reads should remain separate so active surfaces and archive surfaces do not blur lifecycle state.
