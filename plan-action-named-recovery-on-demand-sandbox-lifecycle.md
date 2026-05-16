# Plan: Action-named Recovery + On-Demand Sandbox Lifecycle

## Context

**Why**: Two related UX failures dogfooded recently, both rooted in the same architectural issue — sandbox is treated as a user-managed resource when it should be an implementation detail.

1. **System Design generation failure banner says: "Sandbox has been archived. Sync the repository to provision a fresh sandbox."**
   - "Sandbox" is mechanism-leak — users don't model that concept
   - Action ("Sync repository") is in another mode (Discuss), forcing mode-switching
   - "Sync repository" is overloaded — it bundles GitHub-pull + sandbox-refresh
   - Even with a Sync button added, a `Retry` / `Try again` label tells users nothing about what will happen

2. **Chat sandbox mode silently falls back to no-tool reply when sandbox missing**
   - User gets a degraded reply without awareness
   - But sandbox costs money and time, so silent auto-provisioning is also wrong
   - User wants explicit control over activation, with visibility into status

**Goal**:
- Failure banners describe the cause in plain language; buttons are labeled by the action they perform, never by "retry" or by infrastructure words
- Sandbox readiness becomes automatic for background work (System Design generation) and explicit-with-visibility for interactive work (chat sandbox mode)
- One unified `ensureSandboxReady` helper across the codebase; no per-callsite ad-hoc logic
- Performance: only one Daytona round-trip per action; rate limits never double-charged; wake-stopped-sandbox preferred over provision-new

## Target UX

### A. System Design generation (Library — background)

When a generation fails because the sandbox wasn't ready:

```
┌─────────────────────────────────────────────────────────────┐
│ ⚠ Couldn't generate README Summary                           │
│   Live access to the repository wasn't available when this  │
│   ran. The next attempt will prepare it first.              │
│                              [ Generate README Summary  → ] │
│ ▾ See what failed                                           │
└─────────────────────────────────────────────────────────────┘
```

- Title: `Couldn't generate {Kind Title}` (or `Couldn't generate {N} documents`)
- Body: plain-language *why*, derived from a structured `reason` field — never the raw Daytona error
- Button label: the **action** that clicking will perform — `Generate {Kind Title}` or `Generate {N} documents`
- The word "sandbox" appears nowhere

While running:
```
[●] Preparing environment for your request… 30%
```

Stages shown to the user: `Preparing environment…` → `Generating 1 of 3: README Summary…`

### B. Chat sandbox mode (interactive — explicit)

Two affordances, both pointing at the same `ensureSandboxReady`:

**Status pill** (visible above the chat input whenever the thread is in sandbox mode):

| State | Display |
|---|---|
| `idle` | `○  Live source inactive    [ Activate ]` |
| `activating` | `◐  Activating live source… 45%` |
| `ready` | `●  Live source ready   (stops in 14 min)` |

**Send-triggered fallback** — if user sends a message while `idle`:

```
You ▸ How does authentication work in this repo?
     ─────────────────────────────────────────────
     ℹ  Activating live source — about 1–2 min
        [progress bar]
     ─────────────────────────────────────────────
Assistant ▸ [response after activation]
```

User gets full visibility, full control. No silent fallback. No surprise charges.

## Architectural decisions

### 1. `ensureSandboxReady(ctx, args, onStage?)` — single source of truth

`convex/lib/sandboxLiveness.ts`. Takes `repositoryId` + identity; returns live sandbox info or throws a structured error. Branches:

| Local cache | Daytona probe | Action |
|---|---|---|
| `ready` | `started` | return |
| `ready` | `stopped` | `sandbox.start(60)` via SDK |
| `ready` | `archived` / `destroyed` | provision new + clone same `lastSyncedCommitSha`, patch `latestSandboxId` |
| `stopped` | any | wake via SDK if Daytona has it, else provision new |
| `archived` / `failed` / missing | any | provision new + clone same commit |
| `provisioning` (concurrent caller) | n/a | poll until ready or timeout |

The local cache stays consistent throughout — every state transition writes through `syncSandboxStatusFromRemote` (already exists) or the existing provisioning mutations.

`onStage` callback streams substages (`probing` / `waking` / `provisioning` / `cloning`) so callers can drive UI progress.

### 2. Mutation preflight relaxed; rate limits preserved at the right layer

- `requestSystemDesignGeneration` no longer rejects when no sandbox is ready
- `consumeSystemDesignRateLimit` + `consumeDaytonaGlobalRateLimit` continue to fire at mutation time (one charge per request)
- Action does *not* re-consume — the request was already gated
- Chat: new `requestSandboxActivation` mutation consumes `consumeDaytonaGlobalRateLimit` once

### 3. Structured `kindFailures.reason`

Schema widens `jobs.kindFailures` items with optional `reason`:

