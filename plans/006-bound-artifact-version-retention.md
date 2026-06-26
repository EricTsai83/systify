# Plan 006: Prune stored artifact version history and orphaned HTML blobs

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 86121ff..HEAD -- convex/lib/artifactWrites.ts convex/artifactVersions.ts convex/schema.ts convex/artifactStore.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: perf / tech-debt
- **Planned at**: commit `86121ff`, refreshed 2026-06-27
- **Prior implementation**: commit `e9b6bc2` on branch `worktree-agent-a363a7c418dc16742` was reviewed and approved before the artifact `summary` field was renamed to `description`, and it is not merged into the current branch. Reuse it only by rebasing or manually reapplying the approach against the current `description` API, and confirm it preserves the already-merged folder-kind index lookup and truthful `htmlValidationStatus` changes.

## Why this matters

Every edit or regeneration of an artifact inserts a brand-new row into the
`artifactVersions` table (`convex/lib/artifactWrites.ts:222`), and for HTML
artifacts it also stores a fresh HTML blob in Convex `_storage`. Nothing ever
removes these except deleting the whole artifact. The recent "Bound artifact
versions" commit (`4503648`) capped only the **read** list to the latest 50
(`convex/artifactVersions.ts:8`) — stored rows and HTML blobs still grow without
bound. Versions past the 50th become unreachable in the UI yet keep consuming
storage forever. This is a slow, unbounded storage/DB leak on a core write path.

The repo already establishes a retention convention elsewhere
(`convex/daytonaWebhooks.ts:10` `DAYTONA_WEBHOOK_RETENTION_MS`,
`convex/chat/sandboxToolCallLog.ts:81` `SANDBOX_TOOL_CALL_LOG_RETENTION_MS`).
This plan applies the same idea: keep the most recent N versions per artifact,
prune the rest, and delete each pruned version's HTML blob **only if no retained
version still references it** (versions share a blob when the HTML is unchanged
across an update — see the `?? previousHtml.htmlStorageId` reuse at
`convex/lib/artifactWrites.ts:231`).

## Current state

- `convex/lib/artifactWrites.ts` — all artifact version writes/deletes live here.
  - `updateArtifactWrite` (lines 131–251): on any content/metadata change it
    computes `nextVersion = artifact.version + 1` (line 219), inserts a new
    version via `createArtifactVersionWrite` (line 222), then patches the
    artifact with `version` + `currentVersionId` and calls `ctx.db.patch` (line
    244). **No pruning happens.** This is where pruning must be invoked.
  - `createArtifactVersionWrite` (lines 253–298): inserts one `artifactVersions`
    row. For HTML it stores `htmlStorageId` (line 283) and now derives
    `htmlValidationStatus` from validation errors (lines 286–291). Do not
    regress that 009 change.
  - `deleteArtifactVersionsAndHtmlStorage` (lines 365–386): the existing
    full-artifact cleanup. It pages through ALL versions of an artifact and
    deletes each blob once, deduping within the delete set via a
    `Set<Id<"_storage">>` (line 370). **Use this as the structural pattern** for
    blob-dedup, but note the key difference for pruning below.
  - HTML blobs can be shared across versions: when an update doesn't change the
    HTML, the new version reuses the prior `htmlStorageId`
    (`?? previousHtml.htmlStorageId`, line 231). Therefore pruning an old version
    must NOT delete its blob if a **retained** (surviving) version still points
    at the same `htmlStorageId`.
- `convex/artifactVersions.ts:8` — `ARTIFACT_VERSION_LIST_LIMIT = 50`, the read
  cap. Keep the retention cap consistent with (>= ) this so nothing listable is
  pruned.
- `convex/schema.ts:619-639` — `artifactVersions` table. Existing indexes:
  `by_artifactId` (line 637) and `by_artifactId_and_version` (line 638). Use
  `by_artifactId_and_version` for ranged pruning — no new index needed.
- `convex/schema.ts:610` already includes the 008 index
  `by_repositoryId_and_folderId_and_kind`; leave it in place.

Excerpt — the write path to instrument (`convex/lib/artifactWrites.ts:240-244`):

```ts
      patch.version = nextVersion;
      patch.currentVersionId = versionId;
    }
    patch.updatedAt = Date.now();
    await ctx.db.patch(args.artifactId, patch);
    await scheduleArtifactReindex(ctx, {
      artifactId: args.artifactId,
      repositoryId: args.contentMarkdown !== undefined ? artifact.repositoryId : undefined,
    });
```

