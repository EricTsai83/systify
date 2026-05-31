# Sandbox-Grounded Discuss Operations Runbook

## Audience

You're on call for Systify chat. Sandbox-grounded Discuss replies (`messages.groundSandbox === true`, persisted with `mode: "discuss"`) are the only chat path that drives Daytona compute, executes live tools (`read_file`, `list_dir`, `run_shell`) inside per-repository sandboxes, and bills against the chat cost category. This document gives you the queries, thresholds, and remediation playbook you need to handle the four most common incidents:

1. **Daytona is unavailable** — sandbox provisioning or tool execution fails for every viewer.
2. **Cost spike** — a viewer or repository burns through their daily cap unusually fast.
3. **Tool error spike** — `read_file` / `list_dir` / `run_shell` fail at an elevated rate without an obvious upstream cause.
4. **Session latency regression** — p95 session duration walks up after a deploy.

## Architecture refresher

A sandbox-grounded session emits two classes of structured logs from the Convex backend:

- **Session-level**: `[metrics] sandbox_session_finished { … }` — one line per terminal-state path (`completed` / `failed` / `cancelled` / `aborted_orphan`). Emitted only when the reply actually used sandbox tools (`hadTools === true`); ungrounded Discuss / Library replies do not appear here. Carries `mode` (`"discuss"`), `model`, `had_tools`, plus `tool_calls_count`, `tool_errors_count`, `input_tokens`, `output_tokens`, `cost_usd`, and the wall-clock `value` (= duration ms).
- **Per-tool**: `[metrics] sandbox_tool_invoked { … }` — one line per tool result or tool error. Carries `tool` (`read_file` / `list_dir` / `run_shell`), `ok` (boolean), `error_code` (or undefined for success), and the `value` (= per-call duration ms).

Metric names use the `sandbox_*` prefix; `tags.mode` carries the DB literal (`"discuss"`). `sandbox_session_finished` is only emitted when `had_tools === true`, so any event in that metric stream represents a sandbox-grounded session.

These two metric streams plus the existing `[chat] …` debug logs are the only data sources this runbook references. If your downstream logging pipeline supports it, group `tags.*` fields as dimensions — every dashboard recipe in this document filters on a `tags.*` value.

### How this interacts with System Design generation

System Design generation now uses live sandbox grounding for LLM-backed kinds (architecture diagram, data model overview, etc.). Each kind that needs source-code introspection calls `ensureSandboxReady` (`convex/systemDesign.ts`) which provisions a Daytona sandbox if one isn't running. Sandbox lifecycle / cost / tool-error / latency symptoms surface in the SAME metric streams (`sandbox_session_finished`, `sandbox_tool_invoked`) — distinguishable by feature tag.

An incident affecting Daytona (Incident 1 in this runbook) blocks System Design generation entirely: the kind fails with `failureReason: "live_source_unavailable"` or `"infra"`; the job's auto-resume re-tries on the next stale-recovery sweep. The same `SANDBOX_DAILY_CAP_PER_USER_USD=0` mitigation that gates new sandbox-grounded chat also gates new System Design generation requests via the same cost-cap check.

Cost-spike symptoms (Incident 2) may now include System Design generation runs. Filter `sandbox_session_finished` events on feature tag to separate chat from `system_design`. Per-kind cost shows up additionally in `systemDesignKindRuns.totalCostUsd` — `bun run report:user-costs` surfaces per-user totals; `bun run report:system-design` surfaces per-kind aggregates.

Cross-reference `docs/architecture/system-design-generation.md` for the full kind lifecycle and failure taxonomy.

## Quick reference: taking Sandbox grounding offline

Sandbox grounding does not have an env-var kill switch. If you need to disable it during an active incident:

- **Tighten the cost cap to zero**: set `SANDBOX_DAILY_CAP_PER_USER_USD=0`. The cap is re-read on every send; effective immediately, no deploy. The disabled tooltip will read "Daily sandbox spend limit reached for your account."
- **Push a code revert**: `git revert` the offending change and `bunx convex deploy` (or your usual deploy command). Convex deploy is fast (~30s) and avoids leaving the system in a degraded "everyone blocked by cost cap" state.

In-flight replies continue running until they complete or hit their lease window (`CHAT_JOB_LEASE_MS`, ~10 min) — neither approach kills running jobs mid-tool-call.

## Incident 1 — Daytona is unavailable

### Symptoms

