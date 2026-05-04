import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { getMock, MockDaytonaError, MockDaytonaNotFoundError } = vi.hoisted(() => {
  class HoistedMockDaytonaError extends Error {
    constructor(
      message: string,
      readonly statusCode?: number,
    ) {
      super(message);
      this.name = "DaytonaError";
    }
  }

  class HoistedMockDaytonaNotFoundError extends Error {
    constructor(message = "Not found") {
      super(message);
      this.name = "DaytonaNotFoundError";
    }
  }

  return {
    getMock: vi.fn(),
    MockDaytonaError: HoistedMockDaytonaError,
    MockDaytonaNotFoundError: HoistedMockDaytonaNotFoundError,
  };
});

vi.mock("@daytona/sdk", () => ({
  CodeLanguage: {
    TYPESCRIPT: "typescript",
  },
  Daytona: class MockDaytona {
    constructor(_options: unknown) {}

    get(remoteId: string) {
      return getMock(remoteId);
    }
  },
  DaytonaError: MockDaytonaError,
  DaytonaNotFoundError: MockDaytonaNotFoundError,
}));

import { cloneRepositoryInSandbox, getSandboxState, getRemoteSandboxDetails } from "./daytona";

describe("daytona state normalization", () => {
  beforeEach(() => {
    process.env.DAYTONA_API_KEY = "test-api-key";
    getMock.mockReset();
  });

  afterEach(() => {
    delete process.env.DAYTONA_API_KEY;
  });

  test.each([
    ["deleted", "destroyed"],
    ["destroyed", "destroyed"],
    ["failed", "error"],
  ] as const)("normalizes %s when reading sandbox state", async (remoteState, expectedState) => {
    getMock.mockResolvedValue({
      id: "remote-1",
      state: remoteState,
      labels: { app: "systify" },
      refreshData: vi.fn().mockResolvedValue(undefined),
    });

    await expect(getSandboxState("remote-1")).resolves.toBe(expectedState);
  });

  test("returns normalized labels and state from remote sandbox details", async () => {
    getMock.mockResolvedValue({
      id: "remote-2",
      organizationId: "org-1",
      createdAt: "2026-04-24T00:00:00.000Z",
      updatedAt: "2026-04-24T00:00:01.000Z",
      state: "failed",
      labels: { app: "systify" },
      refreshData: vi.fn().mockResolvedValue(undefined),
    });

    await expect(getRemoteSandboxDetails("remote-2")).resolves.toEqual({
      exists: true,
      remoteId: "remote-2",
      organizationId: "org-1",
      createdAt: "2026-04-24T00:00:00.000Z",
      updatedAt: "2026-04-24T00:00:01.000Z",
      labels: { app: "systify" },
      state: "error",
    });
  });
});

/**
 * Plan 05 — Clone-time token scrub.
 *
 * The threat: `sandbox.git.clone(url, ..., username, token)` writes the
 * password into `.git/config` as part of the remote URL
 * (`https://x-access-token:<TOKEN>@github.com/...`), where it sits for the
 * lifetime of the sandbox. Once Plan 08's `run_shell` is enabled, the LLM
 * can read that file and the token enters the durable `messages` table.
 *
 * The fix: immediately after `git.clone` succeeds, run
 * `git remote set-url origin <canonical-url>` to overwrite the remote URL
 * with a credential-free version. These tests pin three properties:
 *   1. The scrub command runs on every clone (auth or no auth — it's
 *      hardening, not feature-gated).
 *   2. The scrub runs *before* the branch / SHA inspection commands, so
 *      a failure in those won't leave a clone with a tokened remote URL.
 *   3. The substituted URL is POSIX-single-quoted so a malicious or
 *      malformed `args.url` cannot break out of the shell command.
 */
