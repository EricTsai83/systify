# Plan 005: Bound sandbox session cost summary reads

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report; do not improvise. When done, update the status row for this plan in `plans/README.md` unless a reviewer told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 962761d..HEAD -- convex/_generated/ai/guidelines.md convex/sandboxSessions.ts convex/sandboxSessions.test.ts`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW/MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `962761d`, 2026-06-13

## Why this matters

`getSandboxSessionCostSummary` is a frontend-facing query used to show current sandbox session and daily spend. It currently collects every sandbox session ever created for a repository, then finds the current session and today's spend in memory. That makes the query cost grow with all historical sessions even though the UI only needs current state plus today's total.

## Current state

- Convex guidelines say to avoid unbounded `.collect()` and prefer bounded/ranged reads or async iteration.

- `sandboxSessions` already has indexes that can find current sessions and sessions ordered by start time:

```ts
// convex/schema.ts:1740-1743
.index("by_repositoryId_and_status", ["repositoryId", "status"])
.index("by_repositoryId_and_startedAt", ["repositoryId", "startedAt"])
.index("by_status_and_lastActivityAt", ["status", "lastActivityAt"])
.index("by_ownerTokenIdentifier_and_startedAt", ["ownerTokenIdentifier", "startedAt"])
```

- The query currently collects all history:

```ts
// convex/sandboxSessions.ts:112-135
export const getSandboxSessionCostSummary = query({
  args: { repositoryId: v.id("repositories") },
  handler: async (ctx, args) => {
    await requireOwnedDoc(ctx, args.repositoryId, {
      notFoundMessage: "Repository not found.",
    });
    const repositorySessions = await ctx.db
      .query("sandboxSessions")
      .withIndex("by_repositoryId_and_startedAt", (q) => q.eq("repositoryId", args.repositoryId))
      .order("desc")
      .collect();
    const current = repositorySessions.find(
      (session) => session.status === "starting" || session.status === "active" || session.status === "paused",
    );
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todaySpentCents = repositorySessions
      .filter((session) => session.startedAt >= todayStart.getTime())
      .reduce((sum, session) => sum + session.spentCents, 0);
    return {
      current,
      todaySpentCents,
      now: Date.now(),
    };
  },
});
```

- Existing helper `findReusableSession` already shows the indexed pattern for finding a current session by status:

```ts
// convex/sandboxSessions.ts:11-24
for (const status of ["active", "starting", "paused"] as const) {
  const session = await ctx.db
    .query("sandboxSessions")
    .withIndex("by_repositoryId_and_status", (q) => q.eq("repositoryId", repositoryId).eq("status", status))
    .first();
  if (session) {
    return session;
  }
}
```

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Convex typecheck | `bun run typecheck:convex` | exits 0 |
| Target tests | `bun run test -- convex/sandboxSessions.test.ts` | all tests pass |
| Format | `bun run format` | exits 0 |
| Lint | `bun run lint` | exits 0 |
| Full tests | `bun run test` | all tests pass |

## Scope

**In scope**:
- `convex/sandboxSessions.ts`
- `convex/sandboxSessions.test.ts`

**Out of scope**:
- Changing sandbox session schema.
- Changing session cost accounting or how `spentCents` is recorded.
- Adding a denormalized daily rollup table.
- Frontend UI changes unless a test shows the response shape must remain exact.

## Git workflow

- Branch: `advisor/005-bound-sandbox-session-cost-summary`
- Commit message style: imperative, e.g. `Bound sandbox session cost summary reads`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Split current-session lookup from daily cost aggregation

In `convex/sandboxSessions.ts`, add a small helper for the summary query that looks for current sessions by status using `by_repositoryId_and_status`. You may reuse or generalize `findReusableSession` if doing so keeps the code clearer, but do not change the behavior of `startSandboxSession`.

The summary's `current` value should still prefer reusable statuses and return one of `starting`, `active`, or `paused` when present.

**Verify**: `bun run typecheck:convex` -> exit 0.

### Step 2: Aggregate only today's sessions

Replace the all-history `.collect()` with a range query over `by_repositoryId_and_startedAt`:

```ts
const todayStart = new Date();
todayStart.setHours(0, 0, 0, 0);

let todaySpentCents = 0;
for await (const session of ctx.db
  .query("sandboxSessions")
  .withIndex("by_repositoryId_and_startedAt", (q) =>
    q.eq("repositoryId", args.repositoryId).gte("startedAt", todayStart.getTime()),
  )) {
  todaySpentCents += session.spentCents;
}
```

This still reads every session from today, but no longer reads historical sessions from prior days. Keep the public return shape `{ current, todaySpentCents, now }` unchanged.

**Verify**: `bun run typecheck:convex` -> exit 0.

### Step 3: Add regression tests

Extend `convex/sandboxSessions.test.ts` with tests for:

- An old active/paused/starting session is still returned as `current` even if it started before today.
- `todaySpentCents` excludes sessions older than today.
- `todaySpentCents` includes multiple sessions from today.

Use existing `sandboxSessions.test.ts` fixture style.

**Verify**:

```sh
bun run test -- convex/sandboxSessions.test.ts
```

Expected: all sandbox session tests pass.

### Step 4: Run required checks

Run:

```sh
bun run format
bun run lint
bun run test
```

**Verify**: all exit 0.

## Test plan

Add focused tests to `convex/sandboxSessions.test.ts`. The key regression is an old current session plus a mix of old and today cost rows; the query must not require all historical rows to calculate today's total.

## Done criteria

- [ ] `getSandboxSessionCostSummary` no longer calls `.collect()` over all sessions for a repository.
- [ ] Current-session lookup uses `by_repositoryId_and_status`.
- [ ] Daily spend aggregation only scans sessions with `startedAt >= todayStart`.
- [ ] Return shape remains `{ current, todaySpentCents, now }`.
- [ ] `bun run format` exits 0.
- [ ] `bun run lint` exits 0.
- [ ] `bun run test` exits 0.
- [ ] `plans/README.md` status row for plan 005 is updated.

## STOP conditions

Stop and report back if:

- Convex async iteration over the indexed range fails typecheck.
- Existing UI or tests depend on `current` being the newest historical matching row rather than the first reusable status found by status order.
- Correctly solving the issue appears to require schema migrations or daily rollups.

## Maintenance notes

If sandbox session volume grows enough that even today's range is too large, the next step should be a daily rollup maintained by session mutations. That is intentionally out of scope here because this plan removes the all-history read without changing storage contracts.
