import { describe, expect, test } from "vitest";
import { getDefaultThreadMode } from "./chatMode";
import {
  DISABLED_REASON_SANDBOX_USER_CAP_EXCEEDED,
  DISABLED_REASON_SANDBOX_REPOSITORY_CAP_EXCEEDED,
  OPEN_SANDBOX_COST_CAP_GATE,
  resolveChatModes,
  resolveRepositoryModes,
  type ChatModeSandboxStatus,
  type SandboxCostCapGate,
} from "./chatEligibility";

describe("resolveChatModes", () => {
  test("getDefaultThreadMode centralizes the repo-attached default-mode rule", () => {
    expect(getDefaultThreadMode(false)).toBe("discuss");
    expect(getDefaultThreadMode(true)).toBe("library");
    expect(getDefaultThreadMode(false)).toBe(resolveChatModes(false).defaultMode);
    expect(getDefaultThreadMode(true)).toBe(resolveChatModes(true).defaultMode);
  });

  test("no repo: only discuss available, library disabled with unlock hint", () => {
    const result = resolveChatModes(false);
    expect(result.modes.discuss.enabled).toBe(true);
    expect(result.modes.library.enabled).toBe(false);
    expect(result.modes.library).toHaveProperty("code", "no_repository_attached");
    expect(result.modes.library).toHaveProperty("message");
    expect(result.defaultMode).toBe("discuss");
  });

  test("repo attached: discuss + library available, no disabled modes", () => {
    const result = resolveChatModes(true);
    expect(result.modes.discuss.enabled).toBe(true);
    expect(result.modes.library.enabled).toBe(true);
    expect(result.defaultMode).toBe("library");
  });

  test("default mode is always enabled", () => {
    const resultNoRepo = resolveChatModes(false);
    expect(resultNoRepo.modes[resultNoRepo.defaultMode].enabled).toBe(true);

    const resultWithRepo = resolveChatModes(true);
    expect(resultWithRepo.modes[resultWithRepo.defaultMode].enabled).toBe(true);
  });
});

/**
 * Sandbox daily-cost-cap gate lives on the grounding axis exposed by
 * {@link resolveRepositoryModes}: when the per-user or per-repository
 * daily spend cap is exhausted the Sandbox grounding axis closes and
 * surfaces the cost-cap tooltip. Discuss / Library mode availability
 * itself is not touched by the cap.
 */
describe("resolveRepositoryModes (sandbox cost-cap gate on grounding axis)", () => {
  const USER_CAP_GATE_CLOSED: SandboxCostCapGate = {
    enabled: false,
    reason: "user_daily_cap_exceeded",
    tooltip: DISABLED_REASON_SANDBOX_USER_CAP_EXCEEDED,
    resetAtMs: Date.UTC(2026, 4, 6, 0, 0, 0), // 2026-05-06 00:00 UTC
  };
  const REPOSITORY_CAP_GATE_CLOSED: SandboxCostCapGate = {
    enabled: false,
    reason: "repository_daily_cap_exceeded",
    tooltip: DISABLED_REASON_SANDBOX_REPOSITORY_CAP_EXCEEDED,
    resetAtMs: Date.UTC(2026, 4, 6, 0, 0, 0),
  };

  test("closed user-cap gate closes the sandbox grounding axis with the user-cap tooltip", () => {
    const result = resolveRepositoryModes(true, true, "ready", USER_CAP_GATE_CLOSED);

    expect(result.modes.discuss.enabled).toBe(true);
    expect(result.modes.library.enabled).toBe(true);
    expect(result.defaultMode).toBe("library");
    expect(result.grounding.sandbox.enabled).toBe(false);
    expect(result.grounding.sandbox).toHaveProperty("code", "sandbox_user_cap_exceeded");
    expect(result.grounding.sandbox).toHaveProperty("message", DISABLED_REASON_SANDBOX_USER_CAP_EXCEEDED);
  });

  test("closed repository-cap gate uses the repository-scoped tooltip", () => {
    const result = resolveRepositoryModes(true, true, "ready", REPOSITORY_CAP_GATE_CLOSED);

    expect(result.modes.discuss.enabled).toBe(true);
    expect(result.modes.library.enabled).toBe(true);
    expect(result.grounding.sandbox.enabled).toBe(false);
    expect(result.grounding.sandbox).toHaveProperty("code", "sandbox_repository_cap_exceeded");
    expect(result.grounding.sandbox).toHaveProperty("message", DISABLED_REASON_SANDBOX_REPOSITORY_CAP_EXCEEDED);
    expect(DISABLED_REASON_SANDBOX_USER_CAP_EXCEEDED).not.toBe(DISABLED_REASON_SANDBOX_REPOSITORY_CAP_EXCEEDED);
  });

  test("open cap gate leaves the sandbox grounding axis enabled", () => {
    const result = resolveRepositoryModes(true, true, "ready", OPEN_SANDBOX_COST_CAP_GATE);
    expect(result.modes.discuss.enabled).toBe(true);
    expect(result.modes.library.enabled).toBe(true);
    expect(result.grounding.sandbox.enabled).toBe(true);
  });

  test("closed cap gate doesn't disable discuss or library modes", () => {
    const result = resolveRepositoryModes(true, true, "ready", USER_CAP_GATE_CLOSED);
    expect(result.modes.discuss.enabled).toBe(true);
    expect(result.modes.library.enabled).toBe(true);
  });

  test("default mode invariant survives cost-cap closure across sandbox states", () => {
    const sandboxStates: ChatModeSandboxStatus[] = ["none", "provisioning", "ready", "expired", "failed"];
    for (const status of sandboxStates) {
      const result = resolveRepositoryModes(true, true, status, USER_CAP_GATE_CLOSED);
      expect(result.modes[result.defaultMode].enabled).toBe(true);
      expect(result.grounding.sandbox.enabled).toBe(false);
    }
  });

  test("resolveRepositoryModes is backward-compatible (cap gate defaults to open)", () => {
    const withDefault = resolveRepositoryModes(true, true, "ready");
    const withExplicitOpen = resolveRepositoryModes(true, true, "ready", OPEN_SANDBOX_COST_CAP_GATE);
    expect(withDefault).toEqual(withExplicitOpen);
  });
});
