import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  SANDBOX_FLAG_OFF_TOOLTIP,
  SANDBOX_NOT_ALLOWLISTED_TOOLTIP,
  SANDBOX_NOT_IN_ROLLOUT_TOOLTIP,
  decideSandboxFeatureGate,
  evaluateSandboxFeatureGate,
  getSandboxFeatureGate,
  getSandboxFeatureGateDecision,
} from "./sandboxFeatureFlag";
import { bucketForTokenIdentifier } from "./sandboxRollout";

const VIEWER = "user|alice";
const OTHER_VIEWER = "user|bob";

describe("evaluateSandboxFeatureGate (pure)", () => {
  test.each([undefined, "", "false", "0", "no", "off", "  False  ", "FALSE"])("treats %j as flag off", (flagValue) => {
    const gate = evaluateSandboxFeatureGate({
      enabledFlag: flagValue,
      allowlist: VIEWER,
      tokenIdentifier: VIEWER,
    });

    expect(gate.enabled).toBe(false);
    // Flag-off precedence: even a viewer who *would* match the allowlist
    // sees the more meaningful "private beta" reason. Knowing "the
    // feature is off entirely" is strictly more informative than "you
    // are not on the list."
    if (!gate.enabled) {
      expect(gate.reason).toBe("flag_off");
      expect(gate.tooltip).toBe(SANDBOX_FLAG_OFF_TOOLTIP);
    }
  });

  test.each(["true", "1", "yes", "on", "  TRUE  ", "True"])("treats %j as flag on", (flagValue) => {
    const gate = evaluateSandboxFeatureGate({
      enabledFlag: flagValue,
      allowlist: VIEWER,
      tokenIdentifier: VIEWER,
    });

    expect(gate.enabled).toBe(true);
  });

  test("flag on + viewer in allowlist: gate is open", () => {
    const gate = evaluateSandboxFeatureGate({
      enabledFlag: "true",
      allowlist: `${OTHER_VIEWER},${VIEWER},user|carol`,
      tokenIdentifier: VIEWER,
    });

    expect(gate.enabled).toBe(true);
  });

  test("flag on + viewer absent from allowlist: gate is closed with not_allowlisted reason", () => {
    const gate = evaluateSandboxFeatureGate({
      enabledFlag: "true",
      allowlist: `${OTHER_VIEWER},user|carol`,
      tokenIdentifier: VIEWER,
    });

    expect(gate.enabled).toBe(false);
    if (!gate.enabled) {
      expect(gate.reason).toBe("not_allowlisted");
      expect(gate.tooltip).toBe(SANDBOX_NOT_ALLOWLISTED_TOOLTIP);
    }
  });

  test("flag on + empty allowlist: gate is closed (safer default)", () => {
    // Empty allowlist with flag on is the "operator forgot to populate it"
    // case. Failing closed forces them to notice — they will see the
    // disabled tooltip themselves and add the right entries — instead of
    // silently making the feature available to everyone.
    const gate = evaluateSandboxFeatureGate({
      enabledFlag: "true",
      allowlist: undefined,
      tokenIdentifier: VIEWER,
    });

    expect(gate.enabled).toBe(false);
    if (!gate.enabled) {
      expect(gate.reason).toBe("not_allowlisted");
    }
  });

  test("flag on + wildcard allowlist '*': gate is open for any viewer", () => {
    // The wildcard convention is a documented operator escape hatch for
    // dev / staging. We accept it only as the *single* entry — `*,foo` is
    // ambiguous (literal "*"? regex?) so we treat it as not a wildcard
    // and require an exact match against the literal "*".
    const gate = evaluateSandboxFeatureGate({
      enabledFlag: "true",
      allowlist: "*",
      tokenIdentifier: "user|anyone-at-all",
    });

    expect(gate.enabled).toBe(true);
  });

  test("flag on + '*' alongside other entries is NOT treated as wildcard", () => {
    // Disambiguation guard: `*,user|foo` is most naturally read as "user
    // foo and also literally a row called *" — neither matches the viewer.
    const gate = evaluateSandboxFeatureGate({
      enabledFlag: "true",
      allowlist: "*,user|alice",
      tokenIdentifier: OTHER_VIEWER,
    });

    expect(gate.enabled).toBe(false);
  });

  test("trims whitespace and skips empty entries when parsing the allowlist", () => {
    // Spreadsheet paste drops trailing spaces around commas; the parser
    // must normalise them so an operator-friendly value still works.
    const gate = evaluateSandboxFeatureGate({
      enabledFlag: "true",
      allowlist: "  user|alice  , ,user|bob ",
      tokenIdentifier: VIEWER,
    });

    expect(gate.enabled).toBe(true);
  });

  test("treats arbitrary strings (e.g. 'maybe', 'enabled') as flag off", () => {
    // Defense in depth: only the explicit truthy values open the gate.
    // Anything else — typos like "enabled", legacy shell-style "y", etc. —
    // fails closed.
    const gate = evaluateSandboxFeatureGate({
      enabledFlag: "maybe",
      allowlist: VIEWER,
      tokenIdentifier: VIEWER,
    });

    expect(gate.enabled).toBe(false);
  });
});

