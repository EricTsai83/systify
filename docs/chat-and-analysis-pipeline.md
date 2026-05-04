# Chat And Analysis Pipeline

## Purpose

This document describes the two AI interaction paths currently available in Systify:

- Chat — interactive Q&A with three selectable modes:
  - `discuss` (UI label "General Chat") — training-only, no repo context
  - `docs` (UI label "Design Docs") — answers grounded in design artifacts (ADRs, diagrams, deep analyses)
  - `sandbox` (UI label "Sandbox") — answers grounded in the live sandbox source tree (tools wired in Plan 04 of the chat-modes rollout)
- Deep analysis — a sandbox-backed background job that produces a reusable `deep_analysis` artifact

Both are repository-centered, but they depend on different data sources and execution models. Chat and deep analysis are also complementary: deep analysis writes artifacts that later `docs`/`sandbox` chat replies can cite.

## Differences Between the Two Paths


| Capability               | Chat (per mode)                                                                                                                                | Deep analysis                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Main entry point         | `chat.sendMessage`                                                                                                                             | `analysis.requestDeepAnalysis`              |
| Primary data source      | `discuss`: none · `docs`: design `artifacts` only · `sandbox`: design `artifacts` + `repoChunks` + (Plan 04+) live sandbox tools               | live sandbox                                |
| Execution location       | Convex action                                                                                                                                  | Convex Node action + Daytona                |
| UI presentation          | stable history + active stream merge                                                                                                           | a new deep-analysis artifact plus job state |
| Availability requirement | `discuss`: always · `docs`: repository has completed import · `sandbox`: repository has completed import **and** a usable sandbox              | repository has a usable sandbox             |


## Chat Flow

```mermaid
flowchart TD
  UserQuestion[UserQuestion]
  CreateJob[CreateChatJob]
  InsertMessages[InsertUserAndAssistantPlaceholder]
  Schedule[ScheduleGenerateReply]
  LoadContext[LoadReplyContext]
  SelectChunks[SelectRelevantChunks]
  Generate[GenerateReply]
  Stream[AppendAssistantStreamChunk]
  Compact[CompactActiveStreamTail]
  ToolStart[AppendToolCallStartEvent]
  ToolEnd[AppendToolCallEndEvent]
  Usage[CaptureFinalUsageIfAvailable]
  Complete[finalizeAssistantReply]
  Fold[FoldEventsIntoMessageToolCalls]
  Drain[DrainToolCallEvents]

  UserQuestion --> CreateJob
  CreateJob --> InsertMessages
  InsertMessages --> Schedule
  Schedule --> LoadContext
  LoadContext --> SelectChunks
  SelectChunks --> Generate
  Generate --> Stream
  Generate -. sandbox tools .-> ToolStart
  ToolStart -. result/error .-> ToolEnd
  Stream --> Compact
  Compact --> Usage
  ToolEnd --> Usage
  Usage --> Complete
  Complete --> Fold
  Fold --> Drain
```



### 1. The user sends a message

When `sendMessage` is called, the system first verifies:

- the thread exists
- the repository for that thread exists
- the repository owner matches the current signed-in user

It then creates three core records:

- one `chat` job
- one user message
- one assistant placeholder message

The assistant placeholder starts as:

- `role = assistant`
- `status = pending`
- `content = ""`

This allows the UI to immediately show a reply that is waiting to be generated.

### 2. Generate the assistant reply in the background

`internal.chat.generation.generateAssistantReply` takes over the rest of the flow. It starts by:

- marking the assistant message as `streaming`
- marking the job as `running`

### 3. Build the reply context

`getReplyContext` assembles the reply context based on the **effective mode** for the reply (`latestUserMessage.mode ?? thread.mode`, exposed on `ReplyContext.mode`):

- `discuss`: skips every repo-scoped lookup — returns empty `artifacts`, empty `chunks`, and no repo summaries. The early return is what makes `discuss` training-only by design even when the thread has a `repositoryId` attached.
- `docs`: artifact-only retrieval — loads up to 12 design artifacts across the docs kinds (`architecture_diagram`, `adr`, `failure_mode_analysis`, `deep_analysis`, `architecture_overview`, `design_review`, `migration_plan`, `trade_off_matrix`, `capacity_estimate`). Indexed code chunks are intentionally skipped so docs answers cannot drift away from the user-produced design layer.
- `sandbox`: artifacts from the latest import job plus recent `deep_analysis` artifacts, **and** `repoChunks` from the latest import for the chunk-selection step below.