- Sustained spike in `sandbox_session_finished { tags.status = "failed" }`.
- `[chat] sandbox_tool_error` debug logs naming Daytona client errors (timeout, 5xx, ECONNREFUSED).
- Every sandbox-grounded reply ending in `messages.errorMessage` containing "sandbox" / "Daytona" copy.

### Confirm

```text
# Does the failure rate exceed the SLO?
metric: sandbox_session_finished
group_by: tags.status
window: 15m
```

If `tags.status = "failed"` exceeds 25% of total `sandbox_session_finished` events for two consecutive 15-minute windows, treat as a Daytona-side outage.

```text
# Confirm the failures concentrate on Daytona-shaped errors:
filter: metric = "sandbox_tool_invoked" AND tags.ok = false AND tags.error_code IN ("io_error", "command_timeout")
```

If `io_error` rate dominates `command_blocked` / `path_outside_repo`, the cause is upstream (Daytona), not the LLM.

### Mitigate

1. **Page the Daytona owner** — sandbox is hard-blocked without it.
2. **Drop the cost cap to zero** to gate out new sandbox sessions while you investigate: `SANDBOX_DAILY_CAP_PER_USER_USD=0`. The cap re-reads on every send and surfaces the cap tooltip in the UI immediately.
3. If Daytona stays out for >30 min and the cap-gate workaround is not enough (e.g. need to communicate maintenance copy specifically), push a temporary patch that returns a maintenance-mode error from `chat/send.ts` for sandbox-grounded replies.
4. **Don't** clear sandbox rows from the database. Sandbox lifecycle recovery happens automatically once Daytona is back.

### Resolve

- Restore `SANDBOX_DAILY_CAP_PER_USER_USD` to its normal value once `sandbox_session_finished { status = "completed" }` is back above 95% of total for one hour.
- File a post-mortem note in your incident tracker.

## Incident 2 — Cost spike

### Symptoms

- `Daily sandbox spend limit reached` user reports concentrated on one repository or one viewer.
- `costUsd` totals on `sandbox_session_finished` events well above the 7-day rolling average.

### Confirm

```text
metric: sandbox_session_finished
group_by: details.assistantMessageId  # or group by tags.model
sort by: details.cost_usd desc
window: 24h
```

If a single viewer accounts for >50% of spend in 24h, treat as a cost-cap evasion attempt or a malformed integration / agent loop.

```text
# Per-user / per-repository sandbox cost caps:
peekSandboxDailyCostForUser / peekSandboxDailyCostForRepository
```

These rate-limit peeks are exposed via `convex/threadContext.ts` and reflect the live consumed cents. If they show 0 for a high-spend viewer, the settlement path has a bug — file ASAP and consider rolling back.

### Mitigate

1. **Tighten `SANDBOX_DAILY_CAP_PER_USER_USD`** to a temporary low value (e.g. `1`). Note: `SANDBOX_DAILY_CAP_PER_USER_USD` is a global per-user limit and will reduce allowance for all users, not a targeted fix for a single viewer. Existing buckets reset at midnight UTC and pick up the new ceiling. Restart not needed.
2. If a specific viewer is the source, instead of (or in addition to) the global cap, apply one of these targeted fixes:
   - **Per-account override**: Add a feature-flag mechanism or per-account configuration to apply a stricter spend cap to the offending account.
   - **API key revocation**: If the offender is using a public API key, rotate or revoke it to prevent further usage.
   - **Request throttling**: Apply stricter rate limits or request throttling to the specific account.
   - **Per-account hotfix for new accounts**: Add a temporary per-account cap for accounts under N days old.
3. Watch for runaway tool loops — the step budget (`SANDBOX_STEP_BUDGET = 8`) caps tool calls per reply, so a single reply cannot exceed ~8 × per-tool-cost. If you see >8 invocations in one `sandbox_session_finished` event, that's a bug worth filing.

### Resolve

- Once the source is contained, raise the cap back to its previous value.
- If the spike came from a legitimate agent / power user, consider raising the per-repository cap rather than the per-user cap (the latter can be exploited across alt accounts; the former contains blast radius to one repository).

## Incident 3 — Tool error spike

### Symptoms

- `sandbox_tool_invoked { tags.ok = false }` rate spikes without a corresponding Daytona outage.
- Users complaining that "the assistant gives up reading files."

### Confirm

```text
metric: sandbox_tool_invoked
filter: tags.ok = false
group_by: tags.tool, tags.error_code
window: 1h
```

The `error_code` distribution is the diagnostic signal:

