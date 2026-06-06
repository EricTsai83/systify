# Systify System Design

This folder contains the system design documentation for the current Systify codebase. The documents focus on the current state and are meant to help engineers quickly understand the system boundaries, core data model, key workflows, and external integrations.

For cross-cutting infrastructure concerns (LLM gateway, multi-provider strategy, rate limiting and fairness, System Design generation, cost tracking, and the eval harness), see [`architecture/`](./architecture/README.md) as the source of truth. The docs in this folder focus on product flows and reference the architecture docs where needed. For provider-level cost surfaces across WorkOS, GitHub, Convex, Daytona, LLM providers, and Vercel, see [`integrations/external-service-pricing.md`](./integrations/external-service-pricing.md).

## Document Structure

The docs are organized by responsibility. Root-level `docs/README.md` remains
the navigation entry point; focused design docs live under the narrowest
responsibility folder:

- **Core model**
  - `core/system-overview.md`
  - `core/domain-and-data-model.md`
  - `core/auth-and-access.md`
- **External services, operations, and provider cost**
  - `integrations/integrations-and-operations.md`
  - `integrations/external-service-pricing.md`
  - `integrations/github-app-integration-system-design.md`
  - `integrations/github-callback-returnto-allowlist-system-design.md`
  - `integrations/vercel-convex-deployment-system-design.md`
- **Repository and import lifecycle**
  - `repository/repository-lifecycle.md`
  - `repository/import-persistence-system-design.md`
  - `repository/repository-filecount-rollout-system-design.md`
  - `repository/repository-remote-freshness-check-system-design.md`
  - `repository/repository-persistence-system-design.md`
  - `repository/artifact-import-drift-system-design.md`
- **Chat, Library, and service modes**
  - `chat/chat-and-analysis-pipeline.md`
  - `chat/service-modes-discuss-library-system-design.md`
  - `chat/chat-context-retrieval-system-design.md`
  - `chat/streaming-reply-optimization-system-design.md`
  - `chat/instant-view-switching-system-design.md`
  - `chat/artifact-view-state-system-design.md`
- **Sandbox operations and safety**
  - `sandbox/sandbox-mode-system-design.md`
  - `sandbox/sandbox-mode-security-system-design.md`
  - `sandbox/sandbox-mode-runbook.md`
  - `sandbox/sandbox-provisioning-cleanup-system-design.md`
  - `sandbox/sandbox-tool-call-audit-log-system-design.md`
  - `sandbox/daytona-webhook-reconciliation-system-design.md`
  - `sandbox/orphan-resource-handling.md`
- **Client and UI state**
  - `client/client-storage-architecture.md`
  - `client/client-storage-strategy.md`
  - `client/archive-listing-system-design.md`
  - `client/landing-auth-hint-system-design.md`
- **Cross-cutting architecture source of truth**
  - `architecture/README.md`
  - `architecture/llm-gateway.md`
  - `architecture/multi-provider-strategy.md`
  - `architecture/rate-limiting-and-fairness.md`
  - `architecture/system-design-generation.md`
  - `architecture/cost-tracking.md`
  - `architecture/eval-workflow.md`

When adding a new document, choose the narrowest owner above. If the topic is a
cross-cutting mechanism shared by multiple features, put it under
`architecture/`; if it is a feature flow or operational boundary, keep it in
this folder and add it to the appropriate group.

## Recommended Reading Order

1. `core/system-overview.md`
2. `core/domain-and-data-model.md`
3. `core/auth-and-access.md`
4. `integrations/github-app-integration-system-design.md`
5. `repository/repository-lifecycle.md`
6. `chat/chat-and-analysis-pipeline.md`
7. `integrations/integrations-and-operations.md`
8. `sandbox/orphan-resource-handling.md`
9. `chat/service-modes-discuss-library-system-design.md`

## Additional Focused Design Docs

- `integrations/vercel-convex-deployment-system-design.md`
  - Why is the Vercel + Convex deployment model simple but still a system-design concern?
  - How should preview-safe callback URLs and environment ownership be split?
- `sandbox/daytona-webhook-reconciliation-system-design.md`
  - How should webhook ingress, durable inbox, projection updates, and cron backstops work together?
  - How do signature verification and organization allowlisting define the webhook trust boundary?
