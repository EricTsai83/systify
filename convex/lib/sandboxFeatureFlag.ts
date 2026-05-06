/**
 * Plan 04 / 13 — Sandbox feature flag.
 *
 * Sandbox mode is the only chat mode that drives Daytona compute, calls live
 * tools (`read_file` / `list_dir` / `run_shell`), and bills against the
 * `deep_analysis` cost category. The gate is a *three-axis* composition:
 *
 *   1. **Master switch** (`SANDBOX_MODE_ENABLED`). When falsy, everyone
 *      sees the "private beta" disabled tooltip and the resolver removes
 *      `sandbox` from `availableModes`. Both the mutation layer
 *      (`chat.send`) and the action layer (`chat.generation`) re-check
 *      this so a stale UI cannot bypass it. This is the operator's
 *      kill switch — it overrides everything below.
 *
 *   2. **Allowlist** (`SANDBOX_BETA_ALLOWLIST`, comma-separated
 *      `tokenIdentifier` values). Pre-rollout VIP / internal tester
 *      list. Per Convex auth guidelines, `tokenIdentifier` is the
 *      canonical stable identifier for an authenticated identity. The
 *      single-entry wildcard `*` opens access to every signed-in
 *      viewer (intended for dev / staging).
 *
 *   3. **Percentage rollout** (`SANDBOX_ROLLOUT_PERCENT`, integer in
 *      `[0, 100]`). Plan 13. Each viewer hashes (FNV-1a, see
 *      {@link bucketForTokenIdentifier}) into a stable bucket in
 *      `[0, 100)`; a viewer is in the rollout cohort iff their bucket
 *      is strictly less than the configured percent. The bucket is a
 *      pure function of `tokenIdentifier`, so raising the percentage
 *      strictly *expands* the cohort and never reshuffles existing
 *      members — the property the rollout playbook
 *      (`docs/sandbox-mode-rollout.md`) relies on for "10% → 50% → 100%"
 *      ramps.
 *
 * Composition rule:
 *
 *     master_switch_on AND (allowlisted OR in_rollout_cohort)
 *
 * The OR between allowlist and rollout is deliberate. Allowlist members
 * are the operator's hand-picked testers; the rollout is the broad
 * statistical bucket. A viewer matched by *either* axis is admitted.
 * That keeps "VIP testers + targeted ramp" workable as two orthogonal
 * knobs without forcing operators to maintain a single combined list.
 *
 * Design notes:
 *
 *   - `evaluateSandboxFeatureFlag` returns a discriminated union rather than a
 *     bool so the resolver can render a *precise* disabled tooltip ("private
 *     beta" vs "you're not on the allowlist" vs "rolling out gradually"). A
 *     bool would force the resolver to re-derive the reason from the same
 *     env vars and silently drift if the rules change here.
 *   - Env vars are read fresh on every call (no module-scope cache). Convex
 *     env vars are stable across an action's lifetime so the cost is a few
 *     `process.env[…]` lookups per chat reply — negligible — and tests that
 *     mutate `process.env` between cases see the new values without needing
 *     to clear an internal cache.
 *   - Empty / unset allowlist *and* zero rollout with the flag on is treated
 *     as "nobody admitted" (closed). That is the safer default: an operator
 *     who flips `SANDBOX_MODE_ENABLED=true` but forgets to populate at least
 *     one of the two access mechanisms sees the disabled tooltip themselves
 *     and is reminded to configure access, instead of silently opening the
 *     feature to everyone.
 *   - When the gate closes for a viewer outside both axes, the *reason*
 *     depends on whether a rollout is configured. With rollout > 0, the
 *     `not_in_rollout` tooltip ("rolling out gradually, you're not in the
 *     current cohort yet") is more meaningful than the legacy "you're not
 *     on the allowlist" copy. With rollout = 0, the legacy copy still
 *     applies — the feature really is allowlist-only at that point.
 */

import { bucketForTokenIdentifier, bucketIsInRollout, parseRolloutPercent } from "./sandboxRollout";

const ENABLED_TRUE_VALUES = new Set(["true", "1", "yes", "on"]);
const ALLOWLIST_WILDCARD = "*";

/**
 * Disabled tooltip strings. Module-scoped so the resolver can re-export them
 * for `chatModeResolver`'s `disabledReasons` table without re-typing the copy.
 *
 * Wording is intentionally short: it lands in a Select option label like
 * `Sandbox (Sandbox mode is in private beta)` and the parenthesised tail
 * needs to stay readable on a single line in the dropdown.
 */
export const SANDBOX_FLAG_OFF_TOOLTIP = "Sandbox mode is in private beta.";
export const SANDBOX_NOT_ALLOWLISTED_TOOLTIP =
  "Sandbox mode is in private beta — your account is not on the allowlist yet.";
