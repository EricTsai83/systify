import { describe, expect, test } from "vitest";
import {
  DISABLED_REASON_SANDBOX_USER_CAP_EXCEEDED,
  DISABLED_REASON_SANDBOX_WORKSPACE_CAP_EXCEEDED,
  OPEN_SANDBOX_COST_CAP_GATE,
  OPEN_SANDBOX_FEATURE_GATE,
  getDefaultThreadMode,
  resolveChatModes,
  type ChatMode,
  type ChatModeSandboxStatus,
  type SandboxCostCapGate,
} from "./chatModeResolver";
import {
  SANDBOX_FLAG_OFF_TOOLTIP,
  SANDBOX_NOT_ALLOWLISTED_TOOLTIP,
  type SandboxFeatureGate,
} from "./lib/sandboxFeatureFlag";

interface ChatModeResolverCase {
  name: string;
  hasAttachedRepo: boolean;
  sandboxStatus: ChatModeSandboxStatus;
  expectedAvailableModes: ChatMode[];
  expectedDefaultMode: ChatMode;
  expectedDisabledModes: ChatMode[];
}

// PRD §"Testing Decisions" requires the full cross-product of
// (hasAttachedRepo) × (sandboxStatus ∈ {none, provisioning, ready, expired, failed}).
// That is 2 × 5 = 10 cases, all evaluated with the Plan-04 feature gate
// **open** so the existing repo / sandbox-lifecycle invariants are tested
// without the gate masking them. Closed-gate cases are exercised in their
// own describe block below.
const cases: ChatModeResolverCase[] = [
  {
    name: "no repo + no sandbox: only discuss available, docs+sandbox disabled with unlock hints",
    hasAttachedRepo: false,
    sandboxStatus: "none",
    expectedAvailableModes: ["discuss"],
    expectedDefaultMode: "discuss",
    expectedDisabledModes: ["docs", "sandbox"],
  },
  {
    name: "no repo + provisioning sandbox: sandbox status ignored, docs+sandbox still disabled",
    hasAttachedRepo: false,
    sandboxStatus: "provisioning",
    expectedAvailableModes: ["discuss"],
    expectedDefaultMode: "discuss",
    expectedDisabledModes: ["docs", "sandbox"],
  },
  {
    name: "no repo + ready sandbox: sandbox status ignored, docs+sandbox still disabled",
    hasAttachedRepo: false,
    sandboxStatus: "ready",
    expectedAvailableModes: ["discuss"],
    expectedDefaultMode: "discuss",
    expectedDisabledModes: ["docs", "sandbox"],
  },
  {
    name: "no repo + expired sandbox: sandbox status ignored, docs+sandbox still disabled",
    hasAttachedRepo: false,
    sandboxStatus: "expired",
    expectedAvailableModes: ["discuss"],
    expectedDefaultMode: "discuss",
    expectedDisabledModes: ["docs", "sandbox"],
  },
  {
    name: "no repo + failed sandbox: sandbox status ignored, docs+sandbox still disabled",
    hasAttachedRepo: false,
    sandboxStatus: "failed",
    expectedAvailableModes: ["discuss"],
    expectedDefaultMode: "discuss",
    expectedDisabledModes: ["docs", "sandbox"],
  },
  {
    name: "repo + no sandbox: discuss+docs available, sandbox disabled (no sandbox)",
    hasAttachedRepo: true,
    sandboxStatus: "none",
    expectedAvailableModes: ["discuss", "docs"],
    expectedDefaultMode: "docs",
    expectedDisabledModes: ["sandbox"],
  },
  {
    name: "repo + provisioning sandbox: discuss+docs available, sandbox disabled (provisioning)",
    hasAttachedRepo: true,
    sandboxStatus: "provisioning",
    expectedAvailableModes: ["discuss", "docs"],
    expectedDefaultMode: "docs",
    expectedDisabledModes: ["sandbox"],
  },
  {
    name: "repo + ready sandbox: all three available, default still docs (sandbox is opt-in)",
    hasAttachedRepo: true,
    sandboxStatus: "ready",
    expectedAvailableModes: ["discuss", "docs", "sandbox"],
    expectedDefaultMode: "docs",
    expectedDisabledModes: [],
  },
  {
    name: "repo + expired sandbox: discuss+docs available, sandbox disabled (expired)",
    hasAttachedRepo: true,
    sandboxStatus: "expired",
    expectedAvailableModes: ["discuss", "docs"],
    expectedDefaultMode: "docs",
    expectedDisabledModes: ["sandbox"],
  },
  {
    name: "repo + failed sandbox: discuss+docs available, sandbox disabled (failed)",
    hasAttachedRepo: true,
    sandboxStatus: "failed",
    expectedAvailableModes: ["discuss", "docs"],
    expectedDefaultMode: "docs",
    expectedDisabledModes: ["sandbox"],
  },
];