- `repository/import-persistence-system-design.md`
  - Why should import persistence be idempotent, batched, and finalized through a single publish boundary?
  - How does staged write plus cleanup preserve snapshot integrity under retries and failures?
- `chat/chat-context-retrieval-system-design.md`
  - How does query-aware retrieval improve chunk selection without introducing embeddings?
  - Why should retrieval stay bounded to the latest import snapshot?
- `repository/repository-filecount-rollout-system-design.md`
  - Why is `repositories.fileCount` published only at finalize instead of per-batch?
  - How does denormalization remove hot-path read amplification safely?
- `chat/streaming-reply-optimization-system-design.md`
  - Why are active stream state and durable history stored in separate tables?
  - How does compaction plus finalize-once keep streaming reliable?
- `integrations/github-callback-returnto-allowlist-system-design.md`
  - Why is URL-format validation alone insufficient for callback redirect trust?
  - How does origin allowlisting reduce open-redirect phishing-chain risk?
- `integrations/github-app-integration-system-design.md`
  - How does the GitHub App installation, callback, OAuth verification, and webhook flow work end to end?
  - How do installation tokens, repo discovery, access checks, and import snapshot fetching communicate with GitHub?
- `repository/repository-persistence-system-design.md`
  - Why is the viewer's "current repository" stored in both Convex and localStorage?
  - How does DB-wins reconciliation give cross-device continuity without a first-paint flash?
- `sandbox/sandbox-tool-call-audit-log-system-design.md`
  - Why does sandbox tool-call recording need a third table beyond `messageToolCallEvents` and `messages.toolCalls`?
  - How does best-effort writing plus a 90-day TTL keep compliance evidence durable without coupling to user-initiated deletes?
- `client/archive-listing-system-design.md`
  - Why does the archive view split into a reactive browse path and a non-reactive search path on top of one Convex paginated query?
  - How does post-filtering preserve correctness without adding a denormalized `isArchived` field or a migration?
- `repository/repository-remote-freshness-check-system-design.md`
  - Why is the "repo is behind the remote" check driven by client events plus two SHAs instead of webhooks, cron, or a persisted stale flag?
  - Why does sync immediately clear `latestRemoteSha` instead of waiting for import finalize to update freshness state?
- `chat/service-modes-discuss-library-system-design.md`
  - How do Discuss and Library map to routes, data dependencies, and the sandbox-grounding toggle?
  - Why does Library use metadata-only subscriptions and artifact-specific body reads?
- `sandbox/sandbox-mode-system-design.md`
  - How does sandbox grounding integrate with the Discuss composer and per-message toggle?
  - What is the lifecycle of a lazily provisioned Daytona sandbox?
- `sandbox/sandbox-provisioning-cleanup-system-design.md`
  - How is a fresh Daytona remote cleaned up when provisioning fails before `remoteId` is persisted?
  - Why does the action directly delete the known remote id even when a cleanup job is queued?
- `sandbox/sandbox-mode-security-system-design.md`
  - What trust boundary separates sandbox tool calls from the rest of the system?
  - How are sandbox secrets and execution scopes constrained?
- `sandbox/sandbox-mode-runbook.md`
  - What operational signals indicate sandbox provisioning or execution failures?
  - How are stuck or orphan sandboxes recovered?
- `repository/artifact-import-drift-system-design.md`
  - How is drift between imported artifacts and the current repository snapshot detected?
  - How does the Library surface drift to readers without blocking access?
- `chat/artifact-view-state-system-design.md`
  - How is per-user, per-artifact view state stored and reconciled across devices?
  - Why is view state separated from artifact body reads?
- `client/client-storage-architecture.md`
  - Which client-side stores hold which kinds of state, and where is the source of truth?
  - How do client storage layers degrade safely on quota or eviction?
- `client/client-storage-strategy.md`
  - What policy decides what is cached client-side versus refetched from Convex?
  - How does the strategy interact with auth and cross-device continuity?
- `chat/instant-view-switching-system-design.md`
  - How does instant view switching avoid first-paint flashes when navigating between modes or artifacts?
  - Which subscriptions stay hot versus get torn down on transition?
- `client/landing-auth-hint-system-design.md`
  - How does the landing page hint at auth state without leaking identity before sign-in?
  - Why is the auth-hint path separate from the authenticated session boot?
