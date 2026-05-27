# Systify System Design

This folder contains the system design documentation for the current Systify codebase. The documents focus on the current state and are meant to help engineers quickly understand the system boundaries, core data model, key workflows, and external integrations.

## Recommended Reading Order

1. `system-overview.md`
2. `domain-and-data-model.md`
3. `auth-and-access.md`
4. `repository-lifecycle.md`
5. `chat-and-analysis-pipeline.md`
6. `integrations-and-operations.md`
7. `orphan-resource-handling.md`
8. `service-modes-discuss-library-system-design.md`

## Additional Focused Design Docs

- `vercel-convex-deployment-system-design.md`
  - Why is the Vercel + Convex deployment model simple but still a system-design concern?
  - How should preview-safe callback URLs and environment ownership be split?
- `daytona-webhook-reconciliation-system-design.md`
  - How should webhook ingress, durable inbox, projection updates, and cron backstops work together?
  - How do signature verification and organization allowlisting define the webhook trust boundary?
- `import-persistence-system-design.md`
  - Why should import persistence be idempotent, batched, and finalized through a single publish boundary?
  - How does staged write plus cleanup preserve snapshot integrity under retries and failures?
- `chat-context-retrieval-system-design.md`
  - How does query-aware retrieval improve chunk selection without introducing embeddings?
  - Why should retrieval stay bounded to the latest import snapshot?
- `repository-filecount-rollout-system-design.md`
  - Why is `repositories.fileCount` published only at finalize instead of per-batch?
  - How does denormalization remove hot-path read amplification safely?
- `streaming-reply-optimization-system-design.md`
  - Why are active stream state and durable history stored in separate tables?
  - How does compaction plus finalize-once keep streaming reliable?
- `architecture-diagram-artifact-system-design.md`
  - Why is architecture diagram generation an end-to-end system-design concern, not only frontend rendering?
  - How do deterministic generation, bounded output caps, and renderer recovery work together?
- `github-callback-returnto-allowlist-system-design.md`
  - Why is URL-format validation alone insufficient for callback redirect trust?
  - How does origin allowlisting reduce open-redirect phishing-chain risk?
- `repository-persistence-system-design.md`
  - Why is the viewer's "current repository" stored in both Convex and localStorage?
  - How does DB-wins reconciliation give cross-device continuity without a first-paint flash?
- `sandbox-tool-call-audit-log-system-design.md`
  - Why does sandbox tool-call recording need a third table beyond `messageToolCallEvents` and `messages.toolCalls`?
  - How does best-effort writing plus a 90-day TTL keep compliance evidence durable without coupling to user-initiated deletes?
- `archive-listing-system-design.md`
  - Why does the archive view split into a reactive browse path and a non-reactive search path on top of one Convex paginated query?
  - How does post-filtering preserve correctness without adding a denormalized `isArchived` field or a migration?
- `repository-remote-freshness-check-system-design.md`
  - Why is the "repo is behind the remote" check driven by client events plus two SHAs instead of webhooks, cron, or a persisted stale flag?
  - Why does sync immediately clear `latestRemoteSha` instead of waiting for import finalize to update freshness state?
- `service-modes-discuss-library-system-design.md`
  - How do Discuss and Library map to routes, data dependencies, and the sandbox-grounding toggle?
  - Why does Library use metadata-only subscriptions and artifact-specific body reads?

## Implementation Coverage

The current codebase keeps system-design documentation for all implemented high-impact flows:

- Rate limiting and lease recovery: `integrations-and-operations.md`
- Daytona orphan protection and reconciliation layers: `orphan-resource-handling.md`
- Daytona webhook reconciliation path: `daytona-webhook-reconciliation-system-design.md`
- Import persistence idempotency and finalize boundary: `import-persistence-system-design.md`
- Chat context retrieval strategy: `chat-context-retrieval-system-design.md`
- Discuss / Library service modes: `service-modes-discuss-library-system-design.md`
- Repository file-count denormalization: `repository-filecount-rollout-system-design.md`
- Chat streaming architecture: `streaming-reply-optimization-system-design.md`
- Vercel + Convex deployment model: `vercel-convex-deployment-system-design.md`
- GitHub callback returnTo allowlist boundary: `github-callback-returnto-allowlist-system-design.md`
- Repository persistence and cross-device continuity: `repository-persistence-system-design.md`
- Sandbox tool-call audit log retention and recording boundary: `sandbox-tool-call-audit-log-system-design.md`
- Archive listing pagination, search, and view state machine: `archive-listing-system-design.md`
- Repository remote-freshness check trigger model and SHA comparison boundary: `repository-remote-freshness-check-system-design.md`

## What Each Document Answers

### `system-overview.md`

- What runtimes and external services make up Systify?
- How do the main user actions flow through the frontend, Convex, and external services?
- Which modules form the backbone of the product?

### `domain-and-data-model.md`

- What are the core entities in the system?
- How does `ownerTokenIdentifier` enforce data isolation?
- Which tables carry workflow state?

### `auth-and-access.md`

- How are WorkOS and Convex connected?
- Where do the frontend and backend each enforce access control?
- How is a GitHub App installation bound to the current signed-in user?

### `repository-lifecycle.md`

- What steps does a repository go through from import to chat readiness?
- How do sandboxing, indexing, artifacts, sync, and deletion connect together?
- Which jobs and states are updated along this flow?

### `chat-and-analysis-pipeline.md`

- What data sources do Discuss (ungrounded and sandbox-grounded), Library Ask, and System Design generation depend on, and how do they differ?
- How is an assistant reply created, streamed, completed, or failed?
- Why can sandbox-grounded Discuss and System Design generation become unavailable because of sandbox state?

### `integrations-and-operations.md`

- What roles do GitHub, Daytona, and OpenAI each play?
- How do the HTTP callback/webhook, cron, and cleanup flows work?
- How are frontend `.env` variables and Convex runtime environment variables separated?

### `orphan-resource-handling.md`

- Why are orphan Daytona resources a system-design concern rather than a simple cleanup bug?
- Which failure modes create orphan external resources?
- How do DB-first provisioning, cleanup jobs, and reconciliation layers fit together?

### `vercel-convex-deployment-system-design.md`

- How should Vercel hosting and Convex deployment fit together without adding a second CD system?
- Why should browser callback URLs and server callback redirects use different sources of truth?

### `architecture-diagram-artifact-system-design.md`

- How is architecture diagram generation split between Convex orchestration and a pure generator?
- Which invariants keep graph output correct, bounded, and recoverable across backend and frontend?

## Writing Principles

- Use English.
- Prioritize stable architecture boundaries and responsibility splits rather than translating the codebase file by file.
- Do not invent designs that do not exist, and do not describe future ideas as current capabilities.
- Each document should stay focused on answering a small number of important questions and avoid repetition.

## Out of Scope

The following are intentionally outside the scope of this document set:

- API-by-API or function-by-function reference material
- SRE runbooks and incident playbooks
- Historical ADR records
- Detailed design notes for every individual UI component