describe("resolveChatModes (sandbox feature gate open)", () => {
  test("getDefaultThreadMode centralizes the repo-attached default-mode rule", () => {
    expect(getDefaultThreadMode(false)).toBe("discuss");
    expect(getDefaultThreadMode(true)).toBe("docs");
    expect(getDefaultThreadMode(false)).toBe(resolveChatModes(false, "none", OPEN_SANDBOX_FEATURE_GATE).defaultMode);
    expect(getDefaultThreadMode(true)).toBe(resolveChatModes(true, "none", OPEN_SANDBOX_FEATURE_GATE).defaultMode);
  });

  test.each(cases)("$name", (testCase) => {
    const result = resolveChatModes(testCase.hasAttachedRepo, testCase.sandboxStatus, OPEN_SANDBOX_FEATURE_GATE);

    expect(result.availableModes).toEqual(testCase.expectedAvailableModes);
    expect(result.defaultMode).toBe(testCase.expectedDefaultMode);

    expect(Object.keys(result.disabledReasons).sort()).toEqual([...testCase.expectedDisabledModes].sort());
    for (const mode of testCase.expectedDisabledModes) {
      const reason = result.disabledReasons[mode];
      expect(reason, `disabledReasons.${mode} must be a non-empty string`).toBeTruthy();
      expect(typeof reason).toBe("string");
    }
  });

  test("default mode is always one of the available modes", () => {
    for (const testCase of cases) {
      const result = resolveChatModes(testCase.hasAttachedRepo, testCase.sandboxStatus, OPEN_SANDBOX_FEATURE_GATE);
      expect(result.availableModes).toContain(result.defaultMode);
    }
  });

  test("available modes and disabled-reason keys are mutually exclusive", () => {
    for (const testCase of cases) {
      const result = resolveChatModes(testCase.hasAttachedRepo, testCase.sandboxStatus, OPEN_SANDBOX_FEATURE_GATE);
      const availableSet = new Set(result.availableModes);
      const disabledKeys = Object.keys(result.disabledReasons) as ChatMode[];
      for (const disabled of disabledKeys) {
        expect(availableSet.has(disabled)).toBe(false);
      }
    }
  });

  test("sandbox disabled reasons differ across sandbox states when a repo is attached", () => {
    // Sanity check: each non-ready sandbox state should give a distinct
    // sandbox-mode hint so the UI tooltip can guide the user to the right
    // next step.
    const provisioning = resolveChatModes(true, "provisioning", OPEN_SANDBOX_FEATURE_GATE).disabledReasons.sandbox;
    const failed = resolveChatModes(true, "failed", OPEN_SANDBOX_FEATURE_GATE).disabledReasons.sandbox;
    const expired = resolveChatModes(true, "expired", OPEN_SANDBOX_FEATURE_GATE).disabledReasons.sandbox;
    const noSandbox = resolveChatModes(true, "none", OPEN_SANDBOX_FEATURE_GATE).disabledReasons.sandbox;

    const reasons = [provisioning, failed, expired, noSandbox];
    expect(new Set(reasons).size).toBe(reasons.length);
    for (const reason of reasons) {
      expect(reason).toBeTruthy();
    }
  });
});

