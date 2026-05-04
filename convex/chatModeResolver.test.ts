import { describe, expect, test } from "vitest";
import {
  OPEN_SANDBOX_FEATURE_GATE,
  getDefaultThreadMode,
  resolveChatModes,
  type ChatMode,
  type ChatModeSandboxStatus,
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
