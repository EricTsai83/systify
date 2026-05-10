import { describe, expect, test } from "vitest";
import { getSandboxAvailability, getSandboxModeStatus } from "./lib/sandboxAvailability";

describe("getSandboxModeStatus", () => {
  test("returns only the public status fields while matching availability semantics", () => {
    const sandbox = {
      status: "ready" as const,
      ttlExpiresAt: 10_000,
      remoteId: "remote-1",
      repoPath: "/workspace/repo",
    };

    const availability = getSandboxAvailability(sandbox, 5_000);
    const status = getSandboxModeStatus(sandbox, 5_000);

    expect(status).toEqual({
      reasonCode: "available",
      message: null,
    });
    expect(status).toEqual({
      reasonCode: availability.reasonCode,
      message: availability.message,
    });
    expect(Object.keys(status).sort()).toEqual(["message", "reasonCode"]);
  });
});

describe("getSandboxAvailability", () => {
  // Pins the archived/failed split: archiving is a normal lifecycle event
  // (Daytona auto-archives after the idle interval) and should surface as a
  // warning, while `failed` is a genuine error. Conflating the two caused the
  // top-bar StatusPill to render "Sandbox error" for every archived repo.
  test("archived sandbox surfaces as expired (warning), not unavailable (error)", () => {
    const archived = {
      status: "archived" as const,
      ttlExpiresAt: 10_000,
      remoteId: "remote-1",
      repoPath: "/workspace/repo",
    };

    const result = getSandboxAvailability(archived, 5_000);

    expect(result.available).toBe(false);
    expect(result.reasonCode).toBe("sandbox_expired");
  });

  test("failed sandbox surfaces as unavailable (error)", () => {
    const failed = {
      status: "failed" as const,
      ttlExpiresAt: 10_000,
      remoteId: "remote-1",
      repoPath: "/workspace/repo",
    };

    const result = getSandboxAvailability(failed, 5_000);

    expect(result.available).toBe(false);
    expect(result.reasonCode).toBe("sandbox_unavailable");
  });

  test("ttl-expired ready sandbox surfaces as expired", () => {
    const expired = {
      status: "ready" as const,
      ttlExpiresAt: 1_000,
      remoteId: "remote-1",
      repoPath: "/workspace/repo",
    };

    const result = getSandboxAvailability(expired, 5_000);

    expect(result.available).toBe(false);
    expect(result.reasonCode).toBe("sandbox_expired");
  });

  test("provisioning sandbox is not available even with remote metadata", () => {
    const provisioning = {
      status: "provisioning" as const,
      ttlExpiresAt: 10_000,
      remoteId: "remote-1",
      repoPath: "/workspace/repo",
    };

    const result = getSandboxAvailability(provisioning, 5_000);

    expect(result.available).toBe(false);
    expect(result.reasonCode).toBe("sandbox_provisioning");
  });

  test("stopped sandbox surfaces as expired", () => {
    const stopped = {
      status: "stopped" as const,
      ttlExpiresAt: 10_000,
      remoteId: "remote-1",
      repoPath: "/workspace/repo",
    };

    const result = getSandboxAvailability(stopped, 5_000);

    expect(result.available).toBe(false);
    expect(result.reasonCode).toBe("sandbox_expired");
  });

  test("missing sandbox surfaces as missing_sandbox", () => {
    const result = getSandboxAvailability(null);

    expect(result.available).toBe(false);
    expect(result.reasonCode).toBe("missing_sandbox");
  });
});
