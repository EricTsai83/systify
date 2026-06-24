# Plan 010: Restore an artifact to a previous version

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. This plan has product-owned decision points marked
> **DECISION** — resolve each per its stated default unless the operator told you
> otherwise; if a DECISION genuinely blocks you, STOP and report. When done,
> update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat c7b6aac..HEAD -- convex/artifacts.ts convex/lib/artifactWrites.ts convex/artifactVersions.ts src/components/library-editor.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (interacts with plan 006 — see "Why" and Maintenance)
- **Category**: direction (feature) — implemented as a scoped feature plan
- **Planned at**: commit `c7b6aac`, 2026-06-24

## Why this matters

The artifact version-history feature is read-only-asymmetric: the data model and
read path are fully built — `artifactVersions` stores every version,
`api.artifactVersions.listByArtifact` and `api.artifactVersions.getVersion`
expose them, and the editor already lets a user *select and view* a historical
version (`src/components/library-editor.tsx:60-67,127-147`). But there is no way
to **restore** a past version: the user can look at v12 but cannot make it the
current content again. That is the natural completion of what shipped — and it is
cheap, because restore is just "write the selected version's content as a new
current version" through the existing `updateArtifactWrite` path (which already
creates a new version row and bumps `currentVersionId`). Restoring forward (new
version) rather than mutating history keeps the audit trail intact and composes
cleanly with plan 006's retention cap.

This plan delivers a working restore end to end. It is small, but it has two
product-owned decisions (confirm UX, and whether HTML artifacts are in scope for
v1) flagged below.

## Design summary

- **Restore = forward write.** Restoring version N reads version N's content and
  calls `updateArtifactWrite` to create version `current+1` with that content.
  History is never rewritten or deleted.
- **Markdown first.** Markdown artifacts copy `contentMarkdown`, `title`,
  `summary`. **DECISION (HTML scope)**: HTML artifacts carry an `htmlStorageId`
  (a stored blob). *Default for v1: restrict restore to markdown
  (`renderFormat === "markdown"`) artifacts/versions and surface no restore
  affordance for HTML.* Restoring HTML requires re-pointing `htmlStorageId` and
  the HTML metadata, which is feasible but adds blob-lifecycle considerations
  (the same blob would be referenced by two versions — supported, but out of
  scope for the first cut). If the operator wants HTML restore in v1, STOP and
  request the expanded scope.
- **Ownership + active repo.** The mutation enforces the same checks as peer
  mutations (`requireOwnedDoc`, and `requireActiveRepositoryForViewer` when the
  artifact belongs to a repository), matching `convex/artifacts.ts` conventions.

## Current state

### Backend

`convex/artifacts.ts` holds the public artifact mutations. The `rename` mutation
is the exemplar to follow for a new ownership-checked mutation that writes via
`updateArtifactWrite` (`convex/artifacts.ts:261-292`):

```ts
export const rename = mutation({
  args: { artifactId: v.id("artifacts"), title: v.string() },
  handler: async (ctx, args) => {
    const { doc: artifact } = await requireOwnedDoc(ctx, args.artifactId, {
      notFoundMessage: "Artifact not found.",
    });
    // ...validation...
    await updateArtifactWrite(ctx, { artifactId: artifact._id, title: trimmed });
    return null;
  },
});
```

`updateArtifactWrite` (`convex/lib/artifactWrites.ts:131-251`) accepts
`{ artifactId, title?, summary?, contentMarkdown?, expectedVersion?, ... }`,
creates a new version row, and returns `{ updated, reason? }` where `reason` is
`"version_mismatch"` when `expectedVersion` does not match the live version.

The version read query `api.artifactVersions.getVersion`
(`convex/artifactVersions.ts:26-45`) returns the full `artifactVersions` row
(including `contentMarkdown`, `renderFormat`, `title`, `summary`) after an
ownership check, or `null`.

Look for whether repository-scoped artifact mutations call a viewer/active-repo
guard. Search the codebase for `requireActiveRepositoryForViewer` (used in
`convex/libraryArtifactDrafts.ts`); apply the same guard here **only when**
`artifact.repositoryId` is set (thread-only artifacts have no repository). If the
peer mutations `rename`/`moveToFolder` do **not** call it, match their lighter
convention instead and note that in the PR — do not invent a stricter gate than
the surrounding code uses. **DECISION (gate parity)**: default to matching
`rename`'s exact guard set.

### Frontend

`src/components/library-editor.tsx` already computes the viewing state
(`src/components/library-editor.tsx:127-147`):