const SANDBOX_ENV_KEYS = ["SANDBOX_MODE_ENABLED", "SANDBOX_BETA_ALLOWLIST", "SANDBOX_ROLLOUT_PERCENT"] as const;

function useIsolatedSandboxEnv() {
  // Each test mutates `process.env`; restore the prior values so unrelated
  // tests in the same vitest worker stay deterministic.
  const priorValues: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of SANDBOX_ENV_KEYS) {
      priorValues[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of SANDBOX_ENV_KEYS) {
      if (priorValues[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = priorValues[key]!;
      }
    }
  });
}

describe("getSandboxFeatureGate (env-backed)", () => {
  useIsolatedSandboxEnv();

  test("reads SANDBOX_MODE_ENABLED and SANDBOX_BETA_ALLOWLIST from the live env", () => {
    process.env.SANDBOX_MODE_ENABLED = "true";
    process.env.SANDBOX_BETA_ALLOWLIST = `user|alice,${OTHER_VIEWER}`;

    expect(getSandboxFeatureGate(VIEWER).enabled).toBe(true);
    expect(getSandboxFeatureGate("user|carol").enabled).toBe(false);
  });

  test("re-reads env on every call (no module-scope cache)", () => {
    process.env.SANDBOX_MODE_ENABLED = "false";
    expect(getSandboxFeatureGate(VIEWER).enabled).toBe(false);

    // Operator flips the flag without reloading the process.
    process.env.SANDBOX_MODE_ENABLED = "true";
    process.env.SANDBOX_BETA_ALLOWLIST = VIEWER;
    expect(getSandboxFeatureGate(VIEWER).enabled).toBe(true);
  });

  test("reads SANDBOX_ROLLOUT_PERCENT from the live env", () => {
    // 100% rollout admits every viewer regardless of the allowlist —
    // exactly the property an operator wants when ramping the rollout
    // to GA without listing every account by hand.
    process.env.SANDBOX_MODE_ENABLED = "true";
    process.env.SANDBOX_ROLLOUT_PERCENT = "100";

    expect(getSandboxFeatureGate(VIEWER).enabled).toBe(true);
    expect(getSandboxFeatureGate("user|never-seen-before").enabled).toBe(true);
  });
});

/**
 * Plan 13 — three-axis (master switch, allowlist, percentage rollout)
 * resolution + the bucket sidecar `decideSandboxFeatureGate` returns.
 *
 * The pure-evaluator block above already covers the allowlist axis in
 * isolation; this block isolates the rollout axis and the rollout-vs-
 * allowlist precedence rules.
 */
