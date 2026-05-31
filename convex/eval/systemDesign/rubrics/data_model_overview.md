# Data Model Overview Rubric

Scores how well a Data Model Overview describes the actual persistent data shape, sourced from schema files in the repository.

## Scoring Axes

- **Faithfulness (1-5)** — Entities named must exist in schema / migration files. Relationships and invariants match the code. 5 = every claim sourced to a schema line; 1 = fabricates tables or columns.
- **Completeness (1-5)** — All five required sections present and substantive. 5 = covers stores, entities, paths, and invariants with depth; 3 = topical only; 1 = sections missing.
- **Specificity (1-5)** — Names actual tables, columns, indexes. 5 = "`stripe_events.event_id` is `UNIQUE`"; 1 = "events have unique ids".
- **Citation Quality (1-5)** — `Where to Look First (file references)` names actual schema/migration files. 5 = clear path-to-claim mapping; 1 = no paths or wrong files.

## Failure Signals

- Lists tables that don't exist in the schema file.
- Describes generic relationships ("users have orders") without naming the actual entities.
- `Notable Invariants` is empty or invents constraints not enforced in code.
- `Read & Write Paths` describes a generic CRUD flow without naming the codebase's actual write sites.
- Confuses ORM models with database tables when the two differ.

## Excellence Signals

- Calls out denormalisations and explains the trade — "`subscription.last_invoice_status` mirrors `invoices.status` to avoid the join".
- Quotes / paraphrases trigger definitions or DB-level CHECK constraints, not just app-layer checks.
- Surfaces non-obvious invariants that look subtle in the schema but matter operationally.

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
