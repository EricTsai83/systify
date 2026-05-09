# Plan — Extend output redaction / secret scanning

Status: draft (not started). Owner: TBD. Target: post-private-repo-launch hardening.

## Why this plan exists

Today (`convex/chat/redaction.ts`) the sandbox tool layer already runs every
`read_file` / `list_dir` / `run_shell` return value through a `redact()`
chokepoint with five built-in patterns:

| Pattern         | Slug             |
| --------------- | ---------------- |
| GitHub tokens   | `github_token`   |
| JWT             | `jwt`            |
| AWS access keys | `aws_access_key` |
| Slack tokens    | `slack_token`    |
| Bearer tokens   | `bearer_token`   |

This is a strong skeleton, but for SaaS-grade posture (especially private
repos), the pattern coverage is too narrow and the redaction surface is
too small. Two concrete gaps motivate this plan:

1. **Pattern coverage is thin.** Common LLM/AI keys, cloud provider keys
   (GCP, Azure), Stripe / Twilio / Sendgrid, generic database connection
   strings with passwords, and PEM private key blocks are all unredacted
   today. A `.env` file in a private repo with a Stripe live key flowing
   into a chat reply is the kind of finding that a SOC 2 auditor will
   raise.
2. **Redaction only happens on the way *into* the LLM.** The model still
   sees secrets if a chat reply paraphrases or quotes file content
   verbatim. The reply itself is not currently scanned before persistence
   into the `messages` table.

Output redaction is the durable boundary; the network block (now wired
post-clone) is the run-time boundary. Both need to be strong.

## Goal

After this plan ships:

- Every secret of meaningful blast radius (cloud keys, AI keys, payment
  processor keys, PEM private keys, database URIs with credentials) has a
  redaction pattern with a test pinning it.
- The `messages` table never persists a raw secret, regardless of which
  layer originally surfaced it (tool output OR model-generated text OR a
  reasoning trace).
- The audit log (`sandboxToolCallLog.redactedFields` per Plan 12) records
  every redaction event with its slug and a count, without ever recording
  the raw matched value.

## Approach

### Layer 1 — pattern registry expansion

Extend `convex/chat/redaction.ts` with new entries. Each entry must come
with at least one positive test, one negative test, and an order
rationale (specific patterns before generic ones, see existing comment).

Patterns to add, in order of urgency:

| Type slug              | Pattern (sketch)                                             | Notes                                                                                       |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `openai_api_key`       | `sk-(?:proj-\|svcacct-\|admin-)?[A-Za-z0-9_-]{32,}`            | Anchor on `sk-` prefix; OpenAI rotates the family selector but `sk-` is stable.             |
| `anthropic_api_key`    | `sk-ant-[a-z0-9-]+-[A-Za-z0-9_-]{32,}`                       | Live keys carry an `api03` family token + dashes.                                           |
| `stripe_key`           | `(?:sk\|rk\|pk)_(?:live\|test)_[A-Za-z0-9]{24,}`                | `sk_live_…` is the high-risk variant.                                                       |
| `gcp_service_account`  | `"private_key": "-----BEGIN PRIVATE KEY-----[\\s\\S]+?-----END PRIVATE KEY-----"` | Multi-line; needs `s` flag.                                                |
| `azure_storage_key`    | `[A-Za-z0-9+/]{86}==`                                        | 88-char base64; high false-positive risk → require `AccountKey=` context anchor.            |
| `pem_private_key`      | `-----BEGIN (?:RSA \|EC \|OPENSSH \|DSA )?PRIVATE KEY-----[\\s\\S]+?-----END [^-]+-----`  | Greedy across lines.                                                       |
| `db_connection_string` | `(?:postgres\|postgresql\|mysql\|mongodb(?:\\+srv)?\|redis)://[^\\s:@]+:[^\\s@]+@[^\\s]+` | Catches `user:pass@host` form; do not match passwordless URIs.        |
| `npm_token`            | `npm_[A-Za-z0-9]{36}`                                        | Pre-2026 format pinned by npm.                                                              |
| `pypi_token`           | `pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}`                     | Token starts with the fixed base64 prefix encoding `pypi.org`.                              |
| `huggingface_token`    | `hf_[A-Za-z0-9]{34,}`                                        | New prefix style; older tokens fall through to bearer-token catch-all.                      |
| `discord_bot_token`    | `[A-Za-z0-9]{24}\\.[A-Za-z0-9_-]{6}\\.[A-Za-z0-9_-]{27,}`    | 3-segment dotted; needs to run before generic JWT.                                          |

Each new entry widens the `RedactionType` literal union — that's the
compile-time gate that keeps Plan 12's audit log consumer in sync.

### Layer 2 — assistant-reply scanning

Add a second redaction call on the *outbound* path: between
`generateText` and the `messages` insert. The chokepoint is the
`chat/send.ts` (or equivalent) action where the LLM's reply text is
persisted.

Key design points:

- **Run the same `redact()` function**, not a parallel implementation.
  One source of truth for the pattern table.