```ts
v.union(
  v.literal("live_source_unavailable"),
  v.literal("model_empty_output"),
  v.literal("other"),
)
```

UI maps `reason` → user-friendly copy. Never regex-matches on the raw `message`. The raw message is still kept for support escalation but is shown only inside the expanded details.

### 4. Job-level vs per-kind failure boundary

Sandbox readiness is a **job-level** concern (all LLM kinds need it). If `ensureSandboxReady` throws, the action calls `failGeneration` — banner shows top-level failure UI with the action-named button.

Per-kind failures (e.g., LLM returns empty document) stay in `recordKindFailure` → expanded list in the banner.

### 5. Persist `selections` on the job

Currently selections live only in the action's args. To support a retry button after the job has completed-with-failures or top-level-failed, persist `selections` on the `jobs` row at insert time. This also enables future audit / debug surfaces.

Schema: `jobs.selections: v.optional(v.array(v.string()))`.

### 6. New job kind: `sandbox_activation`

Chat's explicit Activate button enqueues a `kind: "sandbox_activation"` job. Same lifecycle accounting as other jobs (lease, stale recovery, rate limits). Action just calls `ensureSandboxReady`. Status pill subscribes to a query that reports either the active job or the resolved sandbox state.

## Implementation plan

### Phase A — Backend: sandbox lifecycle orchestrator

**A1.** `convex/daytona.ts` — add `startSandbox(remoteId)` wrapping SDK `sandbox.start(60)`. Mirrors existing `stopSandbox`.

**A2.** `convex/imports.ts` — extract `reserveSandboxRow` mutation from current inline provisioning flow. Returns a new `sandboxes` row in `provisioning` state. Reused by both the import pipeline (unchanged behavior) and the new `ensureSandboxReady`.

**A3.** `convex/lib/sandboxLiveness.ts` — add `ensureSandboxReady(ctx, { repositoryId, ownerTokenIdentifier, jobId? }, onStage?)`:

- Read repository + current `latestSandboxId`
- Branch on local + Daytona state per the table above
- All writes through existing mutations (`syncSandboxStatusFromRemote`, `reserveSandboxRow`, plus a new `markSandboxReady` after clone completes)
- Streams stages through `onStage` callback
- Returns `{ sandboxId, remoteId, repoPath }` on success
- Throws structured `SandboxPreparationError` on Daytona / quota failures — carries a user-friendly message

### Phase B — System Design integration

