# Sandbox Mode Operations Runbook

## Audience

You're on call for Systify chat. Sandbox mode (`mode: "sandbox"`) is the only chat mode that drives Daytona compute, executes live tools (`read_file`, `list_dir`, `run_shell`) inside per-repository sandboxes, and bills against the `system_design` cost category. This document gives you the queries, thresholds, and remediation playbook you need to handle the four most common incidents:

1. **Daytona is unavailable** — sandbox provisioning or tool execution fails for every viewer.
2. **Cost spike** — a viewer or workspace burns through their daily cap unusually fast.
3. **Tool error spike** — `read_file` / `list_dir` / `run_shell` fail at an elevated rate without an obvious upstream cause.
4. **Sandbox session latency regression** — p95 session duration walks up after a deploy.

For the rollout playbook (10% → 50% → 100% ramp, abort thresholds, reset / pause procedure) see `docs/sandbox-mode-rollout.md`.

## Architecture refresher

A sandbox-mode session emits two classes of structured logs from the Convex backend:

- **Session-level**: `[metrics] sandbox_session_finished { … }` — one line per terminal-state path (`completed` / `failed` / `cancelled` / `aborted_orphan`). Carries `mode`, `model`, `had_tools`, rollout `bucket`, plus `tool_calls_count`, `tool_errors_count`, `input_tokens`, `output_tokens`, `cost_usd`, and the wall-clock `value` (= duration ms).
- **Per-tool**: `[metrics] sandbox_tool_invoked { … }` — one line per tool result or tool error. Carries `tool` (`read_file` / `list_dir` / `run_shell`), `ok` (boolean), `error_code` (or undefined for success), the rollout `bucket`, and the `value` (= per-call duration ms). The `bucket` tag mirrors the session metric's so ramp-step diagnostics can slice tool-error rate by cohort without joining back to `sandbox_session_finished`.

These two metric streams plus the existing `[chat] …` debug logs are the only data sources this runbook references. If your downstream logging pipeline supports it, group `tags.*` fields as dimensions — every dashboard recipe in this document filters on a `tags.*` value.

## Quick reference: the kill switch

If anything is on fire and you need to take sandbox mode offline immediately:

```bash
# Convex dashboard → Settings → Environment Variables
SANDBOX_MODE_ENABLED=false
```

This causes `getSandboxFeatureGate` to return `{ enabled: false, reason: "flag_off" }` for every viewer on the next request. The mode selector greys out, in-flight `chat.sendMessage(mode: "sandbox")` calls reject, and the `chat/send.ts` mutation's gate re-check throws before any Daytona work is queued.

In-flight replies that already passed the gate continue running until they complete or hit their lease window (`CHAT_JOB_LEASE_MS`, ~10 min). They are *not* killed by flipping the flag — that is a deliberate choice so an emergency flip cannot orphan a long-running tool call mid-execution.

The flag is re-read fresh on every gate evaluation; no Convex deploy / restart is required.

## Incident 1 — Daytona is unavailable

### Symptoms

- Sustained spike in `sandbox_session_finished { tags.status = "failed" }`.
- `[chat] sandbox_tool_error` debug logs naming Daytona client errors (timeout, 5xx, ECONNREFUSED).
- Every sandbox-mode reply ending in `messages.errorMessage` containing "sandbox" / "Daytona" copy.

### Confirm

```text
# Does the failure rate exceed the SLO?
metric: sandbox_session_finished
group_by: tags.status
window: 15m
filter: tags.mode = "sandbox"
```

If `tags.status = "failed"` exceeds 25% of total `sandbox_session_finished` events for two consecutive 15-minute windows, treat as a Daytona-side outage.

```text
# Confirm the failures concentrate on Daytona-shaped errors:
filter: metric = "sandbox_tool_invoked" AND tags.ok = false AND tags.error_code IN ("io_error", "command_timeout")
```

If `io_error` rate dominates `command_blocked` / `path_outside_repo`, the cause is upstream (Daytona), not the LLM.

### Mitigate

1. **Page the Daytona owner** — sandbox is hard-blocked without it.
2. **Pause the rollout** — set `SANDBOX_ROLLOUT_PERCENT=0` (does NOT affect allowlisted viewers; see `sandbox-mode-rollout.md` "Pause without disabling allowlist access" for the rationale).
3. If Daytona stays out for >30 min, **flip the kill switch** (`SANDBOX_MODE_ENABLED=false`). This forces the UI to render Sandbox as disabled with the "private beta" tooltip and stops new sandbox-mode sessions from queueing. Allowlisted viewers see the same disabled state.
4. **Don't** clear sandbox rows from the database. Plan 09 (the dedicated Daytona-error-path doc) handles graceful sandbox lifecycle recovery once Daytona is back.

### Resolve