/**
 * Plan 13 — distinct copy for the percentage-rollout state. We do NOT
 * reuse the `not_allowlisted` tooltip here because:
 *
 *   - "your account is not on the allowlist yet" implies the viewer is
 *     waiting on a manual addition. During a percentage rollout, that
 *     is a lie — the access decision is automatic and based on a hash.
 *   - The right user-facing story is "we're ramping this up gradually
 *     and you'll get it soon." That sets accurate expectations and
 *     reduces inbound support ("how do I get added to the allowlist?")
 *     during the 10% → 50% → 100% ramp.
 */
export const SANDBOX_NOT_IN_ROLLOUT_TOOLTIP =
  "Sandbox mode is rolling out gradually — your account isn't in the current cohort yet.";

export type SandboxFeatureGateReason = "flag_off" | "not_allowlisted" | "not_in_rollout";

export type SandboxFeatureGate =
  | { readonly enabled: true }
  | {
      readonly enabled: false;
      readonly reason: SandboxFeatureGateReason;
      readonly tooltip: string;
    };

function isEnvFlagOn(rawValue: string | undefined): boolean {
  if (!rawValue) {
    return false;
  }
  return ENABLED_TRUE_VALUES.has(rawValue.trim().toLowerCase());
}

function parseAllowlist(rawValue: string | undefined): readonly string[] {
  if (!rawValue) {
    return [];
  }
  // Split on commas, trim each entry, drop empties. Whitespace tolerance
  // matters because operators frequently paste lists from spreadsheets or
  // dashboards that include trailing spaces around the separators.
  return rawValue
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Plan 13 — bucket-aware decision metadata. Returned by
 * {@link decideSandboxFeatureGate} alongside the gate so callers that
 * also want to emit the rollout decision as a metric (or render
 * cohort-aware UI) don't have to re-hash the `tokenIdentifier`. The
 * gate itself stays the public contract; the decision is the
 * "explainability" sidecar.
 */
export type SandboxFeatureGateDecisionPath =
  | "flag_off"
  | "wildcard_allowlist"
  | "allowlisted"
  | "rollout_admitted"
  | "rollout_excluded"
  | "no_access_configured";

export interface SandboxFeatureGateDecision {
  readonly gate: SandboxFeatureGate;
  /**
   * Hash bucket assigned to this `tokenIdentifier`, in `[0, 100)`. Stable
   * across calls. Always populated (the bucket is a pure function of the
   * identifier and is computed even when the gate is closed for unrelated
   * reasons like `flag_off`) so dashboards can slice telemetry by cohort
   * without conditional logic at the call site.
   */
  readonly bucket: number;
  /**
   * Snapshot of the rollout percent that drove the decision, after
   * parsing / clamping. Useful for telemetry tags so a closed gate
   * caused by the operator setting rollout=0 is distinguishable from
   * one caused by rollout=10 with the viewer in bucket 99.
   */
  readonly rolloutPercent: number;
  /**
   * Which branch of the decision tree fired. Telemetry-friendly — a
   * stable enum we can pivot dashboards on, separate from the
   * user-facing `gate.reason` (which omits the `wildcard_allowlist` /
   * `allowlisted` / `rollout_admitted` cases because they all collapse
   * to "open"). Five possibilities at a glance:
   *
   *   - `flag_off`              — master switch off
   *   - `wildcard_allowlist`    — `SANDBOX_BETA_ALLOWLIST=*`
   *   - `allowlisted`           — viewer matched explicit allowlist entry
   *   - `rollout_admitted`      — viewer in rollout cohort
   *   - `rollout_excluded`      — rollout > 0 but viewer outside cohort
   *   - `no_access_configured`  — flag on but rollout = 0 and allowlist
   *                               doesn't contain the viewer (operator
   *                               forgot to configure either axis)
   */
  readonly path: SandboxFeatureGateDecisionPath;
}

/**
 * Pure evaluator with a sidecar decision payload. Take the raw env vars
 * (caller injects them so this stays trivially testable without
 * monkey-patching `process.env`) plus the viewer's `tokenIdentifier` and
 * produce both the gate and the decision metadata.
 *
 * Decision order (first match wins):
 *
 *   1. **Master switch off** → `flag_off`. Most user-meaningful explanation
 *      — "the feature is disabled for everyone" is less alarming than "you
 *      in particular are not on the list" — so it takes precedence over
 *      every other axis.
 *
 *   2. **Wildcard allowlist** (`*`) → open. The single-entry escape hatch
 *      for dev / staging.
 *
 *   3. **Explicit allowlist match** → open. VIP / internal testers.
 *
 *   4. **Rollout cohort match** → open. The viewer's hash bucket is below
 *      the configured rollout percent.
 *
 *   5. **Else closed**. The closed reason depends on whether a rollout is
 *      configured: with `rolloutPercent > 0` we surface `not_in_rollout`
 *      (the access mechanism is hash-based; "rolling out gradually" is the
 *      truthful copy); with `rolloutPercent = 0` we surface the legacy
 *      `not_allowlisted` copy because the feature really is allowlist-only
 *      at that point.
 */
export function decideSandboxFeatureGate(args: {
  enabledFlag: string | undefined;
  allowlist: string | undefined;
  rolloutPercent: string | undefined;
  tokenIdentifier: string;
}): SandboxFeatureGateDecision {
  // Compute the bucket once up front so every return path can attach it
  // to the decision sidecar without recomputing the hash. The bucket is
  // independent of the gate outcome — it only depends on the identifier.
  const bucket = bucketForTokenIdentifier(args.tokenIdentifier);
  const rolloutPercent = parseRolloutPercent(args.rolloutPercent);

  if (!isEnvFlagOn(args.enabledFlag)) {
    return {
      gate: { enabled: false, reason: "flag_off", tooltip: SANDBOX_FLAG_OFF_TOOLTIP },
      bucket,
      rolloutPercent,
      path: "flag_off",
    };
  }

  const allowlist = parseAllowlist(args.allowlist);
  const isWildcardOpen = allowlist.length === 1 && allowlist[0] === ALLOWLIST_WILDCARD;
  if (isWildcardOpen) {
    return {
      gate: { enabled: true },
      bucket,
      rolloutPercent,
      path: "wildcard_allowlist",
    };
  }

  if (allowlist.includes(args.tokenIdentifier)) {
    return {
      gate: { enabled: true },
      bucket,
      rolloutPercent,
      path: "allowlisted",
    };
  }

  if (bucketIsInRollout(bucket, rolloutPercent)) {
    return {
      gate: { enabled: true },
      bucket,
      rolloutPercent,
      path: "rollout_admitted",
    };
  }

  // Closed gate. Pick the more meaningful tooltip based on whether a
  // rollout is configured at all.
  if (rolloutPercent > 0) {
    return {
      gate: {
        enabled: false,
        reason: "not_in_rollout",
        tooltip: SANDBOX_NOT_IN_ROLLOUT_TOOLTIP,
      },
      bucket,
      rolloutPercent,
      path: "rollout_excluded",
    };
  }
  return {
    gate: {
      enabled: false,
      reason: "not_allowlisted",
      tooltip: SANDBOX_NOT_ALLOWLISTED_TOOLTIP,
    },
    bucket,
    rolloutPercent,
    path: "no_access_configured",
  };
}

/**
 * Backwards-compatible facade over {@link decideSandboxFeatureGate} that
 * returns just the gate. Keeps existing callers (the resolver tests, the
 * `getSandboxFeatureGate` runtime wrapper, any future tooling that only
 * cares about "is this open?") on a one-line API while still letting
 * Plan 13's metric emitter consume the richer decision payload.
 */
export function evaluateSandboxFeatureGate(args: {
  enabledFlag: string | undefined;
  allowlist: string | undefined;
  /**
   * Optional so pre-Plan-13 call sites that don't want to thread a
   * rollout percent through their tests can still call the legacy
   * two-axis form. `undefined` is treated as "no rollout configured"
   * (rollout = 0), so the behavior matches the pre-Plan-13 contract:
   * allowlist-only access.
   */
  rolloutPercent?: string | undefined;
  tokenIdentifier: string;
}): SandboxFeatureGate {
  return decideSandboxFeatureGate({
    enabledFlag: args.enabledFlag,
    allowlist: args.allowlist,
    rolloutPercent: args.rolloutPercent,
    tokenIdentifier: args.tokenIdentifier,
  }).gate;
}

/**
 * Process-env wrapper for the rich decision payload. Reads
 * `SANDBOX_MODE_ENABLED` / `SANDBOX_BETA_ALLOWLIST` /
 * `SANDBOX_ROLLOUT_PERCENT` fresh on every invocation. Use this when
 * you need both the gate AND the decision metadata (for example, when
 * emitting a `sandbox_rollout_decision` metric or when tagging a
 * session-level metric with the viewer's bucket).
 */
export function getSandboxFeatureGateDecision(tokenIdentifier: string): SandboxFeatureGateDecision {
  return decideSandboxFeatureGate({
    enabledFlag: process.env.SANDBOX_MODE_ENABLED,
    allowlist: process.env.SANDBOX_BETA_ALLOWLIST,
    rolloutPercent: process.env.SANDBOX_ROLLOUT_PERCENT,
    tokenIdentifier,
  });
}

/**
 * Process-env wrapper around {@link evaluateSandboxFeatureGate} for runtime
 * call sites (resolver / mutations / actions). Reads env vars fresh on every
 * invocation so test environments that mutate `process.env` between cases
 * stay deterministic without needing a cache-reset hook.
 *
 * Returns just the gate — same shape it has always returned, so the
 * existing call sites in `threadContext.ts` and `chat/send.ts` continue
 * to work without touching the bucket / decision sidecar. Call sites
 * that need the bucket should use {@link getSandboxFeatureGateDecision}.
 */
export function getSandboxFeatureGate(tokenIdentifier: string): SandboxFeatureGate {
  return getSandboxFeatureGateDecision(tokenIdentifier).gate;
}