- `integrations/external-service-pricing.md`
  - Which external services can create provider bills or quota pressure?
  - Which Systify flows trigger each service's cost model, and where should LLM-specific pricing details live?

## Topic Index

Use this as a guided reading order for finding the doc that answers a specific topic. For cross-cutting infrastructure (LLM gateway, multi-provider strategy, rate limiting and fairness, System Design generation, cost tracking, eval harness), see the sibling [`architecture/`](./architecture/README.md) index — those docs are the source of truth for those areas, and the entries below cross-link rather than duplicate them.

- Rate limiting and lease recovery: `integrations/integrations-and-operations.md` (see also `architecture/rate-limiting-and-fairness.md` for the gateway-side fairness model)
- External service pricing and cost triggers: `integrations/external-service-pricing.md` (see also `architecture/cost-tracking.md` for LLM token math)
- Daytona orphan protection and reconciliation layers: `sandbox/orphan-resource-handling.md`
- Daytona provisioning failure cleanup: `sandbox/sandbox-provisioning-cleanup-system-design.md`
- Daytona webhook reconciliation path: `sandbox/daytona-webhook-reconciliation-system-design.md`
- Import persistence idempotency and finalize boundary: `repository/import-persistence-system-design.md`
- Chat context retrieval strategy: `chat/chat-context-retrieval-system-design.md`
- Service Modes: Discuss, Library, and System Design: `chat/service-modes-discuss-library-system-design.md`
- Repository file-count denormalization: `repository/repository-filecount-rollout-system-design.md`
- Chat streaming architecture: `chat/streaming-reply-optimization-system-design.md`
- Vercel + Convex deployment model: `integrations/vercel-convex-deployment-system-design.md`
- GitHub App installation, callback verification, webhooks, installation tokens, and repository API access: `integrations/github-app-integration-system-design.md`
- GitHub callback returnTo allowlist boundary: `integrations/github-callback-returnto-allowlist-system-design.md`
- Repository persistence and cross-device continuity: `repository/repository-persistence-system-design.md`
- Sandbox tool-call audit log retention and recording boundary: `sandbox/sandbox-tool-call-audit-log-system-design.md`
- Archive listing pagination, search, and view state machine: `client/archive-listing-system-design.md`
- Repository remote-freshness check trigger model and SHA comparison boundary: `repository/repository-remote-freshness-check-system-design.md`

## What Each Document Answers

### `core/system-overview.md`

- What runtimes and external services make up Systify?
- How do the main user actions flow through the frontend, Convex, and external services?
- Which modules form the backbone of the product?

### `core/domain-and-data-model.md`

- What are the core entities in the system?
- How does `ownerTokenIdentifier` enforce data isolation?
- Which tables carry workflow state?

### `core/auth-and-access.md`

- How are WorkOS and Convex connected?
- Where do the frontend and backend each enforce access control?
- How is a GitHub App installation bound to the current signed-in user?

### `repository/repository-lifecycle.md`

- What steps does a repository go through from import to chat readiness?
- How do sandboxing, indexing, artifacts, sync, and deletion connect together?
- Which jobs and states are updated along this flow?

### `chat/chat-and-analysis-pipeline.md`

- What data sources do Discuss (ungrounded and sandbox-grounded), Library Ask, and System Design generation depend on, and how do they differ?
- How is an assistant reply created, streamed, completed, or failed?
- Why can sandbox-grounded Discuss and System Design generation become unavailable because of sandbox state?

### `integrations/integrations-and-operations.md`

- What roles do GitHub, Daytona, and OpenAI each play?
- How do the HTTP callback/webhook, cron, and cleanup flows work?
- How are frontend `.env` variables and Convex runtime environment variables separated?

### `integrations/external-service-pricing.md`

- Which external providers have direct bills, usage meters, or quota pressure?
- Which Systify workflows trigger each provider's cost model?
- Which focused design docs own the implementation details behind each cost surface?

### `sandbox/orphan-resource-handling.md`

- Why are orphan Daytona resources a system-design concern rather than a simple cleanup bug?
- Which failure modes create orphan external resources?
- How do DB-first provisioning, cleanup jobs, and reconciliation layers fit together?

### `integrations/vercel-convex-deployment-system-design.md`

- How should Vercel hosting and Convex deployment fit together without adding a second CD system?
- Why should browser callback URLs and server callback redirects use different sources of truth?

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
