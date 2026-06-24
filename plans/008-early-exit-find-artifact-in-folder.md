# Plan 008: Stop reading the whole folder to find one artifact by kind

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat c7b6aac..HEAD -- convex/lib/artifactWrites.ts`
> If the file changed since this plan was written, compare the "Current state"
> excerpt against the live code before proceeding; on a mismatch, treat it as a
> STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (touches the same file as plan 006; see Maintenance notes
  for ordering if both are in flight)
- **Category**: perf
- **Planned at**: commit `c7b6aac`, 2026-06-24

## Why this matters

`findArtifactInFolderByKind` reads **every** artifact in a folder with
`.collect()` and then `.find()`s the one matching the requested kind. It is used
when replacing an artifact of a given kind inside a folder (e.g. regenerating a
System Design overview). The folder is bounded (a 200-artifact/folder cap is
enforced elsewhere), so this is not a correctness bug and the practical cost is
small — but it reads up to 200 documents to return one, on a write path. A
bounded, early-exiting scan keeps the hot path proportional to work actually
needed and removes a `.collect()` flagged by the Convex hot-path conventions.

## Current state

File: `convex/lib/artifactWrites.ts`. The function
(`convex/lib/artifactWrites.ts:405-420`):

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

Its only caller is `replaceArtifactInFolderWrite`
(`convex/lib/artifactWrites.ts:295-316`), which uses the result to delete a stale
artifact of the same kind before creating the replacement.

The index used is `by_repositoryId_and_folderId` (on the `artifacts` table). It
keys on `repositoryId` then `folderId` — **not** `kind` — so it cannot filter to
the kind at the index level without a schema change (out of scope).

## Commands you will need

| Purpose          | Command                                   | Expected on success |
|------------------|-------------------------------------------|---------------------|
| Typecheck convex | `bun run typecheck:convex`                | exit 0, no errors   |
| Lint             | `bun run lint`                            | exit 0              |
| Tests (focused)  | `bun run test -- artifactWrites artifactStore artifacts` | all pass |
| Tests (full)     | `bun run test`                            | all pass            |
| Format           | `bun run format`                          | writes, exit 0      |

## Scope

**In scope** (the only files you should modify):
- `convex/lib/artifactWrites.ts`
- A test file for the behavior (extend `convex/artifactStore.test.ts` or the test
  that already covers `replaceArtifactInFolder*`; see Test plan).

**Out of scope** (do NOT touch):
- `convex/schema.ts` — do **not** add a `kind` to the folder index. The win here
  is early exit, not a new index; a `(repositoryId, folderId, kind)` index would
  be a separate, larger decision.
- `replaceArtifactInFolderWrite` behavior and signature — unchanged.
- Plan 006's prune logic (if landed) — independent.

## Git workflow

- Branch: `advisor/008-early-exit-find-artifact-in-folder`
- Commit message style matches `git log` (imperative, capitalized, no trailing
  period — e.g. "Early-exit folder artifact lookup by kind").
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Replace `.collect()` + `.find()` with an early-exiting paged scan

Rewrite the body to stream the folder's artifacts and return on the first kind
match, instead of materializing the whole folder. Use the async iterator over the
index (the codebase already uses `for await` over indexed queries — see
`convex/daytona.ts:183` for the pattern), which stops as soon as you `return`:

```ts
async function findArtifactInFolderByKind(
  ctx: MutationCtx,
  args: {
    repositoryId: Id<"repositories">;
    folderId: Id<"artifactFolders">;
    kind: ArtifactKind;
  },
): Promise<Doc<"artifacts"> | null> {
  for await (const row of ctx.db
    .query("artifacts")
    .withIndex("by_repositoryId_and_folderId", (q) =>
      q.eq("repositoryId", args.repositoryId).eq("folderId", args.folderId),
    )) {
    if (row.kind === args.kind) {
      return row;
    }
  }
  return null;
}
```

This reads documents only until the match (or the end of the folder), and never
holds the whole folder in memory. Behavior is identical to the current
first-match semantics.

**Verify**: `bun run typecheck:convex` → exit 0, no errors.

### Step 2: Add/confirm a regression test

There must be a test proving `replaceArtifactInFolderWrite` still deletes the
existing same-kind artifact and creates the replacement, and that a folder with
no same-kind artifact creates a fresh one. If such a test already exists for
`replaceArtifactInFolder*`, confirm it still passes and add one assertion that an
artifact of a *different* kind in the same folder is left untouched after a
replace. If no such test exists, add one modeled on `convex/artifactStore.test.ts`
conventions (use the `internal.artifactStore.*` mutations and `t.run` to inspect
rows; create a folder via the fixtures in `test/convex/fixtures.ts`,
`insertTestArtifactFolder`).

Cases:
- Replace when a same-kind artifact exists → old one deleted, new one present,
  exactly one artifact of that kind remains in the folder.
- Replace when no same-kind artifact exists → new one created, others untouched.
- A different-kind artifact in the same folder is never deleted by the replace.

**Verify**: `bun run test -- artifactWrites artifactStore artifacts` → all pass.

### Step 3: Full gates

**Verify**: run in order, each exit 0 / all pass:
- `bun run format`
- `bun run lint`
- `bun run test`

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck:convex` exits 0
- [ ] `bun run lint` exits 0
- [ ] `bun run test` passes; a regression test covers the three cases above
- [ ] `grep -n "\.collect()" convex/lib/artifactWrites.ts` does not return the
      `findArtifactInFolderByKind` line (the function no longer collects). Note:
      other `.collect()` uses elsewhere in the file may legitimately remain — only
      this function must change.
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row for 008 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The function at `convex/lib/artifactWrites.ts:405-420` does not match the
  "Current state" excerpt (the file has drifted).
- `for await` over an indexed query does not typecheck against this project's
  Convex version — fall back to a paged `.take(N)` loop that breaks on first
  match, and report that you did so.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- If folders ever lose their 200-artifact cap, or if this lookup shows up in
  profiling, the right next step is a `(repositoryId, folderId, kind)` composite
  index — explicitly deferred here because the early exit already removes the
  unbounded read for the common case (the match is usually early or absent).
- If plan 006 (version-history pruning) is also in flight, both edit
  `convex/lib/artifactWrites.ts`. They touch different functions; land them in
  either order, but expect a trivial merge in the import/region of the file.
- Reviewer should confirm the new loop preserves *first-match* semantics
  identical to the old `.find()` (folder order via the index), since the caller
  deletes exactly the returned artifact.