**B1.** `convex/schema.ts`:
- Add `reason` (optional union) to `jobs.kindFailures` items
- Add `selections: v.optional(v.array(v.string()))` to `jobs`
- Add `"sandbox_activation"` to `jobKind` union
- Add `"preparing_sandbox"` to expected stage values (it's just a string, no schema change needed — but document it)

**B2.** `convex/systemDesign.ts`:
- `requestSystemDesignGeneration`: remove the preflight "reject if no ready sandbox" branch; keep rate-limit consumption; persist `selections` on the new job row
- `recordKindFailure`: accept optional `reason`

**B3.** `convex/systemDesignNode.ts`:
- Replace existing `verifyAndSyncSandbox` call site with `ensureSandboxReady`
- New stage progression: `queued` → `preparing_sandbox:probing` → `preparing_sandbox:waking|provisioning|cloning` → `running:Generated 1 of 3: README Summary` → `completed`
- If `ensureSandboxReady` throws → `failGeneration` with the structured message (job-level failure)
- `runKind` catch maps to `reason`:
  - `error instanceof SandboxPreparationError` (shouldn't reach here after B3.1 but defensive) → `"live_source_unavailable"`
  - `/empty document/i` → `"model_empty_output"`
  - default → `"other"`

### Phase C — Library System Design banner

**C1.** `src/components/system-design-status-banner.tsx`:

- Read failure shape via a small helper:
  ```ts
  function describeFailures(job: Doc<"jobs">): {
    title: string;          // "Couldn't generate README Summary"
    reasonText: string;     // user-friendly why
    buttonLabel: string;    // "Generate README Summary"
    selections: string[];   // for the retry mutation
  }
  ```
- Aggregate `kindFailures[].reason`:
  - All `live_source_unavailable` → "Live access to the repository wasn't available when this ran. The next attempt will prepare it first."
  - All `model_empty_output` → "The model didn't produce a complete document. The next attempt may succeed."
  - Mixed → "Some documents couldn't be generated. The next attempt will retry the failed ones."
  - Top-level (no `kindFailures`, status=`failed`) → fall back to `job.errorMessage` mapped to a friendly category; selections come from `job.selections`
- Button label derived from selections:
  - 1 kind → `Generate {KIND_TITLES[kind]}`
  - N kinds → `Generate {N} documents`
- Click → `useMutation(api.systemDesign.requestSystemDesignGeneration)({ repositoryId, selections })`; show pending state on the button
- Active stages: render `preparing_sandbox:*` as "Preparing environment…" with substage (e.g., "Cloning repository…"); existing `running` rendering unchanged

**C2.** `src/components/system-design-status-banner.test.tsx`:
- New cases: `reason` mapping per category, mixed-reason aggregation, action-named button copy, retry-click invokes mutation with derived selections, top-level-failed path

### Phase D — Chat sandbox mode: status + on-demand activation

**D1.** `convex/repositories.ts` — `requestSandboxActivation(repositoryId)` mutation:
- Identity + ownership guard
- Rate limit (`consumeDaytonaGlobalRateLimit`)
- Dedup: if an active `sandbox_activation` job exists, return its id
- Insert `jobs` row with `kind: "sandbox_activation"`
- Schedule action

**D2.** `convex/repositoriesNode.ts` (or `convex/sandboxActivation.ts` new file) — action:
- Calls `ensureSandboxReady` with `onStage` that patches `job.stage`
- On success: `completeRunningJob`
- On failure: `failRunningJob` with structured message

**D3.** `convex/chat/context.ts` — new public query `getSandboxActivityStatus(repositoryId)`:
- Returns `{ kind: "idle" | "activating" | "ready" | "expiring_soon"; activeJob?: Doc<"jobs">; sandbox?: Doc<"sandboxes"> }`
- Reads `latestSandboxId` + checks for an in-flight `sandbox_activation` job
- Used by the chat status pill

**D4.** Chat send flow (`convex/chat/generation.ts`):
- When `replyContext.mode === "sandbox" | "lab"`:
  - If `verifyAndSyncSandbox` says not-ready → call `ensureSandboxReady` blocking
  - During activation, the assistant message stream emits a "system notice" event the frontend renders as a progress inline message
  - When ready, proceed with the existing tool-driven path
- Current "fall back to no-tool reply" path removed for sandbox mode (silent degradation is the wrong UX per the new design)
- Other modes (`discuss`, `docs`, `ask`) unaffected

**D5.** Chat UI status pill component (file location depends on existing chat layout — most likely `src/components/chat-input.tsx` or similar):
- Subscribes to `getSandboxActivityStatus`
- Renders status per the UX table above
- "Activate" button → `useMutation(api.repositories.requestSandboxActivation)`
- During `activating`, shows progress from `activeJob.progress`

### Phase E — Tests

- E1. `ensureSandboxReady` unit tests: each state-branch + Daytona-down + concurrent provisioning race
- E2. `SystemDesignStatusBanner` extended tests: `reason` mapping, button copy, retry click
- E3. `getSandboxActivityStatus` query tests: each state derivation
- E4. Chat activation integration test with `convex-test`

### Phase F — Cleanup

- F1. `verifyAndSyncSandbox` stays — it's now an internal building block called by `ensureSandboxReady` and used in non-blocking chat fallback paths (if any remain)
- F2. Drop "Sync the repository" copy from `probeLiveSandbox` message fields; replace with user-friendly text. The error string surfaced to user must never contain the word "sandbox"
- F3. `bun run format && lint && typecheck && test`

## Critical files

| File | Action |
|---|---|
| `convex/daytona.ts` | Add `startSandbox`; tweak `probeLiveSandbox` user-facing messages |
| `convex/imports.ts` | Extract `reserveSandboxRow` as a reusable mutation |
| `convex/lib/sandboxLiveness.ts` | Add `ensureSandboxReady` + `SandboxPreparationError` |
| `convex/systemDesign.ts` | Relax preflight, persist `selections`, accept `reason` in `recordKindFailure` |
| `convex/systemDesignNode.ts` | Replace `verifyAndSyncSandbox` with `ensureSandboxReady`; new stage handling; `reason` mapping in `runKind` catch |
| `convex/repositories.ts` | Add `requestSandboxActivation` mutation |
| `convex/repositoriesNode.ts` (or new `sandboxActivation.ts`) | Action that runs `ensureSandboxReady` for explicit activation |
| `convex/chat/context.ts` | Add `getSandboxActivityStatus` query |
| `convex/chat/generation.ts` | Use `ensureSandboxReady` in sandbox-mode send flow; inline progress messages; remove silent fallback in sandbox mode |
| `convex/schema.ts` | Add `reason` to `kindFailures`; add `selections` to jobs; add `sandbox_activation` to `jobKind` |
| `src/components/system-design-status-banner.tsx` | New copy / action-named button / retry mutation call |
| `src/components/system-design-status-banner.test.tsx` | Updated tests |
| Chat input area component (TBD) | Status pill + Activate button |

## Functions to reuse

- `provisionSandbox` (`convex/daytona.ts:88`)
- `cloneRepositoryInSandbox` (`convex/daytona.ts:226`)
- `getRemoteSandboxDetails` (`convex/daytona.ts:198`)
- `probeLiveSandbox`, `verifyAndSyncSandbox` (`convex/lib/sandboxLiveness.ts` — internal building blocks for `ensureSandboxReady`)
- `syncSandboxStatusFromRemote` (`convex/ops.ts`)
- `requestSystemDesignGeneration` (`convex/systemDesign.ts:66`)
- Daytona SDK `Sandbox.start(timeout)` (`node_modules/@daytona/sdk/src/Sandbox.d.ts:165`)
- `consumeSystemDesignRateLimit`, `consumeDaytonaGlobalRateLimit` (`convex/lib/rateLimit.ts`)
- Existing job lifecycle helpers: `markQueuedJobRunning`, `updateRunningJobProgress`, `completeRunningJob`, `failRunningJob`, `refreshRunningJobLease`

## Verification

### Manual: System Design recovery (the original dogfood scenario)

1. From Daytona dashboard, **archive** an active sandbox of a test repo (don't delete — archive is the cleanest test)
2. In Library, click Generate → README Summary
3. **Expected**:
   - Banner: `Preparing environment for your request… → Cloning repository… → Generating 1 of 1: README Summary…`
   - Convex Dashboard: `sandboxes` row's `status` updates `archived → provisioning → ready` over ~1–2 min
   - `repositories.latestSandboxId` repointed to the new row
   - Banner clears, README Summary appears in navigator
4. **Expected (failure injection)**: temporarily unset `DAYTONA_API_KEY` in dashboard; click Generate again
   - Banner: `Couldn't generate README Summary — Live access to the repository wasn't available when this ran. The next attempt will prepare it first.  [ Generate README Summary ]`
   - Word "sandbox" appears nowhere
   - Click the button → new job created, fails again with same copy
5. Restore key, click again → succeeds

### Manual: Chat sandbox-mode activation

1. Start a thread in sandbox mode on a repo whose sandbox is currently archived
2. **Expected**: status pill says `Live source inactive   [ Activate ]`
3. Click `Activate`
4. **Expected**: pill becomes `Activating live source… {%}`; in ~1–2 min becomes `Live source ready   (stops in X min)`
5. Type and send a message → assistant streams with tools as normal

6. **Alternate path (send-triggered)**: archive sandbox again, send a message immediately without clicking Activate
7. **Expected**: pill shows activating; thread shows inline `ℹ Activating live source — about 1–2 min` with progress; once ready, assistant response streams

### Automated

`bun run format && bun run lint && bun run typecheck && bun run test`. New test coverage:

- `convex/lib/sandboxLiveness.test.ts` (new) — `ensureSandboxReady` per branch
- `src/components/system-design-status-banner.test.tsx` — extended for `reason` mapping + button copy + retry click
- `convex/chat/context.test.ts` (or new) — `getSandboxActivityStatus` state derivation
- `convex/repositories.test.ts` (or new dedicated) — `requestSandboxActivation` dedup + rate limit
- `convex/chat/generation.test.ts` — activation flow in sandbox mode

## Performance notes

- `ensureSandboxReady` always makes **one** Daytona probe (~200ms). For System Design generation (30s–2min LLM call), this is < 1% overhead. For chat sandbox mode, it's amortized over the entire reply stream.
- Wake-from-stopped (`sandbox.start`) is ~10–30s; provision-new is ~60–120s. The helper prefers wake when possible — net latency win over today's "fail and force re-import" path.
- New `selections` field on jobs costs ~50 bytes per row, well below schema overhead concerns.
- Rate limits are charged exactly once per user action (mutation layer). The action never double-charges even when it provisions on-demand.
- Chat first-message-when-inactive blocks for the full activation latency. Subsequent messages in the same session are immediate.

## Scope options

| Scope | Phases | Estimate | Closes |
|---|---|---|---|
| **Minimum** | A + B + C + E (tests) + F | ~2 days | System Design recovery only; chat unchanged |
| **Recommended** | All phases A–F | ~3–4 days | System Design + chat activation UX; unified architecture |
| **Extended** | + sandbox warm-up heartbeat, idle keep-alive policy | +1 day | Reduce archive-rate; not required for correctness |

I recommend **Recommended (A–F)** — it's the smallest set that closes both dogfood scenarios with one shared architecture and avoids leaving chat as a future-self problem.

## Out of scope

- Renaming the "sandbox" mode literal in chat mode picker (separate UX call; this plan only fixes failure-path copy)
- Sandbox keep-alive / heartbeat (no archive while user is active) — separate optimization
- Per-thread sandbox isolation (current model: one sandbox per repo)
- Switching `syncRepository`'s overloaded behavior — its semantic (full GitHub pull + re-index) stays
- Backfill / migration for old `kindFailures` rows without `reason` — UI handles undefined via the `"other"` branch
