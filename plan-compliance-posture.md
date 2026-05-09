# Plan — Compliance posture (SOC 2, GDPR, retention)

Status: draft (not started). Owner: TBD. Target: pre-paid-launch / pre-enterprise-pilot.

## Why this plan exists

SysTify ingests private GitHub repositories, runs them through a sandboxed
analysis pipeline, persists chat history quoting the source, and re-uses
that history across sessions. That places SysTify squarely in the
"trust-sensitive B2B SaaS" bucket: any prospective enterprise customer
will ask the standard set of questions (where does my code go, who can
read it, how long do you keep it, who do you share it with, can I delete
it). Today the answers exist *implicitly in the architecture*; they are
not documented, not machine-enforced, and not externally verifiable.

This is a documentation-and-controls plan, not a re-architecture. The
existing security primitives (per-tenant sandboxes, throwaway lifecycle,
token scrub, post-clone network block, output redaction) are reasonable
SOC 2 building blocks. What is missing is the **declared posture** that
turns those primitives into auditable controls, plus a small set of
runtime affordances (data deletion, retention, DPA-compliant logging)
that compliance frameworks require.

## Goal

After this plan ships, SysTify can credibly answer the following with a
written, dated, version-controlled response:

| Question                                                              | Answer artifact                                |
| --------------------------------------------------------------------- | ---------------------------------------------- |
| Where is customer data stored? Who is the processor?                  | Sub-processor list (DPA Schedule)              |
| What's the data flow for a single chat reply?                         | Data-flow diagram (text + mermaid)             |
| How long is data retained? Can a user delete it?                      | Retention policy + working `deleteUser` flow   |
| Who can access customer code?                                         | Access control matrix + audit log spec         |
| What happens to my data if I cancel?                                  | Off-boarding flow + retention countdown        |
| Are model providers training on my code?                              | Provider zero-retention agreements + DPA       |
| Where do you log? What do logs contain?                               | Logging policy + redaction inventory           |
| What's your incident response plan?                                   | IR runbook + customer notification SLO         |
| What sub-processor changes have you made?                             | Change log + customer notification mechanism   |

This is the entry-level compliance pack — sufficient for SOC 2 Type 1
attestation prep and for most enterprise procurement reviews. SOC 2
Type 2, ISO 27001, HIPAA, and FedRAMP are out of scope for v1.

## Approach

### Stream A — declared posture (documentation)

Create a top-level `compliance/` folder with the following files. None
of these require code changes — they are policy statements that the
team commits to and that customer-facing material can link to.

| File                            | Purpose                                                                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `data-flow.md`                  | Per-feature data flow (chat reply, deep analysis, repo import). Mermaid diagram + prose. Names every external system the data touches.                                              |
| `sub-processors.md`             | Convex, WorkOS, Daytona, OpenAI, GitHub. Each row: location, function, what data they see, how they handle it. Versioned — append-only with effective dates.                         |
| `retention-policy.md`           | Per-table retention. `messages` (default: keep until user deletion, configurable per workspace), `sandboxes` (auto-deleted, ≤48 h), `audit logs` (≥1 year for SOC 2), GitHub tokens. |
| `access-control.md`             | Who within Anthropic / SysTify ops can access customer data, under what controls (admin breakglass), with what logging.                                                              |
| `incident-response.md`          | IR runbook. Categories (data exposure, availability, sub-processor breach), customer-notification SLO (proposal: 72 h for confirmed exposure).                                       |
| `dpa-template.md`               | Customer-facing data processing agreement template. Aligned to GDPR Art. 28. Sub-processors flow-down via reference to `sub-processors.md`.                                          |
| `provider-zero-retention.md`    | Per-provider attestation: OpenAI zero-retention API mode, Anthropic no-training default, GitHub App scope. Links to provider docs as supporting evidence.                            |
| `change-log.md`                 | Append-only log of compliance-relevant changes (sub-processor additions, retention changes, security incidents). The audit trail itself.                                             |

