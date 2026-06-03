# Security Overview Rubric

Scores how accurately a Security Overview describes the project's security posture from source — and how conservatively it surfaces gaps.

## Scoring Axes

- **Faithfulness (1-5)** — Auth, authorisation, validation, secrets claims must trace to real code. 5 = every claim sourced; 1 = invents security mechanisms the code doesn't have.
- **Completeness (1-5)** — All six required sections present. `Trust Boundaries & Abuse Controls` explains concrete defensive controls, and `Observed Gaps & Risks` is filled with source-grounded gaps OR explicitly says none observed. 5 = thorough across surfaces; 1 = sections missing.
- **Specificity (1-5)** — Names actual auth providers, middleware files, validator libraries. 5 = "WorkOS OIDC, session cookie set by `apps/api/src/middleware/auth.ts`"; 1 = "users authenticate to access the system".
- **Citation Quality (1-5)** — File paths backing each claim. 5 = every claim has a pointer; 1 = no paths.

## Failure Signals

- Speculates about gaps without source evidence ("might be vulnerable to CSRF" when no CSRF surface exists).
- Lists generic categories ("uses authentication", "validates inputs") instead of naming the libraries / middleware.
- `Secrets & Sensitive Data` omits the secret store the project clearly uses.
- `Trust Boundaries & Abuse Controls` omits external callback / webhook parameters, cross-tenant binding checks, replay protections, rate limits, or fail-closed behavior when the code clearly implements or lacks them.
- `Authorisation` confuses role check with auth check.
- Treats config as gap when the config explicitly says it's a non-goal.

## Excellence Signals

- Distinguishes session auth from API-key auth from webhook signature verification clearly.
- Identifies where authorisation is enforced (middleware vs. resolver vs. DB) precisely.
- Surfaces gaps that are real and source-grounded — TODO comments, missing rate limits, plaintext PII in logs.
- Explains how the system defends against forged callbacks / webhooks, cross-tenant identifiers, replay, resource amplification, and secret leakage with concrete files.
- Stays conservative: explicitly says "no gaps observed in X area" rather than padding with speculation.

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