```tsx
  const displayedVersion = selectedVersion ?? artifact.version;
  const isHistoricalVersion = displayedVersion !== artifact.version;
  const displayedArtifact = isHistoricalVersion ? historicalVersion : artifact;
  // ...
  <ArtifactVersionSelect
    versions={versions}
    currentVersion={artifact.version}
    selectedVersion={displayedVersion}
    onChange={(version) => setSelectedVersion(version === artifact.version ? null : version)}
  />
```

When `isHistoricalVersion` is true and `displayedArtifact` is loaded, the editor
is showing an older version — that is exactly where a "Restore this version"
action belongs. The editor uses `useAsyncCallback` (`@/hooks/use-async-callback`)
for async actions, `toast` from `sonner` for feedback, and `Button` from
`@/components/ui/button`.

## Commands you will need

| Purpose          | Command                                                  | Expected on success |
|------------------|----------------------------------------------------------|---------------------|
| Typecheck        | `bun run typecheck`                                      | exit 0, no errors   |
| Typecheck convex | `bun run typecheck:convex`                               | exit 0, no errors   |
| Lint             | `bun run lint`                                           | exit 0              |
| Tests (focused)  | `bun run test -- artifacts library-editor artifactVersions` | all pass        |
| Tests (full)     | `bun run test`                                           | all pass            |
| Format           | `bun run format`                                         | writes, exit 0      |

## Scope

**In scope** (the only files you should modify):
- `convex/artifacts.ts` (add the `restoreVersion` mutation)
- `convex/artifacts.test.ts` (extend — confirm it exists; if the artifact mutation
  tests live in `convex/repositories*.test.ts` or `artifactStore.test.ts`, add to
  the closest existing artifact-mutation test file and say which in the PR)
- `src/components/library-editor.tsx` (add the restore affordance)
- `src/components/library-editor.test.tsx` (extend)

**Out of scope** (do NOT touch):
- `convex/lib/artifactWrites.ts` — `updateArtifactWrite` already does everything
  needed; do not change it.
- HTML-artifact restore (deferred — see DECISION above).
- `convex/schema.ts` — no schema change.
- The version-list/read queries — they already return what restore needs.

## Git workflow