- **Do not retroactively scan history.** Patterns can change; old
  messages stay as-is. Document this decision so future operators know
  not to "backfill" by re-redacting.
- **Reply that gets fully redacted (>50% of bytes turn into sentinels)
  should fail-soft**: log a warning, replace the message with
  `"[redacted: response contained too many secrets to be useful]"`, and
  preserve the `redactedTypes` for audit. This is the signal to the
  operator that the prompt isn't strong enough — without this, the LLM
  might paraphrase the secret with enough surrounding context that the
  redaction sentinel still leaks the *shape* of what was there.

### Layer 3 — provider-side reasoning trace

OpenAI / Anthropic structured-reasoning traces are stored alongside the
main reply. If we persist them (today: ?), they need the same scan. Open
question: do we persist reasoning traces at all? If yes, treat them as
another redact() input. If no, document the choice.

### Layer 4 — audit observability

The Plan 12 `sandboxToolCallLog.redactedFields` lift already covers tool
calls. Extend the log record (or add a parallel one) for the
assistant-reply path so the audit trail captures both directions of the
data flow. Each entry records:

- timestamp
- direction (`tool_output` | `assistant_reply`)
- redaction slugs (closed-set union — never the raw match)
- count per slug
- workspace / user / message id linkage

## Implementation tasks

1. **Pattern registry expansion** (PR 1, ~1 day):
   - Add the 11 patterns from the table to `PATTERN_REGISTRY` in
     `convex/chat/redaction.ts`. Order matters; specific before generic.
   - Widen `RedactionType` union accordingly.
   - For each pattern: ≥1 positive test, ≥1 negative test, documented
     ordering rationale in a comment.
   - Update existing `redaction.test.ts` "no self-match on the
     `[REDACTED:type]` sentinel" invariant to cover new slugs.

2. **Assistant-reply scanning** (PR 2, ~1 day):
   - Identify the persistence chokepoint in `convex/chat/send.ts` (or
     wherever the model reply lands in `messages`).
   - Wrap the persisted text in `redact()`. Surface `redactedTypes`
     onto the message row schema (Plan 12-aligned).
   - Tests: a reply containing each pattern is scrubbed before the row
     is inserted.

3. **Reasoning-trace decision** (PR 2 or PR 3):
   - Audit whether reasoning traces are persisted today.
   - Either run them through `redact()` too, or write a one-paragraph
     decision in `docs/sandbox-mode-security-system-design.md` explaining
     why we don't.

4. **Audit log extension** (PR 3, ~½ day):
   - Add `direction` field to `sandboxToolCallLog` (or an analog on
     the assistant-reply path).
   - Backfill is unnecessary: the audit log is forward-looking.

5. **Threat model doc update** (PR 1 or last):
   - Update `docs/sandbox-mode-security-system-design.md` to list the
     new patterns and the outbound scanning. Add a "known false-negative
     patterns" note for things deliberately not redacted (UUIDs, public
     keys, repo paths) so future incident reviews don't conclude that
     "we should redact everything".

## Acceptance criteria

- All 11 new pattern types have green positive + negative tests.
- A test demonstrates that an assistant reply containing a fake
  `sk-ant-…` Anthropic key is stored in `messages` already redacted to
  `[REDACTED:anthropic_api_key]`.
- `RedactionType` union is the single source of truth — TypeScript
  catches any audit-log consumer that references a removed slug.
- Documentation reflects the redaction surface (both directions).

## Decisions to revisit

- **False positives.** The Azure storage key pattern has a real risk of
  matching unrelated 88-char base64 strings. Whether to gate on
  `AccountKey=` context anchor (lower recall, higher precision) or run
  permissively (higher recall, more false positives) is a per-deployment
  call. Default: gated.
- **Assistant-reply truncation.** If a reply exceeds 50% redaction
  density, do we fail-soft (replace) or fail-hard (return an error)?
  Default proposal: fail-soft + audit. Revisit if this masks a model
  regression in production.
- **Internationalised patterns.** Some payment / API providers use
  region-specific prefixes (e.g., Razorpay `rzp_live_`, Paystack
  `sk_live_` collides with Stripe). Coverage strategy depends on
  customer geography; out of scope for v1.

## Out of scope

- Path-based blocklists (`.env`, `.aws/credentials`, etc.). The
  current architecture deliberately rejects path blocklists in favor
  of content scanning — see the rationale in
  `docs/sandbox-mode-security-system-design.md`.
- Vault / KMS integration for sandbox-side secrets. Systify never
  surfaces its own secrets into the sandbox, so vault integration is
  not a current threat-model contributor.
- Automatic secret rotation on detection. That belongs to the
  customer's own incident response, not to Systify's chat layer.

## Estimated total

3 PRs, ~2.5 days of focused engineering, plus 1 doc-only PR. The biggest
risk is regex false-positives on the new permissive patterns (Azure
storage key, generic Bearer); plan to canary on a staging deployment for
a few days before turning it on for paying customers.
