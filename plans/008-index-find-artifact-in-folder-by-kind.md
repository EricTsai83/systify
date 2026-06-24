# Plan 008: Replace unbounded folder scan in `findArtifactInFolderByKind` with an indexed lookup

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat c7b6aac..HEAD -- convex/lib/artifactWrites.ts convex/schema.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (independent of 006, though both edit `convex/lib/artifactWrites.ts` — see Maintenance notes)
- **Category**: perf
- **Planned at**: commit `c7b6aac`, 2026-06-24

## Why this matters

`findArtifactInFolderByKind` (`convex/lib/artifactWrites.ts:405-420`) loads **all**
artifacts in a folder with `.collect()` and then `.find()`s the one matching a
`kind` in memory. It runs on every System Design artifact replacement
(`replaceArtifactInFolderWrite`, line 306). Today folders hold few artifacts so
the cost is small, but it is an unbounded full-folder read with O(n) in-memory
filtering on a write path. A composite index makes it an O(1)-ish indexed lookup
and removes the unbounded `.collect()`.

## Current state

- `convex/lib/artifactWrites.ts:405-420`:

  ```ts
  async function findArtifactInFolderByKind(
    ctx: MutationCtx,
    args: {
      repositoryId: Id<"repositories">;
      folderId: Id<"artifactFolders">;
      kind: ArtifactKind;
    },
  ): Promise<Doc<"artifacts"> | null> {
    const existing = await ctx.db
      .query("artifacts")
      .withIndex("by_repositoryId_and_folderId", (q) =>
        q.eq("repositoryId", args.repositoryId).eq("folderId", args.folderId),
      )
      .collect();
    return existing.find((row) => row.kind === args.kind) ?? null;
  }
  ```

- Its only caller is `replaceArtifactInFolderWrite` (`convex/lib/artifactWrites.ts:306-313`),
  which deletes the stale same-kind artifact then creates the new one. Semantics:
  return the (at most one expected) artifact in the folder with the given kind.

- `convex/schema.ts` `artifacts` table indexes (around lines 600–616) include
  `by_repositoryId_and_folderId` (line ~609) and `by_repositoryId_and_kind`, but
  **no** `by_repositoryId_and_folderId_and_kind`. Existing 3+-field index naming
  convention in this table, e.g.:

  ```ts
  .index("by_repositoryId_and_folderId", ["repositoryId", "folderId"])
  .index("by_repositoryId_and_kind", ["repositoryId", "kind"])
  ```

Repo conventions: index names are `by_<field>_and_<field>...`; fields listed in
the array in the same order. Match exactly. No `any`.

## Commands you will need

| Purpose   | Command                                  | Expected on success |
|-----------|------------------------------------------|---------------------|
| Convex TC | `bun run typecheck:convex`               | exit 0              |
| Typecheck | `bun run typecheck`                      | exit 0              |
| Lint      | `bun run lint`                           | exit 0, 0 warnings  |
| Tests     | `bun run test -- artifactWrites artifactStore` | all pass      |
| Format    | `bun run format`                         | rewrites, exit 0    |

## Scope

**In scope** (the only files you should modify):
- `convex/schema.ts` — add the composite index to the `artifacts` table.
- `convex/lib/artifactWrites.ts` — change `findArtifactInFolderByKind` to use it.
- A test file for the helper if one exists; otherwise rely on the existing
  `replaceArtifactInFolderWrite` coverage (search:
  `grep -rln "replaceArtifactInFolderWrite\|findArtifactInFolderByKind" convex/`).

**Out of scope** (do NOT touch):
- The `replaceArtifactInFolderWrite` deletion/creation logic — only the lookup changes.
- Any other index on the `artifacts` table.

## Git workflow

- Branch: `advisor/008-index-find-artifact-in-folder-by-kind`
- One commit; imperative message matching `git log` (e.g. "Index folder artifact lookup by kind").
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Add the composite index

In `convex/schema.ts`, on the `artifacts` table, add (placed next to the existing
folder index for readability):

```ts
.index("by_repositoryId_and_folderId_and_kind", ["repositoryId", "folderId", "kind"])
```

**Verify**: `bun run typecheck:convex` → exit 0.

### Step 2: Use the index in `findArtifactInFolderByKind`

Replace the `.collect()` + `.find()` body with an indexed query that filters on
all three fields and returns the first match:

```ts
const existing = await ctx.db
  .query("artifacts")
  .withIndex("by_repositoryId_and_folderId_and_kind", (q) =>
    q.eq("repositoryId", args.repositoryId).eq("folderId", args.folderId).eq("kind", args.kind),
  )
  .first();
return existing ?? null;
```

`.first()` returns the earliest-inserted matching row (or `null`). This preserves
the previous behavior: `.find()` also returned the first match in query order.

**Verify**: `bun run typecheck:convex` → exit 0; `bun run lint` → exit 0.

### Step 3: Tests and format

Run the existing suite that exercises `replaceArtifactInFolderWrite`, then format.

**Verify**: `bun run test -- artifactWrites artifactStore` → all pass.

## Test plan

- If a test already covers `replaceArtifactInFolderWrite` (replacing a System
  Design artifact in a folder), confirm it still passes — it implicitly covers
  the new lookup.
- If no such test exists, add one in the file where `createArtifactWrite` /
  `replaceArtifactInFolderWrite` are tested (likely `convex/artifactStore.test.ts`),
  modeled after existing `convexTest` usage: seed a repository + folder, create
  an artifact of kind K in the folder, call `replaceArtifactInFolderWrite` with
  the same kind, and assert the old artifact is deleted and exactly one
  same-kind artifact remains. Also assert that an artifact of a **different**
  kind in the same folder is NOT deleted (guards against the index/eq being
  wrong).

Verification: `bun run test` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` and `bun run typecheck:convex` exit 0
- [ ] `bun run lint` exits 0, 0 warnings
- [ ] `bun run test` exits 0
- [ ] `grep -n "by_repositoryId_and_folderId_and_kind" convex/schema.ts convex/lib/artifactWrites.ts` shows it defined in schema and used in the helper
- [ ] `grep -n "\.collect()" convex/lib/artifactWrites.ts` does NOT show a match inside `findArtifactInFolderByKind` (the `deleteArtifactVersionsAndHtmlStorage` paging loop has no `.collect()`; verify your change removed the folder-scan `.collect()`)
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row for 008 updated

## STOP conditions

Stop and report back (do not improvise) if:

- More than one artifact of the same kind can legitimately exist in a folder
  (i.e. `replaceArtifactInFolderWrite` expects to find/replace multiple). If so,
  `.first()` is wrong and the original `.collect()`/iterate may be intentional —
  STOP and report. (Read `replaceArtifactInFolderWrite` and its callers to
  confirm the one-per-(folder,kind) assumption before proceeding.)
- The `artifacts` table or `by_repositoryId_and_folderId` index in `schema.ts`
  no longer matches the excerpt.
- Convex rejects the new index (e.g. a field name typo) — fix the name; if it
  still fails after one retry, report.

## Maintenance notes

- This plan and plan 006 both edit `convex/lib/artifactWrites.ts`. If executing
  both, do them on separate branches and expect a trivial merge; they touch
  different functions (006: `updateArtifactWrite` + new prune helper; 008:
  `findArtifactInFolderByKind` + schema index). No ordering dependency.
- A reviewer should confirm the one-artifact-per-(folder, kind) invariant holds
  in the product, since `.first()` now assumes it. If the product ever allows
  multiple, this lookup and its callers need revisiting.
