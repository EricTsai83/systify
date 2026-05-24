import { describe, expect, test } from "vitest";
import {
  DISABLED_REASON_SANDBOX_USER_CAP_EXCEEDED,
  DISABLED_REASON_SANDBOX_WORKSPACE_CAP_EXCEEDED,
  OPEN_SANDBOX_COST_CAP_GATE,
  getDefaultThreadMode,
  resolveChatModes,
  type ChatMode,
  type ChatModeSandboxStatus,
  type SandboxCostCapGate,
} from "./chatModeResolver";

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
// That is 2 × 5 = 10 cases, all evaluated with the cost-cap gate left at
// its default (open) so the repo / sandbox-lifecycle invariants are tested
// without the gate masking them. Closed cost-cap cases are exercised in
// their own describe block below.
const cases: ChatModeResolverCase[] = [
  {
    name: "no repo + no sandbox: only discuss available, docs+sandbox disabled with unlock hints",
    hasAttachedRepo: false,
    sandboxStatus: "none",
    expectedAvailableModes: ["discuss"],
    expectedDefaultMode: "discuss",
    expectedDisabledModes: ["lab", "library"],
  },
  {
    name: "no repo + provisioning sandbox: sandbox status ignored, docs+sandbox still disabled",
    hasAttachedRepo: false,
    sandboxStatus: "provisioning",
    expectedAvailableModes: ["discuss"],
    expectedDefaultMode: "discuss",
    expectedDisabledModes: ["lab", "library"],
  },
  {
    name: "no repo + ready sandbox: sandbox status ignored, docs+sandbox still disabled",
    hasAttachedRepo: false,
    sandboxStatus: "ready",
    expectedAvailableModes: ["discuss"],
    expectedDefaultMode: "discuss",
    expectedDisabledModes: ["lab", "library"],
  },
  {
    name: "no repo + expired sandbox: sandbox status ignored, docs+sandbox still disabled",
    hasAttachedRepo: false,
    sandboxStatus: "expired",
    expectedAvailableModes: ["discuss"],
    expectedDefaultMode: "discuss",
    expectedDisabledModes: ["lab", "library"],
  },
  {
    name: "no repo + failed sandbox: sandbox status ignored, docs+sandbox still disabled",
    hasAttachedRepo: false,
    sandboxStatus: "failed",
    expectedAvailableModes: ["discuss"],
    expectedDefaultMode: "discuss",
    expectedDisabledModes: ["lab", "library"],
  },
  {
    name: "repo + no sandbox: discuss+docs available, sandbox disabled (no sandbox)",
    hasAttachedRepo: true,
    sandboxStatus: "none",
    expectedAvailableModes: ["discuss", "library"],
    expectedDefaultMode: "library",
    expectedDisabledModes: ["lab"],
  },
  {
    name: "repo + provisioning sandbox: discuss+docs available, sandbox disabled (provisioning)",
    hasAttachedRepo: true,
    sandboxStatus: "provisioning",
    expectedAvailableModes: ["discuss", "library"],
    expectedDefaultMode: "library",
    expectedDisabledModes: ["lab"],
  },
  {
    name: "repo + ready sandbox: all three available, default still docs (sandbox is opt-in)",
    hasAttachedRepo: true,
    sandboxStatus: "ready",
    expectedAvailableModes: ["discuss", "library", "lab"],
    expectedDefaultMode: "library",
    expectedDisabledModes: [],
  },
  {
    name: "repo + expired sandbox: discuss+docs available, sandbox disabled (expired)",
    hasAttachedRepo: true,
    sandboxStatus: "expired",
    expectedAvailableModes: ["discuss", "library"],
    expectedDefaultMode: "library",
    expectedDisabledModes: ["lab"],
  },
  {
    name: "repo + failed sandbox: discuss+docs available, sandbox disabled (failed)",
    hasAttachedRepo: true,
    sandboxStatus: "failed",
    expectedAvailableModes: ["discuss", "library"],
    expectedDefaultMode: "library",
    expectedDisabledModes: ["lab"],
  },
];

