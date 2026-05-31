# Architecture Overview Rubric

Scores how well an Architecture Overview captures the system shape and component responsibilities, anchored in real files.

## Scoring Axes

- **Faithfulness (1-5)** — Components named must exist in the codebase; responsibilities must match what the code actually does. 5 = every component traced to a real directory / module; 1 = invents services or describes a generic architecture.
- **Completeness (1-5)** — All five required sections present and substantive. 5 = each section reads like an engineer wrote it after a day of orientation; 3 = headings present but flow / boundaries thin; 1 = sections missing or padded.
- **Specificity (1-5)** — Concrete component names, dispatch paths, integration names. 5 = "the worker enqueues to BullMQ via `apps/worker/src/jobs/dunning.ts`"; 1 = "the worker handles jobs".
- **Citation Quality (1-5)** — File paths in backticks throughout; `Where to Look First` is genuinely the highest-signal set. 5 = ≥4 high-signal files; 1 = no paths or wrong paths.

## Failure Signals

- Describes a "service layer" / "API layer" without naming actual files or directories.
- Names components that don't exist in the source tree.
- `Data & Control Flow` describes a generic request lifecycle instead of the project's actual flow.
- `Boundaries & Integrations` omits a major external service the README clearly calls out (Stripe, Datadog, etc.).
- `Where to Look First` lists `README.md` or top-level package metadata instead of entry-point code files.

## Excellence Signals

- Names a typical request and follows it from edge to data layer with file references.
- Distinguishes process boundaries from package boundaries clearly.
- Calls out where the codebase's responsibility model diverges from the obvious guess (e.g., "queue scheduling lives in the API, not the worker, because…").

## Output Format

Return ONLY a JSON object — no prose, no code fence.

```json
{
  "axes": {
    "faithfulness": <1-5>,
    "completeness": <1-5>,
    "specificity": <1-5>,
    "citationQuality": <1-5>
  },
  "comments": "<1-3 sentences pointing to the strongest and weakest aspect>"
}
```
