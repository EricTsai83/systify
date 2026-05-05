# Architecture Review Findings

## Scope

This review focuses on long-term maintainability, robust architecture, Convex performance patterns, and avoiding temporary patch behavior.

No files were changed during the review, and no validation commands were run.

## Findings

### 1. Active job checks rely on bounded reads plus in-memory filtering

Risk: correctness and duplicate work.

`chat.sendMessage` reads the latest 25 jobs for a thread and then filters in memory for an active chat job. `analysis.requestDeepAnalysis` reads queued and running jobs for a repository and then filters by kind. As job volume grows, unrelated jobs can push an active leased job outside the bounded window, allowing duplicate chat or deep-analysis work to be queued.

Recommended direction:

- Make in-flight work a first-class data model concept, such as `threads.activeChatJobId` and `repositories.activeDeepAnalysisJobId`.
- Or add precise indexes such as `by_threadId_and_kind_and_status` and `by_repositoryId_and_kind_and_status`.
- Keep lease expiry checks authoritative at the write boundary.

### 2. `getRepositoryDetail` has an overly broad reactive surface

Risk: unnecessary invalidation and UI recomputation.

`getRepositoryDetail` returns repository data, artifacts, jobs, recent threads, sandbox status, and update state in a single query. Any job progress, artifact change, or thread update can invalidate the whole subscription and cause the frontend shell to recompute more state than necessary.

Recommended direction:

- Split the query into deeper, narrower modules:
  - `RepositorySummary`
  - `RepositoryJobFeed`
  - `RepositoryArtifactsPreview`
  - `SandboxStatus`
- Keep each query aligned with one UI refresh cadence.
- Avoid returning high-churn operational state alongside stable repository metadata.

### 3. Thread page subscriptions repeat ownership and repository reads

Risk: read amplification and shallow interfaces.

The thread page composes `getThreadContext`, `listMessages`, and `getActiveMessageStream`. Each query independently validates ownership and some repeat thread or repository reads. This is secure and understandable, but the caller has to know too much about how thread runtime state is assembled.

Recommended direction:

- Introduce a deeper Thread Runtime View module that owns:
  - thread ownership checks
  - repository attachment validation
  - mode capabilities
  - messages window
  - active stream snapshot
- Preserve fine-grained subscriptions where they materially reduce invalidation.
- Centralize shared invariants so frontend code depends on fewer backend concepts.

### 4. Daytona sandbox network policy should be verified

Risk: security and misleading configuration.

Sandbox provisioning requires `DAYTONA_NETWORK_ALLOW_LIST`, but passes `networkBlockAll: false`. If Daytona only applies the allow list when block-all mode is enabled, the implementation may appear restricted while allowing broader network access.

Recommended direction:

- Confirm Daytona SDK semantics for `networkBlockAll` and `networkAllowList`.
- Encapsulate network settings in a `SandboxNetworkPolicy` module.
- Add tests that assert the intended provisioning options, including blocked network behavior.

## Positive Signals

- Convex functions generally use validators.
- Queries mostly use indexes and bounded reads.
- Streaming uses a separate stream table with chunk compaction.
- Tool-call events are isolated from durable messages and folded at finalization.
- Cascade deletion uses batched continuation patterns.
- Schema comments document important invariants and migration reasoning.

## Recommended Priority

1. Fix active job and in-flight lease modeling first, because it affects correctness, cost control, and duplicate background work.
2. Split `getRepositoryDetail` into narrower reactive views to reduce invalidation and improve performance predictability.
3. Design a Thread Runtime View module to reduce repeated backend reads and simplify frontend orchestration.
4. Verify and harden the Daytona network policy.

## Verification Status

This was a static architecture review. The following commands were not run:

- `bun run format`
- `bun run lint`
- `bun run typecheck`
- `bun run test`