describe("resolveChatModes", () => {
  test("getDefaultThreadMode centralizes the repo-attached default-mode rule", () => {
    expect(getDefaultThreadMode(false)).toBe("discuss");
    expect(getDefaultThreadMode(true)).toBe("library");
    expect(getDefaultThreadMode(false)).toBe(resolveChatModes(false, "none").defaultMode);
    expect(getDefaultThreadMode(true)).toBe(resolveChatModes(true, "none").defaultMode);
  });

  test.each(cases)("$name", (testCase) => {
    const result = resolveChatModes(testCase.hasAttachedRepo, testCase.sandboxStatus);

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
      const result = resolveChatModes(testCase.hasAttachedRepo, testCase.sandboxStatus);
      expect(result.availableModes).toContain(result.defaultMode);
    }
  });

  test("available modes and disabled-reason keys are mutually exclusive", () => {
    for (const testCase of cases) {
      const result = resolveChatModes(testCase.hasAttachedRepo, testCase.sandboxStatus);
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
    const provisioning = resolveChatModes(true, "provisioning").disabledReasons.lab;
    const failed = resolveChatModes(true, "failed").disabledReasons.lab;
    const expired = resolveChatModes(true, "expired").disabledReasons.lab;
    const noSandbox = resolveChatModes(true, "none").disabledReasons.lab;

    const reasons = [provisioning, failed, expired, noSandbox];
    expect(new Set(reasons).size).toBe(reasons.length);
    for (const reason of reasons) {
      expect(reason).toBeTruthy();
    }
  });
});

/**
 * Plan 10 — sandbox daily-cost-cap gate. Layered on top of the
 * lifecycle resolution: cap-gate disables sandbox when the per-user
 * or per-workspace daily spend cap is exhausted, regardless of the
 * underlying sandbox state.
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
    const result = resolveChatModes(true, "ready", USER_CAP_GATE_CLOSED);

    expect(result.availableModes).toEqual(["discuss", "library"]);
    expect(result.defaultMode).toBe("library");
    expect(result.disabledReasons.lab).toBe(DISABLED_REASON_SANDBOX_USER_CAP_EXCEEDED);
  });

  test("closed workspace-cap gate uses the workspace-scoped tooltip", () => {
    const result = resolveChatModes(true, "ready", WORKSPACE_CAP_GATE_CLOSED);

    expect(result.availableModes).toEqual(["discuss", "library"]);
    expect(result.disabledReasons.lab).toBe(DISABLED_REASON_SANDBOX_WORKSPACE_CAP_EXCEEDED);
    // Sanity: user-cap and workspace-cap tooltips are distinct so the UI
    // can render scope-specific guidance.
    expect(DISABLED_REASON_SANDBOX_USER_CAP_EXCEEDED).not.toBe(DISABLED_REASON_SANDBOX_WORKSPACE_CAP_EXCEEDED);
  });

  test("open cap gate is a no-op when sandbox was already eligible", () => {
    const result = resolveChatModes(true, "ready", OPEN_SANDBOX_COST_CAP_GATE);
    expect(result.availableModes).toEqual(["discuss", "library", "lab"]);
    expect(result.disabledReasons).toEqual({});
  });

  test("closed cap gate doesn't affect docs / discuss availability", () => {
    // Defensive: the cap gate is sandbox-specific. Docs / discuss must
    // remain available regardless — they bill the cheaper `chat`
    // category and aren't subject to the sandbox cap.
    const result = resolveChatModes(true, "ready", USER_CAP_GATE_CLOSED);
    expect(result.availableModes).toContain("discuss");
    expect(result.availableModes).toContain("library");
  });

  test("default mode invariant survives cost-cap closure across every (repo, sandbox-status) combo", () => {
    // defaultMode is never sandbox, so removing sandbox via the cap
    // gate cannot orphan it.
    for (const testCase of cases) {
      const result = resolveChatModes(testCase.hasAttachedRepo, testCase.sandboxStatus, USER_CAP_GATE_CLOSED);
      expect(result.availableModes).toContain(result.defaultMode);
      expect(result.availableModes).not.toContain("lab");
    }
  });

  test("resolveChatModes is backward-compatible (cap gate defaults to open)", () => {
    // The 3-arg signature with the cap-gate default keeps callers that
    // don't care about the cap working without a refactor sweep.
    const withDefault = resolveChatModes(true, "ready");
    const withExplicitOpen = resolveChatModes(true, "ready", OPEN_SANDBOX_COST_CAP_GATE);
    expect(withDefault).toEqual(withExplicitOpen);
  });
});
