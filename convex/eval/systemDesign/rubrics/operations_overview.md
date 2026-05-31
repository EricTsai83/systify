# Operations Overview Rubric

Scores how accurately an Operations Overview describes how the project is operated in production, sourced from logging / metrics / alerting code.

## Scoring Axes

- **Faithfulness (1-5)** — Logging, metrics, alerting claims match what the code actually emits. 5 = every claim traces to a logger/metrics call site or dashboard file; 1 = invents instrumentation that doesn't exist.
- **Completeness (1-5)** — All five required sections present. If a section has no evidence (e.g., no metrics emitted at all), the doc says so explicitly rather than padding. 5 = thorough or honestly empty; 1 = sections missing.
- **Specificity (1-5)** — Names actual logger libraries, metric names, alert thresholds. 5 = "`billing.api.request.duration_ms` histogram"; 1 = "the API has metrics".
- **Citation Quality (1-5)** — File paths backing each claim. 5 = every claim has a pointer; 1 = no paths.

## Failure Signals

- Lists a "logging strategy" without naming the logger library or middleware.
- Says metrics are emitted without citing a metrics call site.
- `Alerting & On-Call` invents monitor thresholds not defined in code.
- `Dashboards & Run-Books` lists generic dashboards instead of citing the actual `docs/oncall/` or dashboard config.
- Confuses log shipping pipeline with the logger library.

## Excellence Signals

- Differentiates trace / metric / log responsibilities clearly.
- Names actual metric histograms and what they measure, not just their existence.
- Surfaces specific run-books with the alert each addresses.
- If the project has no metrics or no run-books, says so directly instead of padding.

## Output Format

Return ONLY a JSON object — no prose, no code fence.

```
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