In every mode, the context also includes recent conversation messages bounded by `MAX_CONTEXT_MESSAGES`. The chat pipeline never reads the raw repository directly — it reads the repository's already-processed knowledge layer (artifacts + chunks) and, in `sandbox` mode (Plan 04 onward), the live sandbox via the read-only `read_file` and `list_dir` tools plus the `run_shell` tool. Tool output is scrubbed for credential-shaped patterns before reaching the LLM. Tool response payloads also carry an audit signal in their `redactedTypes` field — a sorted, de-duplicated list of matched pattern slugs — so integrators can see what kinds of content were redacted without learning what (see `sandbox-mode-security-system-design.md` for full details). `run_shell` is available under sandbox mode and is gated by the `SANDBOX_MODE_ENABLED` flag, the per-viewer `SANDBOX_BETA_ALLOWLIST` (see `convex/lib/sandboxFeatureFlag.ts`), and the layered protections (deny list of destructive patterns, 32 KiB output cap, 60 s timeout, repo-pinned workdir) described in `docs/sandbox-mode-system-design.md` and `docs/sandbox-mode-security-system-design.md`.

### 4. Select chunks (sandbox mode only)

Chunk selection runs only when the effective mode is `sandbox`. `discuss` returns no chunks because it skips repo context entirely; `docs` returns no chunks because it is artifact-only by design (so docs answers and sandbox answers stay non-overlapping).

In `sandbox` mode the pipeline uses a two-step retrieval flow:

1. build a bounded candidate pool from the latest import snapshot
2. rerank that candidate pool locally before building the prompt

The candidate pool is assembled from:

- baseline chunks from the head and tail of `by_importId_and_path_and_chunkIndex`
- `repoChunks.search_summary` hits filtered by `importId`
- `repoChunks.search_content` hits filtered by `importId`

This matters because query-aware retrieval must not break the import snapshot boundary. Search is therefore always scoped to `repository.latestImportId`, so old snapshots cannot leak back into chat context.

This is not a full RAG ranking pipeline. It is a lightweight relevance selector whose main goals are:

- reducing prompt size
- improving answer focus
- keeping read cost bounded without introducing embeddings yet

### 5. Generate the answer

If `OPENAI_API_KEY` exists, the system:

- uses `streamText`
- selects `OPENAI_MODEL` or falls back to `gpt-5.4-mini`
- builds a **per-mode** system prompt via `buildSystemPrompt(replyContext.mode)` so the model receives a different contract per mode (`discuss` is told there is no repo and to refuse to fabricate "your codebase" references; `docs` is told design artifacts are the sole source of truth; `sandbox` is told tools are coming and to flag any claim it would normally verify with a tool call)
- builds a user prompt from artifacts, chunks, and the user question

If `OPENAI_API_KEY` is absent, the system falls back to a heuristic answer so it can still produce a response based on indexed data.

### 6. Stream, compact, and complete

The answer is no longer streamed directly into `messages.content`. Instead:

1. model output is accumulated in memory
2. a flushed delta is appended to `messageStreamChunks`
3. older tail chunks are periodically compacted into `messageStreams.compactedContent`
4. only the final durable write patches `messages.content`

When the provider exposes finalized token usage, the pipeline also writes usage and estimated cost fields during finalization:

- `messages.estimatedInputTokens`
- `messages.estimatedOutputTokens`
- `jobs.estimatedInputTokens`
- `jobs.estimatedOutputTokens`
- `jobs.estimatedCostUsd`

If usage is unavailable, or the model is not present in the local pricing table, the reply still succeeds and those fields remain empty.

When the flow completes, it updates:

- the assistant message `status = completed`
- `thread.lastAssistantMessageAt`
- the job `status = completed`
- and deletes the active stream state

If an error occurs midstream, both the assistant message and the job are marked failed.

### 7. Tool-call trace (sandbox mode only)

When the reply runs in `sandbox` mode and the AI SDK's `fullStream` surfaces `tool-call` / `tool-result` / `tool-error` events, the pipeline persists each event into a separate `messageToolCallEvents` table. This is the same hot/durable split that `messageStreamChunks` uses for text deltas (see `streaming-reply-optimization-system-design.md`):

1. `tool-call` arrives → `appendAssistantToolCallEvent` writes a `start` row keyed by the AI SDK's `toolCallId`
2. matching `tool-result` or `tool-error` arrives → a paired `end` row is written with the redacted `outputSummary`
3. the live `<ToolCallTrace>` component subscribes to `getMessageToolCallEvents` so the UI paints a "Reading X.ts…" ticker the moment the `start` row commits, without waiting for the tool to finish
4. at finalize time (or fail / stale recovery), `foldAndDrainToolCallEvents` pairs each `start` to its `end` by `toolCallId`, writes the result onto durable `messages.toolCalls`, and drains every event row in the same transaction so the live subscription cannot lag past the message's terminal state

Pairing by `toolCallId` (rather than by `toolName`) preserves multiple invocations of the same tool — e.g. two `read_file` calls in one reply appear as two distinct `messages.toolCalls` entries. Each event's `inputSummary` and `outputSummary` are passed through `redact()` and capped at `TOOL_CALL_EVENT_SUMMARY_MAX_CHARS` before insertion so a runaway tool result cannot push the message document past Convex's 1 MB row limit.

A defensive `MAX_TOOL_CALL_EVENTS_PER_MESSAGE` cap bounds reads and folds; if a buggy producer ever exceeds it, `tool_event_fold_truncated` is logged from finalize / fail / recover so the truncation is observable. The drain step still sweeps every row regardless of the read cap, so events never outlive their parent message.

