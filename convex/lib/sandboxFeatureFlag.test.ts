import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  SANDBOX_FLAG_OFF_TOOLTIP,
  SANDBOX_NOT_ALLOWLISTED_TOOLTIP,
  evaluateSandboxFeatureGate,
  getSandboxFeatureGate,
} from "./sandboxFeatureFlag";

const VIEWER = "user|alice";
const OTHER_VIEWER = "user|bob";

describe("evaluateSandboxFeatureGate (pure)", () => {
  test.each([undefined, "", "false", "0", "no", "off", "  False  ", "FALSE"])(
    "treats %j as flag off",
    (flagValue) => {
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
    },
  );

  test.each(["true", "1", "yes", "on", "  TRUE  ", "True"])(
    "treats %j as flag on",
    (flagValue) => {
      const gate = evaluateSandboxFeatureGate({
        enabledFlag: flagValue,
        allowlist: VIEWER,
        tokenIdentifier: VIEWER,
      });

      expect(gate.enabled).toBe(true);
    },
  );

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

describe("getSandboxFeatureGate (env-backed)", () => {
  // Each test mutates `process.env`; restore the prior values so unrelated
  // tests in the same vitest worker stay deterministic.
  let priorEnabled: string | undefined;
  let priorAllowlist: string | undefined;

  beforeEach(() => {
    priorEnabled = process.env.SANDBOX_MODE_ENABLED;
    priorAllowlist = process.env.SANDBOX_BETA_ALLOWLIST;
    delete process.env.SANDBOX_MODE_ENABLED;
    delete process.env.SANDBOX_BETA_ALLOWLIST;
  });

  afterEach(() => {
    if (priorEnabled === undefined) {
      delete process.env.SANDBOX_MODE_ENABLED;
    } else {
      process.env.SANDBOX_MODE_ENABLED = priorEnabled;
    }
    if (priorAllowlist === undefined) {
      delete process.env.SANDBOX_BETA_ALLOWLIST;
    } else {
      process.env.SANDBOX_BETA_ALLOWLIST = priorAllowlist;
    }
  });

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
});
