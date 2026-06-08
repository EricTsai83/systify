import { describe, expect, test } from "vitest";
import type { Doc } from "../../convex/_generated/dataModel";
import type { SandboxModeStatus } from "./types";
import {
  isUserRelevantActiveJob,
  isUserRelevantJob,
  presentRepositoryIntelligenceSurface,
  presentSandboxSurface,
} from "./operations";

function makeJob(overrides: Partial<Doc<"jobs">>): Doc<"jobs"> {
  return {
    _id: "job_1" as Doc<"jobs">["_id"],
    _creationTime: 0,
    ownerTokenIdentifier: "tok",
    kind: "import",
    status: "running",
    stage: "queued",
    progress: 0,
    costCategory: "ops",
    triggerSource: "user",
    leaseExpiresAt: 0,
    ...overrides,
  } as Doc<"jobs">;
}

function makeStatus(overrides: Partial<SandboxModeStatus> = {}): SandboxModeStatus {
  return {
    reasonCode: "available",
    message: null,
    ...overrides,
  };
}

describe("isUserRelevantActiveJob / isUserRelevantJob", () => {
  test("admits user-initiated kinds in active states", () => {
    for (const kind of ["import", "index", "chat", "system_design", "artifact_draft"] as const) {
      expect(isUserRelevantActiveJob(makeJob({ kind, status: "queued" }))).toBe(true);
      expect(isUserRelevantActiveJob(makeJob({ kind, status: "running" }))).toBe(true);
    }
  });

  test("rejects terminal states for active gate", () => {
    for (const status of ["completed", "failed", "cancelled"] as const) {
      expect(isUserRelevantActiveJob(makeJob({ kind: "import", status }))).toBe(false);
    }
  });

  test("rejects system-maintenance kinds regardless of status", () => {
    expect(isUserRelevantActiveJob(makeJob({ kind: "cleanup", status: "running" }))).toBe(false);
    expect(isUserRelevantJob(makeJob({ kind: "cleanup", status: "completed" }))).toBe(false);
  });

  test("any-status gate accepts user kinds at every status", () => {
    for (const status of ["queued", "running", "completed", "failed", "cancelled"] as const) {
      expect(isUserRelevantJob(makeJob({ kind: "system_design", status }))).toBe(true);
    }
  });
});

describe("presentRepositoryIntelligenceSurface", () => {
  test("failure dominates everything else", () => {
    const surface = presentRepositoryIntelligenceSurface({
      importStatus: "failed",
      isSyncing: true,
      hasRemoteUpdates: true,
    });
    expect(surface.tone).toBe("error");
    expect(surface.title).toBe("Sync needs attention");
  });

  test("active sync wins over remote-updates banner", () => {
    expect(
      presentRepositoryIntelligenceSurface({
        importStatus: "running",
        isSyncing: false,
        hasRemoteUpdates: true,
      }).tone,
    ).toBe("active");
    expect(
      presentRepositoryIntelligenceSurface({
        importStatus: "completed",
        isSyncing: true,
        hasRemoteUpdates: true,
      }).tone,
    ).toBe("active");
  });

  test("idle + remote updates renders as warning", () => {
    const surface = presentRepositoryIntelligenceSurface({
      importStatus: "completed",
      isSyncing: false,
      hasRemoteUpdates: true,
    });
    expect(surface.tone).toBe("warning");
    expect(surface.title).toBe("Update available");
  });

  test("idle + no updates renders as success", () => {
    const surface = presentRepositoryIntelligenceSurface({
      importStatus: "completed",
      isSyncing: false,
      hasRemoteUpdates: false,
    });
    expect(surface.tone).toBe("success");
    expect(surface.title).toBe("Knowledge ready");
  });
});

describe("presentSandboxSurface", () => {
  test("available state surfaces ttlExpiresAt for the auto-archive countdown", () => {
    const surface = presentSandboxSurface({
      sandboxModeStatus: makeStatus({ reasonCode: "available" }),
      sandbox: { status: "running", ttlExpiresAt: 1_000_000 },
    });
    expect(surface.tone).toBe("success");
    expect(surface.ttlExpiresAt).toBe(1_000_000);
  });

  test("non-available states omit ttlExpiresAt", () => {
    for (const reasonCode of [
      "sandbox_provisioning",
      "sandbox_expired",
      "sandbox_unavailable",
      "missing_sandbox",
    ] as const) {
      const surface = presentSandboxSurface({
        sandboxModeStatus: makeStatus({ reasonCode }),
        sandbox: { status: "running", ttlExpiresAt: 1_000_000 },
      });
      expect(surface.ttlExpiresAt).toBeUndefined();
    }
  });

  test("falls back to default copy when sandboxModeStatus.message is null", () => {
    expect(
      presentSandboxSurface({
        sandboxModeStatus: makeStatus({ reasonCode: "missing_sandbox" }),
        sandbox: null,
      }).description,
    ).toMatch(/Activate live source access/);
  });

  test("prefers backend-supplied message when present", () => {
    const surface = presentSandboxSurface({
      sandboxModeStatus: makeStatus({
        reasonCode: "sandbox_unavailable",
        message: "Daytona reported a quota error.",
      }),
      sandbox: null,
    });
    expect(surface.description).toBe("Daytona reported a quota error.");
    expect(surface.tone).toBe("error");
  });
});
