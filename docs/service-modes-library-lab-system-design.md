# Service Modes, Library, And Lab System Design

## Purpose

Systify uses three product-level service modes:

- `discuss`: free-form discussion with no repository grounding.
- `library`: read and ask over persisted artifacts.
- `lab`: sandbox-backed work against the live repository tree.

These modes are the canonical user-facing architecture. Older `docs` and `sandbox` terminology is not part of the current product model.

## Routing Model

```mermaid
flowchart TD
  Workspace["/w/:workspaceId"]
  Discuss["/w/:workspaceId/discuss/:threadId?"]
  Library["/w/:workspaceId/library"]
  LibraryArtifact["/w/:workspaceId/library/a/:artifactId"]
  Lab["/w/:workspaceId/lab/:threadId?"]

  Workspace --> Discuss
  Workspace --> Library
  Library --> LibraryArtifact
  Workspace --> Lab
```

`library/a/:artifactId` is the only long-form artifact reader — the artifact owns the path, and chat citations, quick-open, tabs, and folder navigation all converge on it. The active Library Ask thread is secondary view-state, carried as an optional `?ask=:threadId` query param on either Library URL rather than its own route; the legacy `/library/ask/:threadId` route redirects to the `?ask=` form.

## Library Shell Composition

The Library page does not reuse the global chat shell. It mounts `AppSidebar` in `suppressThreadNavigation` mode — the sidebar renders only chrome (logo, service-mode switcher, workspace switcher) and **no thread list**, because the Library shell owns thread navigation for this mode.

The Library shell is a three-column desktop layout:

- **Left — Library Ask** (always visible): an IDE-style thread tab strip on top (`LibraryAskThreadTabs`) — one tab per *open* thread, not the full list — over the conversation and the input. The `+` button starts a thread; the clock button opens `LibraryAskHistoryDialog`. There is no collapse toggle — Ask is a permanent column.
- **Middle — Document**: the artifact tab strip (`LibraryTabs`) and the editor.
- **Right — Folder tree**: the artifact folder navigator, collapsible via Cmd+B.

On narrow viewports the document column is the base layer; Library Ask and the folder tree each move into a Sheet (left and right respectively), with the thread tabs riding inside the Ask Sheet. The Ask column is mounted in exactly one place (desktop column *or* mobile Sheet, never both) because it carries cross-render local state (`useLibraryAskTabs`); the folder tree, which carries none, stays CSS-toggled.

The Ask thread strip is an *open set*, mirroring how the document column works: tabs are threads the user has explicitly opened (persisted per-workspace in localStorage by `useLibraryAskTabs`, caching `{ id, title }` since `listThreads` is capped), the X closes a tab without deleting the thread, and the full searchable history — recall a past thread, pin it, or delete it — lives in `LibraryAskHistoryDialog`. The *active* thread is the page-owned `?ask=` URL param. Thread deletion is intentionally confined to the history dialog so it is never a stray click beside a close button; `LibraryAskPanel` owns that flow (confirm dialog included) so the deleted thread is dropped from the open set in one place.

`WorkspaceThreadsRail` remains the single *vertical* thread-list implementation, used now only by the global sidebar (Discuss and Lab threads). Both thread surfaces still scope their query to one mode (`listThreads({ mode })`): a Library Ask thread surfacing in the Discuss sidebar would be a mode leak.

`AppSidebar`'s props are a discriminated union on `suppressThreadNavigation`, so the chrome-only variant cannot be handed thread-navigation callbacks it would never invoke — the type system enforces the composition boundary rather than callers passing no-op handlers.

## Data Model

Library reads artifact metadata through a metadata-only query and fetches the markdown body only for the active editor tab. This keeps tree, tabs, and quick-open subscriptions small.

Artifact organization is represented by `artifactFolders`; the frontend computes visible folder counts from the already-loaded artifact metadata rather than asking the backend to scan artifacts per folder.

Library Ask retrieves from `artifactChunks`, which are separate rows so chunking and embedding churn does not rewrite the parent artifact document. Missing embeddings degrade to lexical retrieval instead of blocking Ask.

Lab sessions are stored in `labSessions`, scoped to a workspace, and linked to a repository sandbox when active. A workspace has one reusable Lab session so switching Lab threads does not reprovision compute.

## Availability

Sandbox availability is centralized in `convex/lib/sandboxAvailability.ts`. Callers must not decide Lab readiness from `sandboxes.status` alone; availability also depends on TTL, `remoteId`, and `repoPath`.

```mermaid
flowchart TD
  SandboxRow[sandboxes]
  Availability[getSandboxAvailability]
  ChatSend[chat.sendMessage]
  ThreadContext[threadContext]
  DesignJobs[design artifact jobs]
  DeepAnalysis[deep analysis]

  SandboxRow --> Availability
  Availability --> ChatSend
  Availability --> ThreadContext
  Availability --> DesignJobs
  Availability --> DeepAnalysis
```

## Job Lifecycle

Deep analysis and sandbox-backed design jobs must re-check repository liveness before writing durable artifacts. If a repository is archived or deletion has started, the job fails instead of publishing new knowledge.

Long-running jobs use leases. Actions refresh the lease before and after external sandbox work so stale-job recovery does not race normal completion.

## Performance Rules

- Library list queries return metadata, not `contentMarkdown`.
- Folder listing is folder-only. Counts are derived from the artifact metadata already in memory.
- Lab readiness uses the shared availability helper.
- Repository detail queries should stay status-oriented; full artifact bodies belong to artifact-specific reads.
- Import-drift derivation resolves the latest import SHA once per repository-scoped query, never per artifact — see the Artifact Import Drift System Design.

