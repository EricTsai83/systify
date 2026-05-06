# Sandbox Mode Rollout Plan

## Purpose

This document is the operational playbook for the sandbox-mode percentage rollout introduced in Plan 13. It's intentionally narrower than `sandbox-mode-system-design.md` (the runtime boundary) and `sandbox-mode-security-system-design.md` (the content boundary) — both of those are about *what* sandbox mode does. This one is about *who gets it, when, and how to back off if something is wrong*.

Adjacent on-call material:

- `sandbox-mode-runbook.md` — incident playbook (Daytona outages, cost spikes, tool error spikes, latency regressions).
- The audit-log doc (`sandbox-tool-call-audit-log-system-design.md`) — for compliance / abuse review.

## Mental model

Three orthogonal access knobs gate sandbox mode (see `convex/lib/sandboxFeatureFlag.ts` for the implementation):

1. **`SANDBOX_MODE_ENABLED`** — global kill switch. Off ⇒ nobody. This overrides everything below.
2. **`SANDBOX_BETA_ALLOWLIST`** — comma-separated `tokenIdentifier` list of viewers admitted regardless of the rollout percent. Used for VIP / internal testers and incident-response access during a paused rollout.
3. **`SANDBOX_ROLLOUT_PERCENT`** — integer in `[0, 100]`. Each viewer hashes (FNV-1a 32-bit) into a stable bucket in `[0, 100)`; admitted iff `bucket < percent`.

A viewer is admitted iff:

```
SANDBOX_MODE_ENABLED is on
  AND ( in SANDBOX_BETA_ALLOWLIST  OR  bucket < SANDBOX_ROLLOUT_PERCENT )
```

The bucket is a pure function of the viewer's `tokenIdentifier`. **Raising the rollout percent strictly expands the cohort** — it never reshuffles existing members out. This is the property the ramp below depends on: a 50% rollout includes everyone the 10% rollout did, plus 40 more buckets.

Hash distribution is verified by `convex/lib/sandboxRollout.test.ts`'s uniformity test. If you ever change the hash function, re-run that test and re-verify the cohort distribution dashboards before doing another ramp — the bucket assignments will reshuffle.

## Ramp schedule

The default ramp is **whitelist → 10% → 50% → 100%**. Each step holds for **at least one calendar week** before the next, and you abort to the previous step (or the kill switch) if the SLOs below fail at any point during the hold.

| Step | `SANDBOX_ROLLOUT_PERCENT` | `SANDBOX_BETA_ALLOWLIST` | Hold | Notes |
| ---- | ------------------------- | ------------------------ | ---- | ----- |
| 0    | `0`                       | populated (VIPs)         | —    | Pre-Plan-13 state. Allowlist-only. |
| 1    | `10`                      | populated (VIPs)         | ≥ 7d | First broad cohort. |
| 2    | `50`                      | populated (VIPs)         | ≥ 7d | Capacity / cost validation. |
| 3    | `100`                     | populated (VIPs)         | ≥ 7d | GA. Allowlist still useful as override. |

The allowlist stays populated through every step. Once a viewer is allowlisted, removing them only takes effect on the next gate evaluation (env vars are read fresh per request — no cache). A populated allowlist is also how you keep VIPs unblocked if you have to roll back the rollout percent during an incident.

## Promote — checklist for each step

Use this checklist for every transition (e.g. `10` → `50`). It assumes you've already held the previous step for ≥ 7 days with all SLOs green.

1. **Pre-flight**:
   - Open the runbook (`sandbox-mode-runbook.md`).
   - Page yourself a calendar reminder for "+24h post-ramp recheck" and "+7d hold-end review".
   - Confirm `SANDBOX_MODE_ENABLED=true`, `SANDBOX_BETA_ALLOWLIST` populated.

2. **Promote**:
   - Convex dashboard → Settings → Environment Variables → set `SANDBOX_ROLLOUT_PERCENT` to the new value.
   - The change takes effect on the next request — no deploy / restart needed (env vars are read fresh inside `getSandboxFeatureGate`).

3. **+15 min smoke test**:
   - The `[metrics] sandbox_session_finished` rate should rise commensurate with the new cohort fraction.
   - The `tags.bucket` distribution should populate buckets `[0, new_percent)` and continue to leave `[new_percent, 100)` empty.
   - No unusual spike in `tags.status = "failed"` over the prior baseline.

4. **+24h post-ramp recheck**:
   - Pull the SLOs below into a single grafana view.
   - All four green ⇒ continue the hold.
   - Any red ⇒ pause (see "Pause without disabling allowlist access" below) and root-cause before continuing.

5. **+7d hold-end review**:
   - Pull weekly SLO trends, compare to the previous step.
   - File a one-paragraph note in the "Decision log" section below summarising "ramp went smoothly" / "ramp encountered X, fixed by Y."
   - Promote to the next step.

## SLOs (per ramp step)

A ramp step is healthy iff *all four* of the following hold during the hold window. Each is queryable directly from the metric streams documented in `sandbox-mode-runbook.md`.

