# Plan 006: Bound artifact version history with a retention cap

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat c7b6aac..HEAD -- convex/lib/artifactWrites.ts convex/artifactVersions.ts convex/schema.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: tech-debt / perf
- **Planned at**: commit `c7b6aac`, 2026-06-24

## Why this matters

Every edit to an artifact inserts a brand-new row into the `artifactVersions`
table, carrying a full copy of `contentMarkdown` (and HTML metadata). There is
**no retention policy**: rows accumulate forever and are reclaimed only when the
entire artifact is deleted. The version *listing* query already caps results at
50 (`artifactVersions.ts`), so versions beyond the 50 most recent are never read
by any product surface — they are pure dead weight. A frequently re-edited
artifact grows its version table without bound, and full-artifact deletion has
to page through every row. This plan caps retained versions per artifact and
prunes the excess on each write, while being careful never to delete the current
version or an HTML storage blob still referenced by a retained version.

## Current state

Relevant files:

- `convex/lib/artifactWrites.ts` — all artifact version writes. `updateArtifactWrite`
  creates a new version row on every content/metadata change; `createArtifactWrite`
  creates version 1; `deleteArtifactVersionsAndHtmlStorage` is the only place rows
  are ever removed (full artifact delete).
- `convex/artifactVersions.ts` — read-side queries; `listByArtifact` caps display
  at `ARTIFACT_VERSION_LIST_LIMIT = 50`.
- `convex/schema.ts` — `artifactVersions` table with indexes
  `by_artifactId` and `by_artifactId_and_version`. **No schema change is needed.**

The new-version insert in `updateArtifactWrite` (`convex/lib/artifactWrites.ts:211-242`):

```ts
  if (changed) {
    if (
      args.title !== undefined ||
      args.summary !== undefined ||
      args.contentMarkdown !== undefined ||
      args.renderFormat !== undefined ||
      versionMetadataChanged
    ) {
      const nextVersion = artifact.version + 1;
      const renderFormat = args.renderFormat ?? artifact.renderFormat ?? "markdown";
      const previousHtml = renderFormat === "html" ? await getCurrentVersionHtmlFields(ctx, artifact) : {};
      const versionId = await createArtifactVersionWrite(ctx, {
        artifactId: artifact._id,
        version: nextVersion,
        // ...fields elided...
      });
      patch.version = nextVersion;
      patch.currentVersionId = versionId;
    }
    patch.updatedAt = Date.now();
    await ctx.db.patch(args.artifactId, patch);
    await scheduleArtifactReindex(ctx, { /* ... */ });
  }
  return { updated: changed };
```

The existing delete-time pruning helper, which you will mirror for the
storage-dedup logic (`convex/lib/artifactWrites.ts:360-381`):

```ts
async function deleteArtifactVersionsAndHtmlStorage(
  ctx: MutationCtx,
  artifactId: Id<"artifacts">,
  pageSize: number,
): Promise<void> {
  const deletedStorageIds = new Set<Id<"_storage">>();
  let hasMoreVersions = true;
  while (hasMoreVersions) {
    const versions = await ctx.db
      .query("artifactVersions")
      .withIndex("by_artifactId", (q) => q.eq("artifactId", artifactId))
      .take(pageSize);
    for (const version of versions) {
      if (version.htmlStorageId && !deletedStorageIds.has(version.htmlStorageId)) {
        await ctx.storage.delete(version.htmlStorageId);
        deletedStorageIds.add(version.htmlStorageId);
      }
      await ctx.db.delete(version._id);
    }
    hasMoreVersions = versions.length === pageSize;
  }
}
```

**Critical HTML-storage subtlety**: consecutive HTML versions can *share* the
same `htmlStorageId`. When an edit does not change the HTML, the storage id is
carried forward (`convex/lib/artifactWrites.ts:231`:
`htmlStorageId: args.htmlStorageId ?? previousHtml.htmlStorageId`). Therefore a
pruned version's storage blob must be deleted **only if no retained version
references that same `htmlStorageId`**. Deleting blindly would break a newer,
retained version's preview.

The `listByArtifact` cap you must stay consistent with
(`convex/artifactVersions.ts:8`): `const ARTIFACT_VERSION_LIST_LIMIT = 50;`.

## Commands you will need

| Purpose          | Command                                             | Expected on success |
|------------------|-----------------------------------------------------|---------------------|
| Typecheck (app)  | `bun run typecheck`                                 | exit 0, no errors   |
| Typecheck convex | `bun run typecheck:convex`                           | exit 0, no errors   |
| Lint             | `bun run lint`                                       | exit 0              |
| Tests (focused)  | `bun run test -- artifactWrites artifactVersions artifactStore` | all pass |
| Tests (full)     | `bun run test`                                       | all pass            |
| Format           | `bun run format`                                     | writes, exit 0      |

(Exact commands from `package.json`, verified during recon. `bun run lint` runs
both typechecks then eslint.)

## Scope

**In scope** (the only files you should modify):
- `convex/lib/artifactWrites.ts`
- `convex/lib/artifactWrites.test.ts` (create if absent — see Test plan)