Excerpt — existing blob-dedup pattern to mirror (`convex/lib/artifactWrites.ts:365-386`):

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

Repo conventions: Convex mutations are transactional per call — pruning inside
`updateArtifactWrite` runs in the same transaction as the version insert, so
readers never observe a partially-pruned state. Match the existing helper style
(small `async function` helpers, typed `MutationCtx`, no `any`). Storage
deletes use `ctx.storage.delete(id)`.

## Commands you will need

| Purpose   | Command                                          | Expected on success |
|-----------|--------------------------------------------------|---------------------|
| Typecheck | `bun run typecheck`                              | exit 0, no errors   |
| Convex TC | `bun run typecheck:convex`                       | exit 0, no errors   |
| Lint      | `bun run lint`                                   | exit 0, 0 warnings  |
| Tests     | `bun run test -- artifactWrites`                 | all pass            |
| Tests     | `bun run test -- artifactVersions`               | all pass            |
| Format    | `bun run format`                                 | rewrites, exit 0    |

(Exact commands from this repo's `package.json` and `AGENTS.md`. Do not run dev
servers or builds.)

## Scope

**In scope** (the only files you should modify):
- `convex/lib/artifactWrites.ts` — add the prune helper + a constant, call it from `updateArtifactWrite`.
- `convex/artifactStore.test.ts` — add pruning tests beside the existing artifact-write / generated-replacement coverage.

**Out of scope** (do NOT touch, even though they look related):
- `convex/artifactVersions.ts` — the read cap is already correct; do not change the listing query.
- `deleteArtifactVersionsAndHtmlStorage` and `deleteArtifactWrite` — full-artifact deletion already works; do not alter it.
- The artifact `schema.ts` indexes — `by_artifactId_and_version` is sufficient; do NOT add an index.
- Any change to `currentVersionId` semantics or the version-numbering scheme.
- The 008 `findArtifactInFolderByKind` indexed lookup and 009
  `htmlValidationStatus` derivation — preserve both.

## Git workflow

- Branch: `advisor/006-bound-artifact-version-retention`
- Commit per logical unit; message style matches `git log` (imperative, capitalized, e.g. "Prune stored artifact version history"). End the commit body with the repo's trailer if one is in use.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the retention constant and prune helper

In `convex/lib/artifactWrites.ts`, add near the top (after the type aliases):

```ts
// Keep at least the read cap (ARTIFACT_VERSION_LIST_LIMIT = 50 in
// artifactVersions.ts) so nothing that is listable in the UI is ever pruned.
const MAX_ARTIFACT_VERSIONS = 50;
```

Then add a helper. The contract: keep the newest `MAX_ARTIFACT_VERSIONS`
versions of `artifactId`; delete older ones; delete a pruned version's HTML blob
**only if no retained version references the same `htmlStorageId`**.

```ts
async function pruneArtifactVersions(ctx: MutationCtx, artifactId: Id<"artifacts">, latestVersion: number): Promise<void> {
  const threshold = latestVersion - MAX_ARTIFACT_VERSIONS; // delete versions with version <= threshold
  if (threshold < 1) {
    return; // fewer than the cap exist; nothing to prune
  }

  // Storage ids still referenced by retained versions (version > threshold).
  // Retained set is bounded by MAX_ARTIFACT_VERSIONS rows.
  const retainedStorageIds = new Set<Id<"_storage">>();
  const retained = await ctx.db
    .query("artifactVersions")
    .withIndex("by_artifactId_and_version", (q) => q.eq("artifactId", artifactId).gt("version", threshold))
    .collect();
  for (const version of retained) {
    if (version.htmlStorageId) {
      retainedStorageIds.add(version.htmlStorageId);
    }
  }

  const deletedStorageIds = new Set<Id<"_storage">>();
  const PAGE_SIZE = 100;
  let hasMore = true;
  while (hasMore) {
    const stale = await ctx.db
      .query("artifactVersions")
      .withIndex("by_artifactId_and_version", (q) => q.eq("artifactId", artifactId).lte("version", threshold))
      .take(PAGE_SIZE);
    for (const version of stale) {
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
    hasMore = stale.length === PAGE_SIZE;
  }
}
```

Note: `retained` is at most `MAX_ARTIFACT_VERSIONS` rows because the only versions
with `version > threshold` are the newest cap-worth. `.collect()` here is bounded
and safe.

**Verify**: `bun run typecheck:convex` → exit 0.

### Step 2: Call the prune helper from `updateArtifactWrite`

