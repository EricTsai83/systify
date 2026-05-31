# API Surface Overview Rubric

Scores how completely and accurately an API Surface Overview enumerates the externally-visible entry points.

## Scoring Axes

- **Faithfulness (1-5)** — Every endpoint listed must exist in the routing code. Auth requirements match the middleware. 5 = no invented endpoints; 1 = lists routes that don't exist or wrong auth.
- **Completeness (1-5)** — All five required sections present. Endpoint list covers every public surface (HTTP routes, RPC, GraphQL, library entry points). 5 = nothing material omitted; 1 = misses entire surface (e.g., REST when the project is GraphQL+REST).
- **Specificity (1-5)** — Endpoint paths, method verbs, validator references. 5 = "POST /webhooks/stripe → `apps/api/src/stripe/webhook.ts`"; 1 = "the API has endpoints".
- **Citation Quality (1-5)** — File paths backing each claim. 5 = every endpoint and auth claim has a source path; 1 = paths missing or wrong.

## Failure Signals

- Invents endpoints not present in the routing code.
- Describes auth as "requires authentication" without naming the middleware or scheme.
- `Request / Response Shapes` says "JSON" with no reference to validators or generated types.
- `Error Handling` invents an error envelope shape the code doesn't actually emit.
- Misses the existence of a major surface (e.g., describes only REST when GraphQL exists).

## Excellence Signals

- Notes auth gaps explicitly (e.g., "`/healthz` is open" or "the bot key has implicit viewer access").
- Distinguishes generated input/output types from hand-written validators.
- Calls out the asymmetry where webhook handlers return 200 on application-level failure (queue-for-retry) versus 4xx on auth failure.

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