These docs **must** match the implementation. A retention policy that
says "30 days" while the database keeps things forever is worse than no
policy. The acceptance criterion is "the words match the runtime".

### Stream B — runtime affordances (code)

Three pieces of code that the documentation depends on.

#### B1 — User-initiated deletion

Right to erasure (GDPR Art. 17) requires a working delete-my-data flow.
Today there is `deleteRepository` (already implemented) but no
account-level deletion.

Tasks:
- Convex mutation `deleteUser(userId)` — cascades to `repositories`,
  `messages`, `sandboxes`, `workspaces`, `jobs`, audit logs (with a
  retention-policy carve-out — see B2).
- WorkOS-side: revoke session, mark account closed.
- GitHub: revoke installation tokens, prompt user to uninstall App.
- UI affordance: a clearly-labeled "Delete my account" with a typed
  confirmation. After the action, redirect to a "deletion in progress"
  page that polls until cleanup completes.
- Ops-side: a job that scans for orphaned Daytona sandboxes after a
  user deletion and force-deletes any that survived the cascade
  (defense in depth — Convex deletions don't fail if Daytona is
  unreachable, but cleanup must still happen).

Tests:
- After deletion, no row referencing the user remains in any user-data
  table; no Daytona sandbox carries the user's labels.
- A subsequent re-signup with the same email starts from zero state
  (no resurrection of old workspaces).

#### B2 — Retention enforcement

Today, `messages` is durable indefinitely. A retention policy without an
enforcer is a wish, not a control.

Tasks:
- Add a `retainUntil` column to `messages`, defaulting to
  `createdAt + DEFAULT_MESSAGE_RETENTION_DAYS` (proposal: 365 days).
- Add a workspace-level override for paying customers (e.g., 30-day
  short retention, 7-year long retention for compliance customers).
- A scheduled Convex cron that deletes messages where
  `retainUntil < now()`. Same for `sandboxToolCallLog` once Plan 12
  ships.
- Audit logs themselves have a *minimum* retention (SOC 2 expects
  ≥1 year). The cron must respect floors as well as ceilings.

Tests:
- Cron correctly deletes only past-due rows; respects floors.
- A workspace retention override applies on the next cron run (no
  retroactive deletion of historical rows whose retention was longer).

#### B3 — Audit log scaffolding

Plan 12's `sandboxToolCallLog` covers the LLM-tool path. Compliance
expects audit logs for the following events as well, which Plan 12
doesn't cover:

- Authentication (sign-in, sign-out, failed attempts)
- Authorization changes (workspace member adds/removes)
- Data export / share-link creation
- Account deletion
- Admin-side access to customer data (breakglass)

Tasks:
- New `auditEvents` table. Closed-set `eventType` union, append-only
  (no `update` / `delete` mutations exposed).
- Wire the events above to insert rows on the relevant Convex action
  paths. Each row records: actor (user id or `system`), target
  (workspace / repo id), `eventType`, success/failure, optional
  redacted metadata.
- Retention floor: 1 year (configurable upward).
- Read access: workspace owners can read events scoped to their
  workspace; SysTify staff access goes through breakglass with its own
  audit row (chicken-and-egg solved by writing the breakglass row
  first, then granting access).

Tests:
- Each event type has a test that pins (a) the row is written on the
  expected action and (b) the redaction inventory does not change
  silently.

### Stream C — provider posture pinning

OpenAI and Anthropic both offer zero-retention modes for API customers,
but the defaults vary and the contracts must be specifically requested.

Tasks:
- Confirm OpenAI API key tier supports zero-retention; if so, set the
  appropriate request header / org config and document the choice.
  Pin in code that requests *don't* opt back into training (no
  `data_sharing: true` etc.).
- Confirm Anthropic API key contract specifies no training on inputs.
  Document the agreement reference in `provider-zero-retention.md`.
- For GitHub: SysTify uses a GitHub App with installation tokens.
  Document the scope (read-only repository contents) and the principle
  that SysTify never asks for write scopes.