In `updateArtifactWrite`, immediately after the artifact patch at
`convex/lib/artifactWrites.ts:244` (`await ctx.db.patch(args.artifactId, patch);`)
and before `scheduleArtifactReindex`, prune only when a new version was actually
created (i.e. `patch.version` was set):

```ts
    await ctx.db.patch(args.artifactId, patch);
    if (patch.version !== undefined) {
      await pruneArtifactVersions(ctx, args.artifactId, patch.version);
    }
    await scheduleArtifactReindex(ctx, {
      artifactId: args.artifactId,
      repositoryId: args.contentMarkdown !== undefined ? artifact.repositoryId : undefined,
    });
```

Do NOT prune in `createArtifactWrite` (it only ever creates version 1).

**Verify**: `bun run typecheck:convex` → exit 0. `bun run lint` → exit 0.

### Step 3: Tests (see Test plan), then format

Run `bun run format`, then the full gate.

**Verify**: all commands in "Commands you will need" pass.

## Test plan

Add tests in `convex/artifactStore.test.ts`, modeled after the existing
artifact-write tests in that file and the `convex-test` (`convexTest`) usage in
`convex/artifactVersions.test.ts` (it inserts versions 1..60 and asserts the
listing). Cover:

1. **Prunes beyond the cap**: create an artifact, then update it enough times to
   exceed `MAX_ARTIFACT_VERSIONS` (e.g. 55 updates). Assert that querying
   `artifactVersions` by `by_artifactId` returns exactly `MAX_ARTIFACT_VERSIONS`
   rows and that the **lowest** retained `version` is `latestVersion - MAX + 1`
   and the **current** version is present.
2. **No pruning under the cap**: fewer than `MAX_ARTIFACT_VERSIONS` updates →
   all versions retained, no deletes.
3. **Current version always survives**: after pruning, the artifact's
   `currentVersionId` still resolves (`ctx.db.get(currentVersionId)` is non-null)
   and its `version` equals the artifact's `version`.
4. **Shared HTML blob not deleted while still referenced**: create an HTML
   artifact, then perform updates that change only `title` (so the HTML blob is
   reused across versions via the `?? previousHtml.htmlStorageId` path) until
   pruning triggers. Assert the retained current version's `htmlStorageId` is
   still readable (the blob was NOT deleted). To assert storage state with
   `convex-test`, check that no retained version references a deleted blob — at
   minimum assert that the current version's `htmlStorageId` is defined and that
   `ctx.storage.getUrl(currentVersion.htmlStorageId)` does not throw / is
   non-null. If asserting storage deletion is impractical in `convex-test`,
   assert instead that the retained versions' `htmlStorageId` set is a subset of
   the storage ids that were created and never explicitly deleted, by tracking
   ids in the test.

Verification: `bun run test -- artifactWrites artifactVersions artifactStore` →
all pass, including the new pruning tests.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun run typecheck:convex` exits 0
- [ ] `bun run lint` exits 0, 0 warnings
- [ ] `bun run test` exits 0; new pruning tests exist and pass
- [ ] `grep -n "pruneArtifactVersions" convex/lib/artifactWrites.ts` shows the helper defined AND called from `updateArtifactWrite`
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row for 006 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at `convex/lib/artifactWrites.ts:219-244` no longer matches the
  "Current state" excerpts (the version-write path drifted).
- `by_artifactId_and_version` no longer exists in `convex/schema.ts` or no longer
  supports `.gt`/`.lte` on `version` (the ranged prune query depends on it).
- You discover any code path that fetches versions **older** than the read cap
  by version number and depends on them existing (search:
  `grep -rn "getVersion\|by_artifactId_and_version" convex/ src/`). If a feature
  relies on deep history, pruning would break it — STOP and report.
- A test's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- If `ARTIFACT_VERSION_LIST_LIMIT` in `convex/artifactVersions.ts` is ever
  raised above `MAX_ARTIFACT_VERSIONS`, the UI would list versions that pruning
  has deleted. Keep `MAX_ARTIFACT_VERSIONS >= ARTIFACT_VERSION_LIST_LIMIT`; a
  reviewer should check this invariant.
- A reviewer should scrutinize the shared-blob logic in step 1: deleting a blob
  that a retained version still references would break HTML preview for the
  current version. The `retainedStorageIds` guard is the safety mechanism.
- Deferred out of this plan: a one-time backfill mutation to prune history that
  already exceeds the cap on existing artifacts. This plan only bounds growth
  going forward. If existing bloat matters, a follow-up internal migration that
  walks `artifacts` and calls `pruneArtifactVersions` is the clean approach.
