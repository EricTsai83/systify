# Repository-Owned Data Lifecycle System Design

## Problem

Repository deletion currently has to coordinate several different concerns:

- scanning and deleting repository-owned tables in a safe order
- waiting for live sandbox cleanup before removing local sandbox/job state
- preserving failure state when sandbox cleanup is exhausted
- clearing viewer preferences that point at the deleted repository

When those responsibilities live as implicit helper order inside one cascade
file, the deletion graph is hard to audit. A new repository-owned table can be
added without joining the cascade, leaving dangling rows after deletion. The
opposite risk is also real: a table with audit or compliance semantics can be
mistaken for ordinary repository state and deleted too early.

## Design Goals

The lifecycle module optimizes for:

1. Correct deletion of repository-owned operational data.
2. An explicit list of retained data that must outlive repository/thread/message
   deletion.
3. Bounded reads and writes so each Convex mutation stays inside transaction
   limits.
4. Reentrant cascade execution that can safely reschedule and resume after a
   partial batch, function restart, or delayed sandbox cleanup.

## Deletion Graph

The graph is intentionally repository-rooted. Each edge is drained in bounded
batches, and a full batch causes the cascade to reschedule itself.

### Thread graph

Threads own the chat-local children:

- `messageToolCallEvents` by `messageId`
- `messages` by `threadId`
- `messageStreamChunks` by `streamId`
- `messageStreams` by `threadId`
- thread-scoped `artifacts` by `threadId`
- `threads` by `repositoryId`
- `threadShares`, `chatHistoryGroups`, and `archivedThreadScopes` by
  `repositoryId`

The thread row is deleted only after its messages, streams, stream chunks, and
thread-scoped artifacts are drained.

### Owner viewer state

Viewer-local repository state is removed before the repository root disappears:

- `artifactViews`
- `repositoryViewerBootstraps`
- `userPreferences.lastActiveRepositoryId` is cleared when it points at the
  deleted repository

Only the repository pointer is cleared from `userPreferences`; the viewer row
and unrelated preferences remain.

### Repository content/state

Repository content and import/system-design state is drained by repository id:

- `artifactChunks`
- `artifacts`
- `artifactFolders`
- `artifactDrafts`
- `repoChunks`
- `repoFiles`
- `imports`
- `systemDesignKindRuns`

Chunks are drained before their parent artifact/content rows so repeated
continuations never depend on a parent row still existing.

### Sandbox local state

Sandbox state is split between remote cleanup and local row cleanup:

- `sandboxSessions` are repository-local accounting rows and are deleted.
- `sandboxes` are deleted only after they reach `archived`.
- `sandboxRemoteObservations` are not deleted as part of repository cascade;
  archived sandbox deletion detaches the observation from `sandboxId` and
  `repositoryId`, marks it ignored, and leaves the remote-observation history
  available to the sandbox reconciliation system.

Live sandboxes keep the cascade in a waiting state until cleanup completes.

### Jobs

`jobs` are deleted only after sandbox cleanup no longer has pending live
sandbox work. Cleanup jobs need repository/sandbox context while the remote
delete action is in flight, so deleting jobs earlier can strand cleanup.

### Repository root

The `repositories` row is the final delete. It is removed only when:

- every owned data batch reports drained
- no live sandbox cleanup is pending
- sandbox cleanup retry exhaustion has not left the repository in a failed
  deletion state

### Retained audit data

`sandboxToolCallLog` is intentionally outside the repository/thread/message
cascade. Its rows may contain `threadId`, `messageId`, and `sandboxId` values
whose parent rows have been deleted.

## Retained Data

`sandboxToolCallLog` is retained when repositories, threads, and messages are
deleted.

Reason: the table is the compliance and internal-debugging audit trail for
sandbox tool executions. User-initiated repository or thread deletion must not
erase that audit trail mid-window. The 90-day TTL enforced by
`cleanupExpiredSandboxToolCallLogs` is the only cleanup path for these rows.

## Failure Behavior

Repository deletion starts by scheduling sandbox cleanup for all non-archived
sandboxes. While any live sandbox cleanup remains pending:

- repository-owned data can continue draining in batches
- cleanup jobs and the repository root are retained
- the cascade reschedules itself after the sandbox retry delay

If sandbox cleanup retry attempts are exhausted, the cascade marks each
remaining non-archived sandbox as failed, patches the repository with
`repositoryDeleteFailedAt` and `repositoryDeleteFailureMessage`, logs a warning,
and stops. The root repository row is not deleted in this state because the
system needs a durable failure marker for operator/user recovery.

## Testing Strategy

Coverage is pinned at the graph boundary:

- Graph coverage: a registry lists every table the lifecycle handles and the
  tests compare it to the expected repository-owned/retained table set.
- Retained audit log: `sandboxToolCallLog` survives repository cascade.
- Sandbox waiting: live sandbox cleanup prevents job/root deletion.
- Retry exhausted: the repository remains and records deletion failure.
- Batch reschedule: a large repository-owned row set drains over multiple
  scheduled cascade invocations.