describe("cloneRepositoryInSandbox — Plan 05 token scrub", () => {
  const SANDBOX_REMOTE_ID = "sandbox-clone-1";

  /**
   * Build a Daytona sandbox mock that:
   *   - records every `git.clone(...)` and `process.executeCommand(...)`
   *     in the order they are invoked (so tests can assert ordering);
   *   - returns plausible `result` strings from branch / SHA commands
   *     so the function's return value remains assertable.
   */
  function makeSandboxMock() {
    const cloneCalls: unknown[][] = [];
    const executeCalls: { command: string; cwd?: string }[] = [];
    const sandbox = {
      git: {
        clone: vi.fn(async (...args: unknown[]) => {
          cloneCalls.push(args);
        }),
      },
      process: {
        executeCommand: vi.fn(async (command: string, cwd?: string) => {
          executeCalls.push({ command, cwd });
          if (command === "git branch --show-current") {
            return { exitCode: 0, result: "main\n" };
          }
          if (command === "git rev-parse HEAD") {
            return { exitCode: 0, result: "deadbeefcafef00d\n" };
          }
          // The token-scrub command (`git remote set-url origin ...`)
          // is fire-and-forget; an empty result is fine.
          return { exitCode: 0, result: "" };
        }),
      },
    };
    return { sandbox, cloneCalls, executeCalls };
  }

  beforeEach(() => {
    process.env.DAYTONA_API_KEY = "test-api-key";
    getMock.mockReset();
  });

  afterEach(() => {
    delete process.env.DAYTONA_API_KEY;
  });

  test("rewrites the origin URL to the credential-free canonical URL after a tokened clone", async () => {
    const { sandbox, executeCalls } = makeSandboxMock();
    getMock.mockResolvedValue(sandbox);

    const canonicalUrl = "https://github.com/acme/widget.git";
    const fakeInstallationToken = `ghs_${"x".repeat(40)}`;

    const result = await cloneRepositoryInSandbox({
      remoteId: SANDBOX_REMOTE_ID,
      url: canonicalUrl,
      branch: "main",
      token: fakeInstallationToken,
    });

    expect(result).toEqual({ branch: "main", commitSha: "deadbeefcafef00d" });

    // The scrub command runs against the cloned repo's working dir
    // ("repo") with the canonical URL, single-quoted.
    const scrubCall = executeCalls.find((call) =>
      call.command.startsWith("git remote set-url origin"),
    );
    expect(scrubCall).toBeDefined();
    expect(scrubCall?.cwd).toBe("repo");
    expect(scrubCall?.command).toBe(
      `git remote set-url origin '${canonicalUrl}'`,
    );

    // The token must NOT appear in any executed command — that is the
    // whole point of the scrub. A regression that shells out the raw
    // tokened URL would re-introduce the leak.
    for (const call of executeCalls) {
      expect(call.command).not.toContain(fakeInstallationToken);
      expect(call.command).not.toContain("x-access-token");
    }
  });

  test("scrub runs BEFORE branch / SHA inspection so a downstream failure cannot leave a tokened remote URL", async () => {
    const { sandbox, executeCalls } = makeSandboxMock();
    getMock.mockResolvedValue(sandbox);

    await cloneRepositoryInSandbox({
      remoteId: SANDBOX_REMOTE_ID,
      url: "https://github.com/acme/widget.git",
      branch: "main",
      token: `ghs_${"x".repeat(40)}`,
    });

    // Order of `executeCommand` calls is: scrub → branch lookup → sha.
    // Pinning the order matters: if a future refactor moves the scrub
    // *after* the inspection commands, an inspection failure (which
    // throws) would skip the scrub entirely and leave the tokened URL
    // in `.git/config` for the lifetime of the sandbox.
    expect(executeCalls.map((call) => call.command)).toEqual([
      "git remote set-url origin 'https://github.com/acme/widget.git'",
      "git branch --show-current",
      "git rev-parse HEAD",
    ]);
  });

  test("scrub runs unconditionally, even for unauthenticated clones (hardening, not feature-gated)", async () => {
    // For a public-repo clone with no token, the resulting `.git/config`
    // already lacks credentials. The scrub is a no-op in that case
    // (idempotent overwrite), but it still runs — uniform post-clone
    // state simplifies reasoning and prevents a future change to the
    // private-repo path from accidentally skipping the scrub for
    // public clones too.
    const { sandbox, executeCalls } = makeSandboxMock();
    getMock.mockResolvedValue(sandbox);

    await cloneRepositoryInSandbox({
      remoteId: SANDBOX_REMOTE_ID,
      url: "https://github.com/acme/public-widget.git",
      branch: "main",
      // No token field at all.
    });

    const scrubCall = executeCalls.find((call) =>
      call.command.startsWith("git remote set-url origin"),
    );
    expect(scrubCall).toBeDefined();
    expect(scrubCall?.command).toBe(
      `git remote set-url origin 'https://github.com/acme/public-widget.git'`,
    );
  });

  test("POSIX-single-quotes the URL substitution so embedded single quotes cannot break out of the command", async () => {
    // Defense in depth: in practice the import pipeline only ever
    // forwards canonical GitHub URLs (no shell metacharacters), but if
    // a future caller passed a less sanitized URL with an embedded
    // single quote, naive string interpolation
    // (`git remote set-url origin ${args.url}`) would let a crafted URL
    // close the quote and inject a follow-up command. The expected
    // escape pattern is `'` → `'\''` (close, escaped quote, reopen),
    // which is the canonical POSIX shell idiom.
    const { sandbox, executeCalls } = makeSandboxMock();
    getMock.mockResolvedValue(sandbox);

    const adversarialUrl = "https://github.com/acme/oops'.git";
    await cloneRepositoryInSandbox({
      remoteId: SANDBOX_REMOTE_ID,
      url: adversarialUrl,
      branch: "main",
    });

    const scrubCall = executeCalls.find((call) =>
      call.command.startsWith("git remote set-url origin"),
    );
    // The raw `'` is replaced by `'\''`; the surrounding wrap is `'…'`.
    expect(scrubCall?.command).toBe(
      `git remote set-url origin 'https://github.com/acme/oops'\\''.git'`,
    );
  });
});