describe("decideSandboxFeatureGate (rollout)", () => {
  test("rolloutPercent=0 + viewer not in allowlist: closed with not_allowlisted (legacy reason)", () => {
    // Pre-Plan-13 behavior. With rollout disabled, the closed reason
    // stays on the legacy "not on the allowlist yet" copy.
    const decision = decideSandboxFeatureGate({
      enabledFlag: "true",
      allowlist: OTHER_VIEWER,
      rolloutPercent: "0",
      tokenIdentifier: VIEWER,
    });
    expect(decision.gate.enabled).toBe(false);
    if (!decision.gate.enabled) {
      expect(decision.gate.reason).toBe("not_allowlisted");
      expect(decision.gate.tooltip).toBe(SANDBOX_NOT_ALLOWLISTED_TOOLTIP);
    }
    expect(decision.path).toBe("no_access_configured");
    expect(decision.rolloutPercent).toBe(0);
  });

  test("rolloutPercent=100: every viewer admitted regardless of allowlist", () => {
    // Full-rollout case: the rollout cohort covers everyone. This is
    // the operator's "ship to GA" knob — they no longer need to keep
    // the allowlist current.
    const decision = decideSandboxFeatureGate({
      enabledFlag: "true",
      allowlist: undefined,
      rolloutPercent: "100",
      tokenIdentifier: "user|completely-fresh-account",
    });
    expect(decision.gate.enabled).toBe(true);
    expect(decision.path).toBe("rollout_admitted");
    expect(decision.rolloutPercent).toBe(100);
  });

  test("rolloutPercent>0 + viewer outside cohort: closed with not_in_rollout (cohort-aware copy)", () => {
    // Pick a viewer whose bucket lands above any reasonable single-digit
    // percentage so a 5% rollout reliably excludes them. The tooltip
    // must NOT reuse the legacy "you're not on the allowlist" copy —
    // see the module-level rationale for `SANDBOX_NOT_IN_ROLLOUT_TOOLTIP`.
    const highBucketViewer = findViewerInBucketRange(80, 99);
    const decision = decideSandboxFeatureGate({
      enabledFlag: "true",
      allowlist: undefined,
      rolloutPercent: "5",
      tokenIdentifier: highBucketViewer,
    });
    expect(decision.gate.enabled).toBe(false);
    if (!decision.gate.enabled) {
      expect(decision.gate.reason).toBe("not_in_rollout");
      expect(decision.gate.tooltip).toBe(SANDBOX_NOT_IN_ROLLOUT_TOOLTIP);
    }
    expect(decision.path).toBe("rollout_excluded");
  });

  test("allowlist match wins over rollout exclusion", () => {
    // A viewer can be admitted via either axis (OR semantics). Even if
    // the rollout would exclude them, an explicit allowlist entry is
    // honored — that is how operators keep VIP testers' access while
    // ramping the broad rollout cautiously.
    const highBucketViewer = findViewerInBucketRange(80, 99);
    const decision = decideSandboxFeatureGate({
      enabledFlag: "true",
      allowlist: highBucketViewer,
      rolloutPercent: "5",
      tokenIdentifier: highBucketViewer,
    });
    expect(decision.gate.enabled).toBe(true);
    expect(decision.path).toBe("allowlisted");
  });

  test("flag_off precedence: master switch off beats both allowlist match and rollout match", () => {
    // The master switch is the operator's kill switch. It must
    // override every other axis — otherwise an "abort the rollout"
    // operation would leak access to allowlist viewers.
    const decision = decideSandboxFeatureGate({
      enabledFlag: "false",
      allowlist: VIEWER,
      rolloutPercent: "100",
      tokenIdentifier: VIEWER,
    });
    expect(decision.gate.enabled).toBe(false);
    if (!decision.gate.enabled) {
      expect(decision.gate.reason).toBe("flag_off");
    }
    expect(decision.path).toBe("flag_off");
  });

  test("invalid rolloutPercent (e.g. 'abc') falls back to 0 and behaves like rollout-off", () => {
    // Operator typo defense. The parsed value is 0, the `path` is
    // `no_access_configured`, the closed reason is the legacy allowlist
    // copy. Rolling everyone out on a typo would be far worse than
    // failing closed.
    const decision = decideSandboxFeatureGate({
      enabledFlag: "true",
      allowlist: OTHER_VIEWER,
      rolloutPercent: "abc",
      tokenIdentifier: VIEWER,
    });
    expect(decision.gate.enabled).toBe(false);
    if (!decision.gate.enabled) {
      expect(decision.gate.reason).toBe("not_allowlisted");
    }
    expect(decision.rolloutPercent).toBe(0);
    expect(decision.path).toBe("no_access_configured");
  });

  test("decision.bucket is always populated and stable for a given identifier", () => {
    // The bucket is a pure function of the identifier — independent of
    // any env vars. So both an open-gate decision (for any reason) and
    // a closed-gate decision must agree on the bucket. Telemetry that
    // tags by `bucket` therefore never depends on the gate outcome.
    const flagOff = decideSandboxFeatureGate({
      enabledFlag: undefined,
      allowlist: undefined,
      rolloutPercent: undefined,
      tokenIdentifier: VIEWER,
    });
    const flagOn = decideSandboxFeatureGate({
      enabledFlag: "true",
      allowlist: VIEWER,
      rolloutPercent: undefined,
      tokenIdentifier: VIEWER,
    });
    expect(flagOff.bucket).toBe(flagOn.bucket);
    expect(flagOff.bucket).toBe(bucketForTokenIdentifier(VIEWER));
  });

  test("path is `wildcard_allowlist` when the allowlist is `*`", () => {
    const decision = decideSandboxFeatureGate({
      enabledFlag: "true",
      allowlist: "*",
      rolloutPercent: "0",
      tokenIdentifier: "user|anyone",
    });
    expect(decision.gate.enabled).toBe(true);
    expect(decision.path).toBe("wildcard_allowlist");
  });
});