describe("resolveChatModes (Plan-04 sandbox feature gate)", () => {
  const FLAG_OFF_GATE: SandboxFeatureGate = {
    enabled: false,
    reason: "flag_off",
    tooltip: SANDBOX_FLAG_OFF_TOOLTIP,
  };
  const NOT_ALLOWLISTED_GATE: SandboxFeatureGate = {
    enabled: false,
    reason: "not_allowlisted",
    tooltip: SANDBOX_NOT_ALLOWLISTED_TOOLTIP,
  };

  test("closed gate removes sandbox from a fully-eligible (repo + ready sandbox) resolution", () => {
    // The most expensive test of the gate: every other condition is
    // satisfied (repo attached, sandbox ready). The gate alone must remove
    // sandbox from `availableModes` and surface the gate's tooltip.
    const result = resolveChatModes(true, "ready", FLAG_OFF_GATE);

    expect(result.availableModes).toEqual(["discuss", "docs"]);
    expect(result.defaultMode).toBe("docs");
    expect(result.disabledReasons.sandbox).toBe(SANDBOX_FLAG_OFF_TOOLTIP);
  });

  test("closed gate's tooltip wins over the lifecycle tooltip when both would apply", () => {
    // Without the gate, a `provisioning` sandbox would surface a
    // "provisioning" tooltip. With the gate closed, the gate tooltip
    // ("private beta") is the more actionable explanation — provisioning a
    // sandbox would not unlock sandbox mode for an off-allowlist viewer.
    const result = resolveChatModes(true, "provisioning", NOT_ALLOWLISTED_GATE);

    expect(result.availableModes).toEqual(["discuss", "docs"]);
    expect(result.disabledReasons.sandbox).toBe(SANDBOX_NOT_ALLOWLISTED_TOOLTIP);
    expect(result.disabledReasons.sandbox).not.toMatch(/provisioning/i);
  });

  test("closed gate is a no-op when sandbox was already unavailable for other reasons", () => {
    // No repo means sandbox was already disabled; the gate doesn't
    // *additionally* break anything. The disabledReasons.sandbox tooltip
    // shifts to the gate's copy because the gate now owns "sandbox is
    // disabled" — but availableModes / defaultMode are unchanged.
    const result = resolveChatModes(false, "none", FLAG_OFF_GATE);

    expect(result.availableModes).toEqual(["discuss"]);
    expect(result.defaultMode).toBe("discuss");
    expect(result.disabledReasons.sandbox).toBe(SANDBOX_FLAG_OFF_TOOLTIP);
    expect(result.disabledReasons.docs).toBeTruthy();
  });

  test("open gate is idempotent — leaves the underlying resolution untouched", () => {
    const baseline = resolveChatModes(true, "ready", OPEN_SANDBOX_FEATURE_GATE);
    expect(baseline.availableModes).toContain("sandbox");
    expect(baseline.disabledReasons).toEqual({});
  });

  test("default mode invariant survives gate closure", () => {
    // Sandbox is never the default (opt-in), so removing it from
    // availableModes can never orphan defaultMode. Cover every (repo,
    // sandbox-status) combo against a closed gate as a regression guard.
    for (const testCase of cases) {
      const result = resolveChatModes(testCase.hasAttachedRepo, testCase.sandboxStatus, FLAG_OFF_GATE);
      expect(result.availableModes).toContain(result.defaultMode);
      expect(result.availableModes).not.toContain("sandbox");
    }
  });
});

/**
 * Plan 10 — sandbox daily-cost-cap gate. Layered on top of the existing
 * resolver and feature gate so the resolver tests document the precedence
 * rule explicitly: cap-gate disables sandbox the same way the feature
 * gate does, but the feature gate's tooltip wins on conflict.
 */