- Roll the rollout percent back up gradually (per `sandbox-mode-rollout.md`) once `sandbox_session_finished { status = "completed" }` is back above 95% of total for one hour.
- Post-mortem: file an incident note in the rollout doc's "Incident log" section so the next ramp inherits the context.

## Incident 2 — Cost spike

### Symptoms

- `Daily sandbox spend limit reached` user reports concentrated on one workspace or one viewer.
- `costUsd` totals on `sandbox_session_finished` events well above the 7-day rolling average.

### Confirm

```text
metric: sandbox_session_finished
filter: tags.mode = "sandbox"
group_by: details.assistantMessageId  # or aggregate by tags.bucket / model
sort by: details.cost_usd desc
window: 24h
```

If a single viewer accounts for >50% of spend in 24h, treat as a cost-cap evasion attempt or a malformed integration / agent loop.

```text
# Plan 10's per-user / per-workspace caps:
peekSandboxDailyCostForUser / peekSandboxDailyCostForWorkspace
```

These rate-limit peeks are exposed via `convex/threadContext.ts` and reflect the live consumed cents. If they show 0 for a high-spend viewer, the settlement path has a bug — file ASAP and consider rolling back.

### Mitigate

1. **Tighten `SANDBOX_DAILY_CAP_PER_USER_USD`** to a temporary low value (e.g. `1`). Existing buckets reset at midnight UTC and pick up the new ceiling. Restart not needed.
2. If a specific viewer is the source, **remove them from `SANDBOX_BETA_ALLOWLIST`** (if listed) or drop the rollout percent to a value below their `bucket` to gate them out (`bucket` is in the metric tags). Note: the allowlist override beats the rollout, so removing the viewer from the allowlist is necessary even if you also lower the rollout.
3. Watch for runaway tool loops — Plan 11's step budget (`SANDBOX_STEP_BUDGET = 8`) caps tool calls per reply, so a single reply cannot exceed ~8 × per-tool-cost. If you see >8 invocations in one `sandbox_session_finished` event, that's a bug worth filing.

### Resolve

- Once the source is contained, raise the cap back to its previous value.
- If the spike came from a legitimate agent / power user, consider raising the workspace cap rather than the per-user cap (the latter can be exploited across alt accounts; the former contains blast radius to one team).

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

- **`path_outside_repo` / `invalid_path` dominant** → either the system prompt drifted (Plan 11 / 14 changes) or a recent repo-import path-resolution bug. Check `convex/chat/prompting.ts` history and the `repoPath` field on `ReplyContext`.
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
filter: tags.mode = "sandbox" AND tags.status = "completed"
percentile: p50, p95
window: 1h
group_by: tags.model
```

p50 should be 5–15s for a typical sandbox reply (sandbox cold-start + 2–3 tool calls + finalize). p95 should be under 30s. If both walk up by >30%, treat as a regression.

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
# In-flight sandbox sessions count (instantaneous)
metric: sandbox_session_finished
window: 5m
group_by: tags.status

# Top viewers by spend, last 24h
metric: sandbox_session_finished
filter: tags.mode = "sandbox"
group_by: details.assistantMessageId  # join with messages.ownerTokenIdentifier offline
sum: details.cost_usd

# Rollout cohort coverage
metric: sandbox_session_finished
group_by: tags.bucket  # 0–99 buckets — should populate uniformly when rollout > 0

# Per-tool error rate
metric: sandbox_tool_invoked
filter: tags.ok = false
group_by: tags.tool, tags.error_code

# Per-tool error rate sliced by rollout cohort (use during ramps to
# spot a regression that's specific to the newly-admitted bucket range)
metric: sandbox_tool_invoked
filter: tags.ok = false
group_by: tags.bucket, tags.tool, tags.error_code

# Cancellation rate (proxy for "user gave up because reply was slow")
metric: sandbox_session_finished
filter: tags.status = "cancelled"
group_by: tags.model
```

## Forensic queries (rare, deeper)

When you need to correlate a session with the durable audit log:

```ts
// Plan 12's audit log table, keyed on owner + time:
ctx.db
  .query("sandboxToolCallLog")
  .withIndex("by_owner_and_time", (q) => q.eq("ownerTokenIdentifier", "user|alice"))
  .order("desc")
  .take(50);
```

The table carries pre-redaction byte counts, durations, error codes, and which redaction patterns fired. Use it for compliance / abuse review — not for routine ops, where the metric stream is faster.

## When to wake the deploy owner

- Daytona outage > 30 min with no mitigation in sight.
- A cost spike that the per-user / per-workspace caps fail to contain (the caps are a Plan 10 invariant; if they're not working that is a P0).
- Any incident that requires `SANDBOX_MODE_ENABLED=false` for >2h.
- Suspected secret leakage in `messages.toolCalls` or `sandboxToolCallLog` (cross-reference Plan 05's redaction module).