- **`path_outside_repo` / `invalid_path` dominant** → either the system prompt drifted or a recent repo-import path-resolution bug. Check `convex/chat/prompting.ts` history and the `repoPath` field on `ReplyContext`.
- **`command_blocked` dominant** → a recent deny-list change is over-rejecting legitimate commands. Check `COMMAND_DENY_LIST` in `convex/chat/sandboxTools.ts`.
- **`command_timeout` dominant** → either the model is generating runaway pipelines or Daytona is under load. Cross-check Incident 1's `io_error` rate.
- **`tool_error` dominant** (note: this is the synthetic code for `tool-error` AI SDK events, distinct from envelope errors) → the AI SDK is throwing inside our `execute` callbacks. Most often a regression in `convex/chat/sandboxTools.ts`'s argument validation or a Daytona client breaking change.

### Mitigate

- **Path / deny-list regressions**: roll the previous Convex deploy (`npx convex deploy --rollback`) — these issues are fully fixed by reverting the offending commit.
- **Runaway pipelines**: tighten the system prompt's "read-only inspection only" reminders. Don't lower `SANDBOX_RUN_SHELL_DEFAULT_TIMEOUT_SECONDS` unless you can also confirm legitimate usage isn't being clipped — use the `value` field on `sandbox_tool_invoked` to check timeout-adjacent latency distributions.

### Resolve

- After a fix lands, watch the `sandbox_tool_invoked { tags.ok = false }` rate for one hour. It should fall under 5% of all invocations within ten minutes of the deploy.

## Incident 4 — Latency regression

### Symptoms

- p95 of `sandbox_session_finished { value }` walks up after a deploy.
- Users reporting "Sandbox is slow today."

### Confirm

```text
metric: sandbox_session_finished
filter: tags.status = "completed"
percentile: p50, p95
window: 1h
group_by: tags.model
```

p50 should be 5–15s for a typical sandbox-grounded reply (sandbox cold-start + 2–3 tool calls + finalize). p95 should be under 30s. If both walk up by >30%, treat as a regression.

```text
# Decompose: was the time spent in tool calls?
metric: sandbox_tool_invoked
percentile: p50, p95 of value
group_by: tags.tool
window: 1h
```

If `read_file` p95 walked up but `run_shell` did not, the regression is in the file-fetch path (Daytona archive → ready transition, FS adapter changes). If all tools regressed, the regression is upstream (Daytona compute, network).

### Mitigate

- **Bisect the deploy window** — `git log` the commits between the last good metric and the regression. Common culprits: changes to `convex/chat/sandboxTools.ts` (output cap, redaction), `convex/daytona.ts` (FS adapter), or the model selection (`OPENAI_MODEL_SANDBOX` env var pointing at a slower model).
- **Fall back to the previous deploy** if the bisect doesn't yield an obvious cause within 30 min. Latency is reversible; don't burn an hour debugging when a rollback restores the SLO.

### Resolve

- After fix / rollback, watch p95 for one hour. The metric should return within 10% of the pre-regression baseline.

## Common queries (cheat sheet)

```text
# In-flight sandbox-grounded sessions count (instantaneous)
metric: sandbox_session_finished
window: 5m
group_by: tags.status

# Top viewers by spend, last 24h
metric: sandbox_session_finished
group_by: details.assistantMessageId  # join with messages.ownerTokenIdentifier offline
sum: details.cost_usd

# Per-tool error rate
metric: sandbox_tool_invoked
filter: tags.ok = false
group_by: tags.tool, tags.error_code

# Cancellation rate (proxy for "user gave up because reply was slow")
metric: sandbox_session_finished
filter: tags.status = "cancelled"
group_by: tags.model
```

## Forensic queries (rare, deeper)

When you need to correlate a session with the durable audit log:

```ts
// Audit log table, keyed on owner + time:
ctx.db
  .query("sandboxToolCallLog")
  .withIndex("by_owner_and_time", (q) => q.eq("ownerTokenIdentifier", "user|alice"))
  .order("desc")
  .take(50);
```

The table carries pre-redaction byte counts, durations, error codes, and which redaction patterns fired. Use it for compliance / abuse review — not for routine ops, where the metric stream is faster.

## When to wake the deploy owner

- Daytona outage > 30 min with no mitigation in sight.
- A cost spike that the per-user / per-repository caps fail to contain (the caps are a load-bearing invariant; if they're not working that is a P0).
- Any incident that requires Sandbox grounding to be globally cost-gated to zero for >2h.
- Suspected secret leakage in `messages.toolCalls` or `sandboxToolCallLog` (cross-reference the redaction module in `convex/chat/redaction.ts`).