describe("getSandboxFeatureGateDecision (env-backed)", () => {
  useIsolatedSandboxEnv();

  test("returns decision sidecar with bucket, rolloutPercent, and path", () => {
    // The sidecar is the consumer-facing API for telemetry: a single
    // call returns enough information to tag a metric without requiring
    // the call site to re-derive any of it.
    process.env.SANDBOX_MODE_ENABLED = "true";
    process.env.SANDBOX_ROLLOUT_PERCENT = "100";
    const decision = getSandboxFeatureGateDecision(VIEWER);

    expect(decision.gate.enabled).toBe(true);
    expect(decision.path).toBe("rollout_admitted");
    expect(decision.rolloutPercent).toBe(100);
    expect(decision.bucket).toBe(bucketForTokenIdentifier(VIEWER));
  });

  test("getSandboxFeatureGate (gate-only facade) stays consistent with the decision", () => {
    // The gate-only facade and the decision sidecar must agree on the
    // gate. Otherwise threadContext.ts (which uses the gate-only
    // facade) and the metric emitter (which uses the decision) would
    // disagree on whether a viewer was admitted.
    process.env.SANDBOX_MODE_ENABLED = "true";
    process.env.SANDBOX_ROLLOUT_PERCENT = "50";
    const decision = getSandboxFeatureGateDecision(VIEWER);
    const gateOnly = getSandboxFeatureGate(VIEWER);
    expect(gateOnly).toEqual(decision.gate);
  });
});

/**
 * Pick a synthetic identifier whose hash bucket falls in the requested
 * `[low, high)` range. Linear search up to a generous bound — the
 * uniformity test in `sandboxRollout.test.ts` already pins the hash
 * distribution, so even a 5-bucket range converges within a few tries.
 *
 * Throwing on miss is intentional: a regression that breaks the bucket
 * distribution should surface as a test failure, not a silent
 * exclusion of the case under test.
 */
function findViewerInBucketRange(low: number, high: number): string {
  for (let i = 0; i < 1000; i++) {
    const candidate = `user|bucket-finder-${i}`;
    const bucket = bucketForTokenIdentifier(candidate);
    if (bucket >= low && bucket < high) {
      return candidate;
    }
  }
  throw new Error(
    `Could not find a synthetic identifier with bucket in [${low}, ${high}) — the hash distribution may be broken.`,
  );
}