| SLO | Metric | Threshold |
| --- | ------ | --------- |
| Success rate | `sandbox_session_finished { tags.status = "completed" }` / total | ≥ 95% |
| p95 session duration | `sandbox_session_finished.value` (ms) | ≤ 30 000 |
| Tool error rate | `sandbox_tool_invoked { tags.ok = false }` / total | ≤ 5% |
| Daily cost burn | sum of `details.cost_usd` per user-day | ≤ daily cap (Plan 10) |

The thresholds are intentionally generous for the early ramps; tighten them as the cohort grows. The point of these is *catching regressions during the ramp*, not certifying steady-state product quality — for the latter, separate dashboards / SLOs apply.

## Abort conditions

These are the conditions under which you should abort the rollout immediately, *before* finishing the smoke test or the +24h recheck:

- **Daytona-side outage** — `tags.error_code = "io_error"` rate > 25% for two consecutive 15-min windows. Run the `sandbox-mode-runbook.md` "Daytona is unavailable" playbook.
- **Cost cap evasion** — any user-day spend exceeding the cap by more than 10% (the cap should be hard, so any breach is a Plan 10 bug).
- **Secret in trace** — any operator / user report of redaction-bypass content in `messages.toolCalls` or `sandboxToolCallLog`. This is a Plan 05 boundary breach. Page security; flip the kill switch.
- **Sustained latency regression** — p95 walks up by > 50% for one hour and is not attributable to a single bad model deploy.

## Pause without disabling allowlist access

If you need to pause a rollout step but want to keep allowlisted viewers unblocked (incident response, internal testing), drop `SANDBOX_ROLLOUT_PERCENT` to `0` while leaving `SANDBOX_MODE_ENABLED=true` and `SANDBOX_BETA_ALLOWLIST` populated. The composing rule (`master_switch AND (allowlisted OR in_rollout)`) keeps allowlisted viewers in while removing every hash-bucketed viewer from the cohort.

This is preferable to the kill switch in cases where you want to keep dogfooding the feature internally while investigating a rollout-cohort-only issue. If the issue affects every viewer (allowlisted or not), use the kill switch instead.

## Rollback

There are three rollback granularities, picked by the situation:

1. **Tighten** — drop the rollout percent to a smaller value (e.g. 50 → 10). Strictly contracts the cohort; allowlisted viewers unaffected. Use for "things are wobbly, let's slow down" scenarios.
2. **Pause** — set `SANDBOX_ROLLOUT_PERCENT=0`. Cohort shrinks to allowlist-only. Use for "we have a sandbox-side bug we need to fix without taking it down for VIPs" scenarios.
3. **Kill switch** — set `SANDBOX_MODE_ENABLED=false`. Sandbox is fully off, including allowlisted viewers. Use for "Daytona is down" / "secret leak suspected" / "P0 cost incident" scenarios.

All three take effect on the next request. None requires a Convex deploy / restart.

## What rollback does NOT do

- It does not kill in-flight replies. A reply that already passed the gate continues until it completes, fails, or hits the chat-job lease window. This is intentional: ripping out a long-running tool call mid-execution leaks Daytona compute (the sandbox keeps running until its own auto-archive timer fires) and leaves the user with a confusing "your reply was deleted" experience.
- It does not adjust the allowlist. Removing a viewer from the allowlist requires explicitly editing `SANDBOX_BETA_ALLOWLIST`. The kill switch is global.
- It does not refund cost. Sandbox spend already settled against Plan 10's daily caps stays settled. The next day's caps reset normally at midnight UTC.

## Promote / pause cheat sheet

```bash
# Promote (Convex dashboard → Environment Variables):
SANDBOX_ROLLOUT_PERCENT=10  # → 50 → 100

# Pause (rollout off, allowlist still active):
SANDBOX_ROLLOUT_PERCENT=0

# Kill (everyone off, including allowlist):
SANDBOX_MODE_ENABLED=false

# Reset to "fully on":
SANDBOX_MODE_ENABLED=true
SANDBOX_ROLLOUT_PERCENT=100
```

## Decision log

> Add one paragraph per ramp transition. This is the primary record for "what did we learn from each step."

- *(empty)* — first ramp pending. Use this entry as the template:
  > **YYYY-MM-DD: 0% → 10%.** Promoted by @<owner>. SLOs at +24h: success 97.4%, p95 18s, tool error rate 2.1%, no cost-cap breaches. Ramp held for 8 days. Notes: <one-line summary of any anomaly>.

## Reference

- **Implementation**: `convex/lib/sandboxFeatureFlag.ts`, `convex/lib/sandboxRollout.ts`.
- **Tests**: `convex/lib/sandboxFeatureFlag.test.ts`, `convex/lib/sandboxRollout.test.ts`, `convex/chatModeResolver.test.ts`.
- **Telemetry**: `convex/chat/generation.ts` (session-level emit), `convex/lib/observability.ts` (`emitMetric`).
- **Adjacent docs**: `sandbox-mode-runbook.md` (incidents), `sandbox-mode-system-design.md` (runtime), `sandbox-mode-security-system-design.md` (content), `sandbox-tool-call-audit-log-system-design.md` (audit).
