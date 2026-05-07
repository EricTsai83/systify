# Systify GPT-5.5 Review Implementation Plans

## Purpose

This document splits the architecture review in `systify-gpt55-review.md` into smaller implementation plans. Each plan is intended to be independently reviewable, testable, and safe to ship before the next one starts.

## Recommended Order

1. Job lifecycle hardening
2. Repository access consolidation
3. Sandbox/import publish boundary
4. Convex read/index tuning
5. Frontend hot path split

The first two plans should land before broad feature work because they tighten shared invariants used by chat, deep analysis, artifacts, imports, and repository deletion.

## Plan 1: Job Lifecycle Hardening

### Goal

Centralize queued, running, cancelled, failed, and completed transitions so late actions cannot move terminal jobs back to running or completed.

### Primary Files

- `convex/chat/streaming.ts`
- `convex/analysis.ts`
- `convex/designArtifacts.ts`
- `convex/ops.ts`
- `convex/schema.ts`
- Convex tests under `convex/`

### Scope

- Add a small lifecycle helper module for job transitions.
- Define terminal states in one place.
- Add conditional helpers for:
  - queued to running
  - running to completed
  - running to failed
  - running to cancelled
  - stale running to failed or queued, depending on current recovery behavior
- Preserve existing public API behavior unless a race currently violates the intended terminal state.
- Add a lease owner or run token only where a late action can currently patch a stale job.

### Implementation Steps

1. Inventory every write to the `jobs` table in the primary files.
2. Create the lifecycle helper near the Convex job code, using existing status names and generated Convex types.
3. Replace direct status patches in chat streaming, deep analysis, design artifact generation, and ops recovery with helper calls.
4. Ensure terminal patches are conditional on the current job still being owned by the active run.
5. Add focused race tests:
   - cancel before action starts
   - cancel while action is running
   - stale recovery before late completion
   - failed job receiving a late completion

### Verification

- `bun run format`
- `bun run lint`
- `bun run typecheck`
- `bun run test`

## Plan 2: Repository Access Consolidation

### Goal

Make active repository authorization consistent by centralizing owner and `deletionRequestedAt` checks.

### Primary Files

- `convex/repositories.ts`
- `convex/chat/send.ts`
- `convex/analysis.ts`
- `convex/architectureDiagram.ts`
- `convex/designArtifacts.ts`
- Shared Convex helper module for repository access
- Convex tests under `convex/`

### Scope

- Add an active repository helper that:
  - derives the caller identity server-side
  - checks `ownerTokenIdentifier`
  - rejects repositories with `deletionRequestedAt`
  - returns a typed repository document for downstream code
- Use separate helper entry points for public functions and internal functions if internal callers already carry trusted owner context.
- Do not accept `userId` or owner identifiers from public function arguments for authorization.

### Implementation Steps

1. Inventory current repository lookups and owner checks in the primary files.
2. Create helper functions for active repository reads.
3. Replace duplicated checks in public queries, mutations, and actions.
4. Keep tombstoned repository behavior consistent across chat send, deep analysis, architecture diagram generation, and design artifact generation.
5. Add focused tests:
   - owner can access active repository
   - non-owner cannot access repository
   - owner cannot use a repository after deletion is requested
   - chat/analyze/artifact entry points reject tombstoned repositories

### Verification

- `bun run format`
- `bun run lint`
- `bun run typecheck`
- `bun run test`

## Plan 3: Sandbox/Import Publish Boundary

### Goal

Keep the previous usable sandbox available until a new import or sync has fully succeeded, and make failed sandbox cleanup retryable.

### Primary Files

- `convex/importsNode.ts`
- `convex/imports.ts`
- `convex/repositories.ts`
- `convex/schema.ts`
- `docs/repository-lifecycle.md`
- `docs/import-persistence-system-design.md`
- Convex tests under `convex/`

### Scope