describe("resolveChatModes (Plan-10 sandbox cost-cap gate)", () => {
  const USER_CAP_GATE_CLOSED: SandboxCostCapGate = {
    enabled: false,
    reason: "user_daily_cap_exceeded",
    tooltip: DISABLED_REASON_SANDBOX_USER_CAP_EXCEEDED,
    resetAtMs: Date.UTC(2026, 4, 6, 0, 0, 0), // 2026-05-06 00:00 UTC
  };
  const WORKSPACE_CAP_GATE_CLOSED: SandboxCostCapGate = {
    enabled: false,
    reason: "workspace_daily_cap_exceeded",
    tooltip: DISABLED_REASON_SANDBOX_WORKSPACE_CAP_EXCEEDED,
    resetAtMs: Date.UTC(2026, 4, 6, 0, 0, 0),
  };

  test("closed user-cap gate removes sandbox from a fully-eligible (repo + ready sandbox) resolution", () => {
    // The most expensive test: a viewer who would otherwise have full
    // sandbox access has hit their user cap. The cap gate alone removes
    // sandbox and surfaces the user-cap tooltip — without it, the user
    // could still queue a send that would block server-side anyway.
    const result = resolveChatModes(true, "ready", OPEN_SANDBOX_FEATURE_GATE, USER_CAP_GATE_CLOSED);

    expect(result.availableModes).toEqual(["discuss", "docs"]);
    expect(result.defaultMode).toBe("docs");
    expect(result.disabledReasons.sandbox).toBe(DISABLED_REASON_SANDBOX_USER_CAP_EXCEEDED);
  });

  test("closed workspace-cap gate uses the workspace-scoped tooltip", () => {
    const result = resolveChatModes(true, "ready", OPEN_SANDBOX_FEATURE_GATE, WORKSPACE_CAP_GATE_CLOSED);

    expect(result.availableModes).toEqual(["discuss", "docs"]);
    expect(result.disabledReasons.sandbox).toBe(DISABLED_REASON_SANDBOX_WORKSPACE_CAP_EXCEEDED);
    // Sanity: user-cap and workspace-cap tooltips are distinct so the UI
    // can render scope-specific guidance.
    expect(DISABLED_REASON_SANDBOX_USER_CAP_EXCEEDED).not.toBe(DISABLED_REASON_SANDBOX_WORKSPACE_CAP_EXCEEDED);
  });

  test("feature gate wins over cap gate when both fire", () => {
    // Precedence rule: a viewer outside the private-beta allowlist
    // should see "private beta" rather than "you're over your cap" —
    // the cap is irrelevant to a viewer who can't use sandbox at all.
    const FLAG_OFF_GATE: SandboxFeatureGate = {
      enabled: false,
      reason: "flag_off",
      tooltip: SANDBOX_FLAG_OFF_TOOLTIP,
    };
    const NOT_ALLOWLISTED_GATE: SandboxFeatureGate = {
      enabled: false,
      reason: "not_allowlisted",
      tooltip: SANDBOX_NOT_ALLOWLISTED_TOOLTIP,
    };

    const flagOffResult = resolveChatModes(true, "ready", FLAG_OFF_GATE, USER_CAP_GATE_CLOSED);
    expect(flagOffResult.disabledReasons.sandbox).toBe(SANDBOX_FLAG_OFF_TOOLTIP);
    expect(flagOffResult.availableModes).not.toContain("sandbox");

    const notAllowlistedResult = resolveChatModes(true, "ready", NOT_ALLOWLISTED_GATE, USER_CAP_GATE_CLOSED);
    expect(notAllowlistedResult.disabledReasons.sandbox).toBe(SANDBOX_NOT_ALLOWLISTED_TOOLTIP);
  });

  test("open cap gate is a no-op when sandbox was already eligible", () => {
    const result = resolveChatModes(true, "ready", OPEN_SANDBOX_FEATURE_GATE, OPEN_SANDBOX_COST_CAP_GATE);
    expect(result.availableModes).toEqual(["discuss", "docs", "sandbox"]);
    expect(result.disabledReasons).toEqual({});
  });

  test("closed cap gate doesn't affect docs / discuss availability", () => {
    // Defensive: the cap gate is sandbox-specific. Docs / discuss must
    // remain available regardless — they bill the cheaper `chat`
    // category and aren't subject to the sandbox cap.
    const result = resolveChatModes(true, "ready", OPEN_SANDBOX_FEATURE_GATE, USER_CAP_GATE_CLOSED);
    expect(result.availableModes).toContain("discuss");
    expect(result.availableModes).toContain("docs");
  });

  test("default mode invariant survives cost-cap closure across every (repo, sandbox-status) combo", () => {
    // Same regression guard as the feature-gate test: defaultMode is
    // never sandbox, so removing sandbox via the cap gate cannot
    // orphan it.
    for (const testCase of cases) {
      const result = resolveChatModes(
        testCase.hasAttachedRepo,
        testCase.sandboxStatus,
        OPEN_SANDBOX_FEATURE_GATE,
        USER_CAP_GATE_CLOSED,
      );
      expect(result.availableModes).toContain(result.defaultMode);
      expect(result.availableModes).not.toContain("sandbox");
    }
  });

  test("resolveChatModes is backward-compatible (cap gate defaults to open)", () => {
    // The 4-arg signature with the cap-gate default keeps existing
    // 3-arg callers (tests, scripts, future code that doesn't care
    // about the cap) working without a refactor sweep.
    const withDefault = resolveChatModes(true, "ready", OPEN_SANDBOX_FEATURE_GATE);
    const withExplicitOpen = resolveChatModes(true, "ready", OPEN_SANDBOX_FEATURE_GATE, OPEN_SANDBOX_COST_CAP_GATE);
    expect(withDefault).toEqual(withExplicitOpen);
  });
});