**Out of scope** (do NOT touch, even though they look related):
- `convex/schema.ts` — no new index or field is required; the existing
  `by_artifactId` index supports pruning.
- `convex/artifactVersions.ts` — the read-side cap stays at 50; do not change it.
- `convex/artifactHtml.ts`, `convex/libraryArtifactDrafts.ts`,
  `convex/artifactStore.ts` — callers; their behavior must not change.
- The public/return shape of `updateArtifactWrite` and `createArtifactWrite` —
  callers depend on `{ updated, reason? }` / `Id<"artifacts">`.

## Git workflow

- Branch: `advisor/006-bound-artifact-version-history`
- Commit per logical unit; message style matches `git log` (imperative, capitalized,
  no trailing period — e.g. "Bound artifact version history with retention cap").
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the retention constant and a prune helper

In `convex/lib/artifactWrites.ts`, add a module-level constant near the top
(after the imports / type aliases):

```ts
// Keep at least the most-recent versions surfaced by the version-history UI
// (artifactVersions.ts ARTIFACT_VERSION_LIST_LIMIT). Older versions are never
// read by any query, so prune them on write to bound table growth.
const MAX_ARTIFACT_VERSIONS = 50;
```

Add a new private helper `pruneArtifactVersions(ctx, artifact)` that:

1. Loads all versions for the artifact via the `by_artifactId_and_version` index
   in **descending** version order (`.order("desc")`), using paged `.take()` like
   `deleteArtifactVersionsAndHtmlStorage` does, OR `.collect()` only if you first
   confirm it cannot exceed a few thousand rows — prefer the paged approach for
   safety. You need the full set to compute which storage ids are retained.
2. Partitions versions into **retained** (the newest `MAX_ARTIFACT_VERSIONS`) and
   **prunable** (the rest).
3. Builds a `Set<Id<"_storage">>` of every `htmlStorageId` referenced by a
   **retained** version. Also always treat `artifact.currentVersionId`'s row as
   retained — it is always within the newest 50 because it is the latest version,
   but assert it defensively: never delete the row whose `_id === artifact.currentVersionId`.
4. For each prunable version: if it has an `htmlStorageId` that is **not** in the
   retained set and has not already been deleted in this pass, `ctx.storage.delete`
   it (tracking deleted ids in a local `Set` to avoid double-deletes); then
   `ctx.db.delete(version._id)`.

The target shape:

```ts
async function pruneArtifactVersions(ctx: MutationCtx, artifact: Doc<"artifacts">): Promise<void> {
  const versions = await ctx.db
    .query("artifactVersions")
    .withIndex("by_artifactId_and_version", (q) => q.eq("artifactId", artifact._id))
    .order("desc")
    .collect();
  if (versions.length <= MAX_ARTIFACT_VERSIONS) {
    return;
  }
  const retained = versions.slice(0, MAX_ARTIFACT_VERSIONS);
  const prunable = versions.slice(MAX_ARTIFACT_VERSIONS);
  const retainedStorageIds = new Set<Id<"_storage">>();
  for (const version of retained) {
    if (version.htmlStorageId) {
      retainedStorageIds.add(version.htmlStorageId);
    }
  }
  const deletedStorageIds = new Set<Id<"_storage">>();
  for (const version of prunable) {
    if (version._id === artifact.currentVersionId) {
      continue; // never prune the current version
    }
    if (
      version.htmlStorageId &&
      !retainedStorageIds.has(version.htmlStorageId) &&
      !deletedStorageIds.has(version.htmlStorageId)
    ) {
      await ctx.storage.delete(version.htmlStorageId);
      deletedStorageIds.add(version.htmlStorageId);
    }
    await ctx.db.delete(version._id);
  }
}
```

> Note on `.collect()`: it is acceptable here because the table for a single
> artifact is exactly what this plan is bounding — after the first run it stays
> ≤ `MAX_ARTIFACT_VERSIONS + 1`. If you are uncertain about an artifact that has
> already grown very large, the `.collect()` still completes (Convex reads are
> paginated internally); the only risk is a one-time large read on the first
> prune. That is acceptable and self-correcting.

**Verify**: `bun run typecheck:convex` → exit 0, no errors.

### Step 2: Call the prune helper after a new version is created in `updateArtifactWrite`

In `updateArtifactWrite`, after `await ctx.db.patch(args.artifactId, patch);`
(currently `convex/lib/artifactWrites.ts:244`), and only when a new version was
created (i.e. inside the `if (changed)` block, after the patch, guarded so it
only runs when `patch.version !== undefined`), reload or reuse the artifact with
the updated `currentVersionId` and call `pruneArtifactVersions`.

Because `patch` set `currentVersionId` to the new version id, pass an artifact
object that reflects it. Simplest correct approach: after the patch, re-`get`
the artifact (it is cheap and guarantees `currentVersionId` is current), then
prune:

