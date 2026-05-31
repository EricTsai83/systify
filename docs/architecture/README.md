# Systify Architecture

Architecture docs covering the LLM gateway, multi-provider strategy, rate limiting and fairness,
System Design generation, cost tracking, and the eval harness. These docs describe the system as
it is implemented in code today; anything design-described-but-not-yet-landed appears under an
explicit "(planned)" callout in the individual doc.

## Docs

- [LLM Gateway](llm-gateway.md) — single chokepoint that owns provider dispatch, fairness acquires, retry, usage normalization, and cost; SDK imports are confined to `convex/lib/llmGateway.ts` and enforced by a CI test.
- [Multi-Provider Strategy](multi-provider-strategy.md) — `MODEL_CATALOG` is the source of truth, `threads.lockedProvider` makes the first-write provider immutable for the thread's lifetime, and adding a third provider is bounded to a fixed five-file edit.
- [Rate Limiting & Fairness](rate-limiting-and-fairness.md) — three independent layers (per-user daily cost cap, per-user RPM, per-user concurrent in-flight) acquired in order by the gateway, plus `withLlmRetry` as the only defense against provider-side 429s.
- [System Design Generation](system-design-generation.md) — per-kind lifecycle (lease, cache probe, gateway call, quality gate, persist, telemetry), `(repositoryId, kind, alignedImportCommitSha, provider, model, promptVersion)` idempotency key, and stale-job auto-resume that skips already-cached kinds.
- [Cost Tracking](cost-tracking.md) — gateway-boundary capture, per-message and per-kind persistence, `getUserCostBreakdown` aggregation across `messages` and `systemDesignKindRuns`, and conservative `undefined`-on-miss semantics so pricing gaps surface as "cost unknown" instead of zero.
- [Eval Workflow](eval-workflow.md) — operator-driven harness in `convex/eval/systemDesign/` that sweeps `(corpus × kind × stepBudget)` through the same gateway, scores outputs with a pinned LLM judge against per-kind rubrics, and gates prompt merges on diff thresholds.

## How these docs relate to other docs/

The architecture docs in this directory are the SoT for cross-cutting infrastructure. Feature
docs (chat-and-analysis-pipeline.md, sandbox-mode-runbook.md, etc.) in the parent docs/
directory reference these for shared concerns. The sandbox-mode-runbook.md "How this interacts
with System Design generation" subsection cross-references system-design-generation.md.

## Format convention

Each doc opens with "Why this exists" (problem driving the design), then "How it works"
(mechanism + key files), then "Failure modes & recovery", then "Future evolution". Cite file
paths in backticks. No marketing language.