Out of scope: GCP / AWS posture. SysTify itself does not run on those;
Convex Cloud's posture is documented by Convex.

## Implementation tasks

PR-sized chunks, in dependency order:

1. **Compliance folder skeleton** (PR 1, ~½ day):
   - Create `compliance/` with stub files (one paragraph each pointing
     at the questions they will answer). This is the "where things go"
     PR, not the "what's true" PR.

2. **Data flow + sub-processor + provider posture** (PR 2, ~1 day):
   - Fill in `data-flow.md`, `sub-processors.md`,
     `provider-zero-retention.md`. These three are entirely
     documentation and require no code. They become the public-facing
     trust page later.

3. **Retention model + cron** (PR 3, ~2 days):
   - Schema changes: `retainUntil` on `messages`, `sandboxToolCallLog`.
   - Cron with floor/ceiling logic.
   - Workspace-level override knob.
   - Tests.
   - `retention-policy.md` filled in afterwards (matches code).

4. **User deletion** (PR 4, ~2 days):
   - Convex mutation, UI affordance, orphan-sandbox sweeper.
   - Tests including the re-signup case.

5. **Audit events** (PR 5, ~2 days):
   - New `auditEvents` table.
   - Wire each compliance-relevant event.
   - Tests.

6. **Access control + IR + DPA template** (PR 6, ~1 day):
   - `access-control.md`, `incident-response.md`, `dpa-template.md`.
   - These are documentation only; the underlying access controls
     already exist (Convex auth model, the per-tenant sandbox
     architecture). The work is writing them down.

7. **Customer-facing trust page** (PR 7, ~½ day):
   - A `/trust` route that links to the public subset of `compliance/`
     (data flow, sub-processors, retention, provider posture).
   - DPA and incident-response stay private.

## Acceptance criteria

- A prospect's procurement team can self-serve every Tier 1 question
  from `compliance/` without a sales call.
- The deletion flow works end-to-end: a user deletes their account, and
  no row, sandbox, or token referencing them remains beyond the audit
  log floor.
- A retention policy violation (e.g., a `messages` row past its
  `retainUntil`) cannot survive a single cron tick.
- The `auditEvents` table records every event listed in B3 with a
  pinning test.
- The compliance folder is dated; "as-of" attestations cite the
  effective date in `change-log.md`.

## Decisions to revisit

- **SOC 2 Type 1 vs Type 2.** Type 1 is point-in-time and cheaper;
  Type 2 is operating-effectiveness over a period (typically 6–12
  months). Type 1 is the natural target after this plan; Type 2 is the
  natural follow-up the year after. Don't conflate them.
- **DPA self-serve vs negotiated.** Most procurement orgs accept a
  templated DPA that mirrors GDPR Art. 28; some demand redlines.
  Decide whether to publish the template as click-through accept or
  signature-required.
- **Sub-processor change SLA.** GDPR requires reasonable notice of
  sub-processor changes; "reasonable" varies by customer contract.
  Default proposal: 30 days, with a customer-side opt-out window.
- **Retention floor for `messages`.** 365 days is the balance between
  "useful chat history" and "minimum data exposure". Customers in
  regulated industries may demand shorter floors; offer a workspace
  override.
- **AI provider switching.** If a sub-processor (OpenAI / Anthropic)
  changes its training-data posture mid-contract, the change log must
  fire and customers must be notified. Whether this should *block*
  inference until renewed consent is a contractual decision.

## Out of scope

- ISO 27001 and HIPAA. Both have meaningful prerequisites (formal ISMS,
  BAA-able sub-processors) that are larger projects.
- FedRAMP. Out of scope until a federal customer is in the funnel.
- Bug bounty. Healthy to have eventually; not blocking for SOC 2.
- Pen-testing. Required for SOC 2 Type 2; defer to that effort.

## Estimated total

7 PRs, ~9 days of engineering across docs and code, plus an outside
consultant pass on the SOC 2 narrative (~1 week of consultant time)
before the formal Type 1 audit window. Cost dominated by the audit fee
itself rather than the engineering.