```ts
    patch.updatedAt = Date.now();
    await ctx.db.patch(args.artifactId, patch);
    if (patch.version !== undefined) {
      const updated = await ctx.db.get(args.artifactId);
      if (updated) {
        await pruneArtifactVersions(ctx, updated);
      }
    }
    await scheduleArtifactReindex(ctx, { /* unchanged */ });
```

Do **not** prune in `createArtifactWrite` — it only ever creates version 1, so
there is nothing to prune.

**Verify**: `bun run typecheck:convex` → exit 0, no errors.

### Step 3: Write tests (see Test plan), then run the focused suite

**Verify**: `bun run test -- artifactWrites artifactVersions artifactStore` →
all pass, including the new tests.

### Step 4: Full gates

**Verify**: run in order, each exit 0 / all pass:
- `bun run format`
- `bun run lint`
- `bun run test`

## Test plan

Create `convex/lib/artifactWrites.test.ts` (a new file is appropriate — there is
no existing test file for this module). Model its harness usage on
`convex/artifactStore.test.ts` (which drives `internal.artifactStore.updateArtifact`,
the thin wrapper over `updateArtifactWrite` at `convex/artifactStore.ts:128`).
Use `internal.artifactStore.createArtifact` + repeated
`internal.artifactStore.updateArtifact` to exercise the real write path, and
`t.run(async (ctx) => …)` to count `artifactVersions` rows directly via the
`by_artifactId` index.

Cases to cover:

1. **Caps at the retention limit.** Create an artifact, then call `updateArtifact`
   enough times to create ≥ 60 versions total (e.g. 65 distinct title edits).
   Assert: the count of `artifactVersions` rows for that artifact equals
   `MAX_ARTIFACT_VERSIONS` (50); the current artifact `version` is 65; the row
   whose `version === 65` exists; the oldest surviving row has `version === 16`
   (i.e. `65 - 50 + 1`).
2. **Current version is never pruned.** After the loop above, fetch the artifact
   and assert `currentVersionId` still resolves to an existing `artifactVersions`
   row (`await ctx.db.get(artifact.currentVersionId)` is non-null) and its
   `version` equals the artifact's `version`.
3. **Shared HTML storage blobs are not deleted while still referenced.** Seed an
   artifact and version rows directly via `t.run` so that several of the newest
   (retained) versions share one `htmlStorageId` (call it `S_keep`) and an
   older, prunable version references a *different* `htmlStorageId` (`S_drop`)
   that no retained version uses. Trigger a prune by performing one more
   `updateArtifact`. Assert (via a spy/stub or by checking storage): `S_drop`
   was deleted and `S_keep` was **not**. If stubbing `ctx.storage.delete` is
   awkward in the test harness, instead assert behavior indirectly: after prune,
   the retained versions' `htmlStorageId` values still resolve, and the dropped
   version row is gone. **If you cannot reliably observe `ctx.storage.delete`
   calls in this harness, STOP and report** — do not weaken the test to a
   no-op assertion.
4. **No-op below the cap.** An artifact with < 50 versions is untouched by prune
   (row count unchanged after an update that creates version 3).

Also confirm the existing `convex/artifactStore.test.ts` "updateArtifact bumps
the version monotonically" test still passes unchanged.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun run typecheck:convex` exits 0
- [ ] `bun run lint` exits 0
- [ ] `bun run test` passes; `convex/lib/artifactWrites.test.ts` exists with the 4
      cases above and passes
- [ ] `grep -n "MAX_ARTIFACT_VERSIONS" convex/lib/artifactWrites.ts` returns the
      constant definition and at least one use
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row for 006 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at `convex/lib/artifactWrites.ts:211-244` does not match the
  "Current state" excerpt (the file has drifted since this plan was written).
- You cannot observe `ctx.storage.delete` behavior in the test harness well
  enough to prove the shared-storage case (Test plan case 3) — report rather
  than ship a hollow test.
- Pruning appears to require a schema/index change to perform acceptably — report
  the query you intended and why the existing `by_artifactId_and_version` index
  is insufficient.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

For the human/agent who owns this code after the change lands:

- The retention cap (`MAX_ARTIFACT_VERSIONS`, 50) is deliberately kept equal to
  `ARTIFACT_VERSION_LIST_LIMIT` in `convex/artifactVersions.ts`. If the listing
  limit is ever raised, raise the retention cap to match (or above) so the UI's
  history list is never truncated by pruning.
- HTML storage blobs are shared across consecutive unchanged-HTML versions. Any
  future code that deletes version rows MUST keep the "only delete a blob no
  retained version references" rule, or it will break a live preview. This rule
  also lives in `deleteArtifactVersionsAndHtmlStorage` (within-batch dedup only).
- If "version restore" (plan 010) lands, restoring writes a *new* version; a
  restored-from version older than the cap may already be pruned. That is
  expected — restore reads the currently-selected version, which is always within
  the retained window in the UI.
- Reviewer should scrutinize: that prune runs only when a new version was created
  (guarded by `patch.version !== undefined`), and that `currentVersionId` is never
  among the deleted rows.
