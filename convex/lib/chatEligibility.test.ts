import { describe, expect, test } from "vitest";
import { getDefaultThreadMode, type ChatMode } from "./chatMode";
import {
  DISABLED_REASON_SANDBOX_USER_CAP_EXCEEDED,
  DISABLED_REASON_SANDBOX_WORKSPACE_CAP_EXCEEDED,
  OPEN_SANDBOX_COST_CAP_GATE,
  resolveChatModes,
  resolveWorkspaceModes,
  type ChatModeSandboxStatus,
  type SandboxCostCapGate,
} from "./chatEligibility";

interface ChatModeResolverCase {
  name: string;
  hasAttachedRepo: boolean;
  expectedAvailableModes: ChatMode[];
  expectedDefaultMode: ChatMode;
  expectedDisabledModes: ChatMode[];
}

// Post-Lab collapse: `resolveChatModes` now only takes `hasAttachedRepo`; the
// (sandbox-status, cost-cap) matrix that used to feed it now belongs to the
// grounding axes exposed via `resolveWorkspaceModes`. The per-thread
// chat-mode resolver only carries the `discuss` vs. `library` availability.
const cases: ChatModeResolverCase[] = [
  {
    name: "no repo: only discuss available, library disabled with unlock hint",
    hasAttachedRepo: false,
    expectedAvailableModes: ["discuss"],
    expectedDefaultMode: "discuss",
    expectedDisabledModes: ["library"],
  },
  {
    name: "repo attached: discuss + library available, no disabled modes",
    hasAttachedRepo: true,
    expectedAvailableModes: ["discuss", "library"],
    expectedDefaultMode: "library",
    expectedDisabledModes: [],
  },
];

describe("resolveChatModes", () => {
  test("getDefaultThreadMode centralizes the repo-attached default-mode rule", () => {
    expect(getDefaultThreadMode(false)).toBe("discuss");
    expect(getDefaultThreadMode(true)).toBe("library");
    expect(getDefaultThreadMode(false)).toBe(resolveChatModes(false).defaultMode);
    expect(getDefaultThreadMode(true)).toBe(resolveChatModes(true).defaultMode);
  });

  test.each(cases)("$name", (testCase) => {
    const result = resolveChatModes(testCase.hasAttachedRepo);

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
      const result = resolveChatModes(testCase.hasAttachedRepo);
      expect(result.availableModes).toContain(result.defaultMode);
    }
  });

  test("available modes and disabled-reason keys are mutually exclusive", () => {
    for (const testCase of cases) {
      const result = resolveChatModes(testCase.hasAttachedRepo);
      const availableSet = new Set(result.availableModes);
      const disabledKeys = Object.keys(result.disabledReasons) as ChatMode[];
      for (const disabled of disabledKeys) {
        expect(availableSet.has(disabled)).toBe(false);
      }
    }
  });
});

/**
 * Plan 10 — sandbox daily-cost-cap gate now lives on the grounding axis
 * exposed by {@link resolveWorkspaceModes}: when the per-user or
 * per-workspace daily spend cap is exhausted the Sandbox grounding axis
 * closes and surfaces the cost-cap tooltip. Discuss / Library mode
 * availability itself is no longer touched by the cap.
 */
describe("resolveWorkspaceModes (sandbox cost-cap gate on grounding axis)", () => {
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

  test("closed user-cap gate closes the sandbox grounding axis with the user-cap tooltip", () => {
    const result = resolveWorkspaceModes(true, true, "ready", USER_CAP_GATE_CLOSED);

    expect(result.availableModes).toEqual(["discuss", "library"]);
    expect(result.defaultMode).toBe("library");
    expect(result.grounding.sandbox.available).toBe(false);
    expect(result.grounding.sandbox.reason).toBe(DISABLED_REASON_SANDBOX_USER_CAP_EXCEEDED);
  });

  test("closed workspace-cap gate uses the workspace-scoped tooltip", () => {
    const result = resolveWorkspaceModes(true, true, "ready", WORKSPACE_CAP_GATE_CLOSED);

    expect(result.availableModes).toEqual(["discuss", "library"]);
    expect(result.grounding.sandbox.available).toBe(false);
    expect(result.grounding.sandbox.reason).toBe(DISABLED_REASON_SANDBOX_WORKSPACE_CAP_EXCEEDED);
    // Sanity: user-cap and workspace-cap tooltips are distinct so the UI
    // can render scope-specific guidance.
    expect(DISABLED_REASON_SANDBOX_USER_CAP_EXCEEDED).not.toBe(DISABLED_REASON_SANDBOX_WORKSPACE_CAP_EXCEEDED);
  });

  test("open cap gate leaves the sandbox grounding axis available", () => {
    const result = resolveWorkspaceModes(true, true, "ready", OPEN_SANDBOX_COST_CAP_GATE);
    expect(result.availableModes).toEqual(["discuss", "library"]);
    expect(result.grounding.sandbox.available).toBe(true);
    expect(result.grounding.sandbox.reason).toBeNull();
  });

  test("closed cap gate doesn't remove discuss or library from availableModes", () => {
    // Defensive: the cap gate is sandbox-grounding-specific. The discuss /
    // library mode availability itself must remain unaffected.
    const result = resolveWorkspaceModes(true, true, "ready", USER_CAP_GATE_CLOSED);
    expect(result.availableModes).toContain("discuss");
    expect(result.availableModes).toContain("library");
  });

  test("default mode invariant survives cost-cap closure across sandbox states", () => {
    // defaultMode is never sandbox, so closing the sandbox grounding axis
    // via the cap gate cannot orphan it.
    const sandboxStates: ChatModeSandboxStatus[] = ["none", "provisioning", "ready", "expired", "failed"];
    for (const status of sandboxStates) {
      const result = resolveWorkspaceModes(true, true, status, USER_CAP_GATE_CLOSED);
      expect(result.availableModes).toContain(result.defaultMode);
      expect(result.grounding.sandbox.available).toBe(false);
    }
  });

  test("resolveWorkspaceModes is backward-compatible (cap gate defaults to open)", () => {
    // The 4-arg signature with the cap-gate default keeps callers that
    // don't care about the cap working without a refactor sweep.
    const withDefault = resolveWorkspaceModes(true, true, "ready");
    const withExplicitOpen = resolveWorkspaceModes(true, true, "ready", OPEN_SANDBOX_COST_CAP_GATE);
    expect(withDefault).toEqual(withExplicitOpen);
  });
});
