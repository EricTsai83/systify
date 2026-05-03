/**
 * Plan 04 — Sandbox feature flag.
 *
 * Sandbox mode is the only chat mode that drives Daytona compute, calls live
 * tools (`read_file` / `list_dir`), and bills against the `deep_analysis`
 * cost category. Until the rollout reaches GA (Plan 13), it ships behind a
 * two-axis env-var gate so operators can:
 *
 *   1. Globally disable the feature (`SANDBOX_MODE_ENABLED=false`) — everyone
 *      sees the same "private beta" disabled tooltip and the resolver removes
 *      `sandbox` from `availableModes`. The mutation layer (`chat.send`) and
 *      the action layer (`chat.generation`) both re-check this gate so a
 *      stale UI cannot bypass it.
 *   2. Restrict access to specific viewers (`SANDBOX_BETA_ALLOWLIST=tok1,tok2`).
 *      The list is matched exactly against `identity.tokenIdentifier`, which
 *      per the Convex auth guidelines is the canonical stable identifier
 *      for an authenticated identity. The wildcard `*` as the only entry
 *      opens access to all signed-in viewers (useful in dev / staging where
 *      maintaining a real allowlist would be friction without security value).
 *
 * Design notes:
 *
 *   - `evaluateSandboxFeatureFlag` returns a discriminated union rather than a
 *     bool so the resolver can render a *precise* disabled tooltip ("private
 *     beta" vs "you're not on the allowlist"). A bool would force the resolver
 *     to re-derive the reason from the same env vars and silently drift if
 *     the rules change here.
 *   - Env vars are read fresh on every call (no module-scope cache). Convex
 *     env vars are stable across an action's lifetime so the cost is a few
 *     `process.env[…]` lookups per chat reply — negligible — and tests that
 *     mutate `process.env` between cases see the new values without needing
 *     to clear an internal cache.
 *   - Empty / unset allowlist with the flag *on* is treated as "no viewer is
 *     allowlisted" (closed). That is the safer default: an operator who flips
 *     `SANDBOX_MODE_ENABLED=true` but forgets the allowlist sees the disabled
 *     tooltip themselves and is reminded to populate it, instead of silently
 *     opening the feature to everyone.
 */

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

export type SandboxFeatureGateReason = "flag_off" | "not_allowlisted";

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
 * Pure evaluator. Take the raw env vars (caller injects them so this stays
 * trivially testable without monkey-patching `process.env`) plus the viewer's
 * `tokenIdentifier` and produce a structured gate.
 *
 * Order of checks matters: `flag_off` is the more user-meaningful explanation
 * — "the feature is disabled for everyone" is less alarming than "you in
 * particular are not on the list" — so it takes precedence when both
 * conditions hold (flag off + caller absent from allowlist).
 */
export function evaluateSandboxFeatureGate(args: {
  enabledFlag: string | undefined;
  allowlist: string | undefined;
  tokenIdentifier: string;
}): SandboxFeatureGate {
  if (!isEnvFlagOn(args.enabledFlag)) {
    return {
      enabled: false,
      reason: "flag_off",
      tooltip: SANDBOX_FLAG_OFF_TOOLTIP,
    };
  }

  const allowlist = parseAllowlist(args.allowlist);
  const isWildcardOpen = allowlist.length === 1 && allowlist[0] === ALLOWLIST_WILDCARD;
  if (isWildcardOpen) {
    return { enabled: true };
  }

  if (allowlist.includes(args.tokenIdentifier)) {
    return { enabled: true };
  }

  return {
    enabled: false,
    reason: "not_allowlisted",
    tooltip: SANDBOX_NOT_ALLOWLISTED_TOOLTIP,
  };
}

/**
 * Process-env wrapper around {@link evaluateSandboxFeatureGate} for runtime
 * call sites (resolver / mutations / actions). Reads env vars fresh on every
 * invocation so test environments that mutate `process.env` between cases
 * stay deterministic without needing a cache-reset hook.
 */
export function getSandboxFeatureGate(tokenIdentifier: string): SandboxFeatureGate {
  return evaluateSandboxFeatureGate({
    enabledFlag: process.env.SANDBOX_MODE_ENABLED,
    allowlist: process.env.SANDBOX_BETA_ALLOWLIST,
    tokenIdentifier,
  });
}
