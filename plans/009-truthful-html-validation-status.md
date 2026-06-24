# Plan 009: Make `htmlValidationStatus` reflect real validation state

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat c7b6aac..HEAD -- convex/lib/artifactWrites.ts`
> If the in-scope file changed since this plan was written, compare the
> "Current state" excerpt against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug / tech-debt
- **Planned at**: commit `c7b6aac`, 2026-06-24

## Why this matters

`createArtifactVersionWrite` hardcodes `htmlValidationStatus` to `"valid"` for
every HTML version (`convex/lib/artifactWrites.ts:286`), independent of whether
`htmlValidationErrors` is non-empty. The field can therefore never represent
`"invalid"`, and nothing in the codebase currently reads it (verified:
`grep -rn "htmlValidationStatus" convex/ src/` returns only the schema
definition and this single write). It is a write-only field that lies — a latent
trap for any future feature (a freshness badge, an "invalid report" warning) that
trusts it. This makes the stored status consistent with the stored errors, so the
field becomes safe to rely on.

## Current state

- `convex/lib/artifactWrites.ts:283-287` — the offending write:

  ```ts
    htmlStorageId: args.renderFormat === "html" ? args.htmlStorageId : undefined,
    htmlHash: args.renderFormat === "html" ? args.htmlHash : undefined,
    htmlByteLength: args.renderFormat === "html" ? args.htmlByteLength : undefined,
    htmlValidationStatus: args.renderFormat === "html" ? "valid" : undefined,
    htmlValidationErrors: args.htmlValidationErrors,
  ```

  `args.htmlValidationErrors` is an optional `string[]`. The status should be
  derived from it: `"invalid"` when there are errors, `"valid"` when there are
  none, `undefined` for non-HTML.

- `convex/schema.ts:152` — `htmlValidationStatus = v.union(v.literal("valid"), v.literal("invalid"))`,
  used as `v.optional(htmlValidationStatus)` on the `artifactVersions` table
  (`convex/schema.ts:630`). The `"invalid"` literal already exists in the schema
  but is never written today.

- `createArtifactVersionWrite` is called from two places, both in
  `convex/lib/artifactWrites.ts`:
  - `createArtifactWrite` (line 108) — passes `htmlValidationErrors: args.renderFormat === "html" ? args.htmlValidationErrors : undefined` (line 120).
  - `updateArtifactWrite` (line 222) — passes `htmlValidationErrors: args.htmlValidationErrors ?? previousHtml.htmlValidationErrors` (line 234).

Repo conventions: small typed helpers, no `any`. Match existing ternary style.

## Commands you will need

| Purpose   | Command                                        | Expected on success |
|-----------|------------------------------------------------|---------------------|
| Convex TC | `bun run typecheck:convex`                     | exit 0              |
| Typecheck | `bun run typecheck`                            | exit 0              |
| Lint      | `bun run lint`                                 | exit 0, 0 warnings  |
| Tests     | `bun run test -- artifactWrites artifactStore artifactVersions` | all pass |
| Format    | `bun run format`                               | rewrites, exit 0    |

## Scope

**In scope** (the only files you should modify):
- `convex/lib/artifactWrites.ts` — derive `htmlValidationStatus` from `htmlValidationErrors` in `createArtifactVersionWrite`.
- The test file covering version writes (likely `convex/artifactStore.test.ts` or `convex/artifactVersions.test.ts`) — add an assertion.

**Out of scope** (do NOT touch):
- `convex/schema.ts` — the `"valid" | "invalid"` union is already correct.
- Do NOT remove the field. Removing `htmlValidationStatus` from the schema would
  fail the Convex schema push because existing `artifactVersions` rows still
  carry it; that path requires a data migration and is explicitly out of scope
  (see Maintenance notes).
- Any reader of the field (there are none today) and any UI.

## Git workflow

- Branch: `advisor/009-truthful-html-validation-status`
- One commit; imperative message matching `git log` (e.g. "Derive html validation status from errors").
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Derive the status from the errors

In `convex/lib/artifactWrites.ts`, in `createArtifactVersionWrite`, replace the
hardcoded line 286 so the status is computed:

```ts
    htmlValidationStatus:
      args.renderFormat === "html"
        ? args.htmlValidationErrors && args.htmlValidationErrors.length > 0
          ? "invalid"
          : "valid"
        : undefined,
```

Leave `htmlValidationErrors: args.htmlValidationErrors` (line 287) unchanged.

**Verify**: `bun run typecheck:convex` → exit 0; `bun run lint` → exit 0.

### Step 2: Add a regression test, format, full gate

Add a test (see Test plan), run `bun run format`, then the full gate.

**Verify**: all "Commands you will need" pass.

## Test plan

In the version-write test file (model after existing `convexTest` usage in
`convex/artifactVersions.test.ts`), add cases asserting:

1. An HTML artifact version created with **no** `htmlValidationErrors` (or an
   empty array) has `htmlValidationStatus === "valid"`.
2. An HTML artifact version created **with** a non-empty `htmlValidationErrors`
   array has `htmlValidationStatus === "invalid"`. (Construct this by calling the
   create/update write path with `renderFormat: "html"` and a non-empty
   `htmlValidationErrors`.)
3. A non-HTML (markdown) version has `htmlValidationStatus === undefined`.

If the create/update write helpers are only reachable through higher-level
mutations in tests, drive them the same way the existing version tests do; assert
on the stored `artifactVersions` row via `ctx.db`.

Verification: `bun run test -- artifactWrites artifactStore artifactVersions` →
all pass, including the new assertions.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` and `bun run typecheck:convex` exit 0
- [ ] `bun run lint` exits 0, 0 warnings
- [ ] `bun run test` exits 0; new assertions for valid/invalid/undefined exist and pass
- [ ] `grep -n '"invalid"' convex/lib/artifactWrites.ts` shows the new branch
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row for 009 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpt at `convex/lib/artifactWrites.ts:283-287` no longer matches the
  live code.
- You find that something now **reads** `htmlValidationStatus` and depends on it
  always being `"valid"` (re-run `grep -rn "htmlValidationStatus" convex/ src/`).
  If a reader exists and assumes the old behavior, report it before changing the
  write.

## Maintenance notes

- Alternative considered: deleting the field entirely. Rejected for this plan
  because existing `artifactVersions` documents already store
  `htmlValidationStatus`, so removing it from the schema would fail the Convex
  schema push until a migration clears it from every row. Making the field
  truthful is lower-risk and leaves it usable. If the product decides the field
  is genuinely unnecessary, the clean path is a `@convex-dev/migrations` job that
  unsets the field on all rows, then a schema change — a separate plan.
- A reviewer should confirm no current reader assumed the field was always
  `"valid"` (there were none at planning time).
- Once this lands, a future "invalid HTML report" warning badge can trust
  `htmlValidationStatus` directly.