For the security rationale behind redaction at every persistence point, and for the threat model that motivates the `redactedTypes` audit signal, see `sandbox-mode-security-system-design.md`.

## Message state model

The assistant reply state transition is roughly:

```mermaid
flowchart TD
  Pending[pending]
  Streaming[streaming]
  Completed[completed]
  Failed[failed]

  Pending --> Streaming
  Streaming --> Completed
  Pending --> Failed
  Streaming --> Failed
```



This state model lets the UI faithfully represent four different states: created-but-not-yet-answered, answering, answered, and failed.

## Deep Analysis Flow

```mermaid
flowchart TD
  Request[RequestDeepAnalysis]
  CheckSandbox[CheckDeepModeAvailability]
  ExtendTTL[ExtendSandboxTTL]
  CreateJob[CreateDeepAnalysisJob]
  RunNodeAction[RunDeepAnalysis]
  FocusedInspection[RunFocusedInspectionInSandbox]
  PersistArtifact[InsertDeepAnalysisArtifact]
  Finish[CompleteJob]

  Request --> CheckSandbox
  CheckSandbox --> ExtendTTL
  ExtendTTL --> CreateJob
  CreateJob --> RunNodeAction
  RunNodeAction --> FocusedInspection
  FocusedInspection --> PersistArtifact
  PersistArtifact --> Finish
```



### 1. Request deep analysis

`requestDeepAnalysis` first checks:

- that the repository belongs to the current signed-in user
- that `latestSandboxId` exists
- that the sandbox state allows deep mode

If the sandbox is unavailable, the mutation throws immediately instead of creating an analysis workflow that cannot run.

If validation succeeds, the mutation also extends `sandboxes.ttlExpiresAt` to at least 30 minutes in the future before queuing work. This reduces the race where the request is accepted but the sandbox gets swept before `runDeepAnalysis` starts.

### 2. Create the job

After validation passes, the system creates:

- one `deep_analysis` job
- and points `repository.latestAnalysisJobId` to it

### 3. Run focused inspection inside the sandbox

`analysisNode.runDeepAnalysis`:

- marks the job as running
- checks sandbox availability again
- calls `runFocusedInspection(remoteSandboxId, repoPath, prompt)`

This inspection is not a large direct LLM analysis over the whole repository. It first finds more relevant file paths inside the sandbox based on the prompt, then produces a focused inspection log.

### 4. Persist the artifact

The analysis result is ultimately written as:

- `artifacts.kind = deep_analysis`
- `source = sandbox`

That means deep analysis output does not exist only at execution time. It becomes reusable repository knowledge for later flows.

## Sandbox Availability

Two distinct surfaces depend on a live Daytona sandbox: the chat `sandbox` mode and the deep-analysis background job. Both gate themselves on the same sandbox state, but through separate code paths (`chatModeResolver.resolveChatModes` for chat, `requestDeepAnalysis` for analysis). If the sandbox:

- has passed its TTL
- is archived
- has failed
- is missing required remote path information

then `sandbox` mode is removed from the chat mode selector (with a per-state tooltip surfaced through `disabledReasons`) and `requestDeepAnalysis` rejects new analysis requests.

The frontend `ChatPanel` uses this state to tell the user to:

- sync the repository to provision a new sandbox, or
- switch to `discuss` (training-only) or `docs` (artifact-grounded) for a degraded but still useful answer

## How The Two Pipelines Complement Each Other

Chat and deep analysis are not mutually exclusive. They form layered capabilities:

- Chat (`discuss` / `docs` / `sandbox`): fast, interactive, with cost and grounding scaling per mode
- Deep analysis: slower and sandbox-dependent, but able to add observations closer to the live repository state

Artifacts produced by deep analysis flow back into later chat context (`docs` mode loads `deep_analysis` among its docs kinds, and `sandbox` mode also pulls them), so the overall system forms a cumulative knowledge loop.

## Known Limitations

- `sandbox` mode is in private beta. Live tooling (`read_file`, `list_dir`, `run_shell`) is gated by the `SANDBOX_MODE_ENABLED` flag and an explicit per-viewer allowlist (`SANDBOX_BETA_ALLOWLIST`); see `convex/lib/sandboxFeatureFlag.ts`. Viewers outside the allowlist see the mode disabled with a tooltip explaining the beta status. `run_shell` is gated by a deny list of obviously-destructive patterns (`rm -rf /`, fork bombs, `mkfs`, `dd`, `sudo`, system shutdown, network pipe-to-shell), a 32 KiB combined-output cap, a 60 s ceiling on per-call timeout, and a workdir pinned inside the repository — see `docs/sandbox-mode-system-design.md` for the layered defenses and `docs/sandbox-mode-security-system-design.md` for the content boundary.
- Chat and deep analysis are both AI features, but their outputs and tracking models are still split between thread replies and artifacts.
- Deep analysis is currently closer to focused file discovery plus a markdown report than to a full agentic repository-reasoning pipeline.