- Treat sandbox creation during sync as import-scoped until the new snapshot is finalized.
- Update `repositories.latestSandboxId` only after:
  - new sandbox is provisioned
  - repository content is cloned and scanned
  - snapshot persistence succeeds
  - import is finalized
- Defer old sandbox cleanup until after the new sandbox is published.
- Make failed sandbox cleanup idempotent and retryable without losing the last known good sandbox reference.

### Implementation Steps

1. Trace the current import and sync flow from `createRepositoryImport` or `syncRepository` to `runImportPipeline`.
2. Identify where `latestSandboxId` is patched today.
3. Move repository sandbox publication to the finalize boundary.
4. Store any new in-progress sandbox reference on the import or sandbox record instead of replacing the repository pointer early.
5. Add cleanup retry status fields only if existing fields cannot represent retryable cleanup.
6. Update lifecycle documentation after behavior is implemented.
7. Add tests:
   - sync failure preserves previous sandbox availability
   - successful sync publishes the new sandbox
   - old sandbox cleanup can fail and be retried
   - repository deletion still cleans all known sandbox resources

### Verification

- `bun run format`
- `bun run lint`
- `bun run typecheck`
- `bun run test`

## Plan 4: Convex Read And Index Tuning

### Goal

Reduce broad scans and read amplification on hot operational paths without changing user-visible behavior.

### Primary Files

- `convex/schema.ts`
- `convex/ops.ts`
- `convex/repositories.ts`
- `convex/designArtifacts.ts`
- `convex/chat/`
- Existing docs that describe the affected read paths

### Scope

- Add or refine indexes for:
  - stale interactive jobs
  - failure-mode jobs
  - active repository lists
  - design artifact context reads
- Replace broad reads with indexed, bounded queries.
- Add lightweight metadata or digests only when an existing document read is too heavy for a frequently refreshed UI or action path.
- Use a migration plan before narrowing schema requirements.

### Implementation Steps

1. Audit current `.filter`, `.collect`, and unbounded query usage on the target paths.
2. Add indexes following Convex index naming and field-order conventions.
3. Update reads to use the new indexes with bounded result sizes.
4. If schema fields are required, use widen-migrate-narrow instead of a single breaking change.
5. Add tests for query behavior where the read path has authorization or lifecycle semantics.
6. Update docs only for behaviorally meaningful read strategy changes.

### Verification

- `bun run format`
- `bun run lint`
- `bun run typecheck`
- `bun run test`

## Plan 5: Frontend Hot Path Split

### Goal

Keep workspace navigation stable while chat streaming and artifact rendering update frequently.

### Primary Files

- `src/components/repository-shell.tsx`
- `src/components/chat-panel.tsx`
- `src/components/chat-message.tsx`
- `src/components/artifact-panel.tsx`
- Related hooks and component tests

### Scope

- Move streaming subscriptions out of the repository shell and into the chat-focused container.
- Keep the shell responsible for workspace layout, navigation, selected repository state, and panel composition.
- Reduce re-render cost in chat message and artifact components with local memoization or component boundaries only where props are stable and render work is meaningful.
- Mount heavy artifact content only when visible.

### Implementation Steps

1. Trace current props and Convex subscriptions from repository shell to chat and artifact components.
2. Introduce a chat container if the existing chat panel is doing both data subscription and rendering.
3. Move active stream subscription to the chat container.
4. Split expensive message or artifact subtrees only after identifying stable prop boundaries.
5. Avoid broad memoization that hides data flow or adds negligible value.
6. Add focused React tests for rendering and interaction behavior.

### Verification

- `bun run format`
- `bun run lint`
- `bun run typecheck`
- `bun run test`

## Cross-Plan Guardrails

- Keep changes scoped to one plan per branch or PR.
- Do not mix schema/index work with frontend render work.
- Do not change public behavior without tests that describe the new invariant.
- Prefer helper modules that encode real invariants over thin wrappers around individual database calls.
- Preserve terminal states, repository tombstones, and last known good sandbox references during failures.