- Branch: `advisor/010-restore-artifact-version`
- Commit per logical unit (backend mutation, then frontend); message style matches
  `git log` (imperative, capitalized, no trailing period — e.g. "Add artifact
  version restore mutation").
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the `restoreVersion` mutation in `convex/artifacts.ts`

Add a public mutation that restores a markdown artifact to a chosen version.
Shape:

```ts
export const restoreVersion = mutation({
  args: {
    artifactId: v.id("artifacts"),
    version: v.number(),
    expectedVersion: v.number(), // the current version the client believes is live
  },
  handler: async (ctx, args) => {
    const { doc: artifact } = await requireOwnedDoc(ctx, args.artifactId, {
      notFoundMessage: "Artifact not found.",
    });
    // Match rename/moveToFolder's guard set (see DECISION: gate parity).
    // If repositoryId is set and peers guard active-repo, do the same here.

    if (artifact.version === args.version) {
      return null; // already current; nothing to restore
    }

    const source = await ctx.db
      .query("artifactVersions")
      .withIndex("by_artifactId_and_version", (q) =>
        q.eq("artifactId", artifact._id).eq("version", args.version),
      )
      .unique();
    if (!source || source.ownerTokenIdentifier !== artifact.ownerTokenIdentifier) {
      throw new ConvexError({ code: "VERSION_NOT_FOUND", message: "That version is no longer available." });
    }
    if (source.renderFormat !== "markdown" || artifact.renderFormat !== "markdown") {
      throw new ConvexError({ code: "RESTORE_UNSUPPORTED", message: "Only markdown artifacts can be restored." });
    }

    const result = await updateArtifactWrite(ctx, {
      artifactId: artifact._id,
      title: source.title,
      summary: source.summary,
      contentMarkdown: source.contentMarkdown,
      renderFormat: "markdown",
      expectedVersion: args.expectedVersion,
    });
    if (!result.updated && result.reason === "version_mismatch") {
      throw new ConvexError({
        code: "ARTIFACT_VERSION_MISMATCH",
        message: "This artifact changed since you opened it. Reload and try again.",
      });
    }
    return null;
  },
});
```

Notes:
- Reuse the existing `ConvexError` import already present in `convex/artifacts.ts`.
- The `expectedVersion` arg gives optimistic-concurrency safety identical to the
  draft-apply path (`convex/libraryArtifactDrafts.ts:349-354`): if the artifact
  changed between the user opening it and clicking restore, the write is rejected
  rather than clobbering a newer edit.
- Reading the source version by index mirrors `artifactVersions.getVersion`
  (`convex/artifactVersions.ts:36-43`).

**Verify**: `bun run typecheck:convex` → exit 0, no errors.

### Step 2: Backend tests

Add tests (see Scope for file choice) covering:
1. **Restore creates a new current version with the old content.** Create an
   artifact, edit it twice (v1→v3 via `internal.artifactStore.updateArtifact` or
   the public edit path), then call `api.artifacts.restoreVersion` with
   `version: 1`, `expectedVersion: 3`. Assert the artifact's `version` is now 4,
   its `contentMarkdown`/`title`/`summary` equal v1's, and a v4 row exists in
   `artifactVersions`. History (v1–v3) is unchanged.
2. **Version mismatch is rejected.** Call restore with a stale `expectedVersion`
   and assert it throws `ARTIFACT_VERSION_MISMATCH`.
3. **Unknown/foreign version rejected.** Restore a non-existent version → throws
   `VERSION_NOT_FOUND`; an artifact owned by another token → `requireOwnedDoc`
   rejects.
4. **HTML artifact rejected.** A `renderFormat: "html"` artifact → throws
   `RESTORE_UNSUPPORTED`.
5. **No-op when version already current.** `version === artifact.version` returns
   without creating a new version.

Model harness usage on `convex/artifactStore.test.ts` (uses `createTestConvex`,
`t.mutation`, `t.withIdentity`, `t.run`).

**Verify**: `bun run test -- artifacts artifactVersions` → all pass.

### Step 3: Add the restore affordance in `library-editor.tsx`

When `isHistoricalVersion` is true and `displayedArtifact` is loaded and its
`renderFormat` is markdown, render a "Restore this version" `Button` near the
version select (`src/components/library-editor.tsx:143-147` region). Wire it to a
`useAsyncCallback` that calls `api.artifacts.restoreVersion` via `useMutation`
with `{ artifactId, version: displayedVersion, expectedVersion: artifact.version }`,
then on success resets `setSelectedVersion(null)` (so the editor snaps back to the
now-current version) and shows `toast.success("Restored to version N.")`. On
error, surface `toUserErrorMessage(error)` via `toast.error` (the component
already imports `toUserErrorMessage` and `toast`).

**DECISION (confirm UX)**: restore overwrites the visible "current" content with
older content (recoverable, since it writes forward and history is kept).
*Default: no modal; a single click restores, with a toast and the ability to
restore again.* If the operator wants a confirm dialog, add one using the repo's
existing dialog primitives — but do not block on it; the default is no dialog.

Do **not** show the restore button for HTML artifacts (DECISION: HTML scope).
Gate on the displayed render format being markdown.

**Verify**: `bun run typecheck` → exit 0, no errors.

### Step 4: Frontend test

In `src/components/library-editor.test.tsx`, add a test that: renders the editor
with multiple versions, selects an older markdown version, asserts the "Restore
this version" button appears, clicking it calls the `restoreVersion` mutation with
the expected args, and on success the selection resets. Follow the file's existing
mocking of Convex hooks/queries. Also assert the button is **absent** for an HTML
artifact.

**Verify**: `bun run test -- library-editor` → all pass.

### Step 5: Full gates

**Verify**: run in order, each exit 0 / all pass:
- `bun run format`
- `bun run lint`
- `bun run test`

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun run typecheck:convex` exits 0
- [ ] `bun run lint` exits 0
- [ ] `bun run test` passes; backend tests (5 cases) and frontend tests (restore
      visible+works for markdown, absent for HTML) exist and pass
- [ ] `grep -n "restoreVersion" convex/artifacts.ts src/components/library-editor.tsx`
      returns matches in both files
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row for 010 updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any "Current state" excerpt does not match the live code (drift).
- The operator requires HTML-artifact restore in v1 (expanded scope — blob
  lifecycle), or requires a confirm dialog you are unsure how to build with the
  repo's primitives.
- Peer artifact mutations (`rename`, `moveToFolder`) use a different ownership /
  active-repo guard than this plan assumes — match theirs and report the
  difference rather than guessing.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- Restore writes **forward** (new version), so it composes with plan 006's
  retention cap: an artifact restored from a version that has since been pruned
  still works, because the UI only offers restore for versions currently in the
  listing window (which are within the retained set).
- HTML restore is the deferred follow-up: it must point the new version's
  `htmlStorageId` at the source version's blob (a blob shared by two versions) and
  carry `htmlHash`/`htmlByteLength`/`htmlValidationErrors`. Plan 006's pruning
  already handles shared-blob retention, so the pieces exist — it was deferred
  only to keep this plan small.
- Reviewer should scrutinize: the `expectedVersion` optimistic-concurrency check
  (prevents clobbering a concurrent edit) and that ownership/active-repo guards
  match the peer mutations exactly.
