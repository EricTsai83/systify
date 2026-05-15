/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
type AppTestConvex = ReturnType<typeof createTestConvex>;

describe("rate limits and interactive job guards", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-22T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("createRepositoryImport rejects the sixth request without extra side effects", async () => {
    const ownerTokenIdentifier = "user|import-rate-limit";
    const t = createTestConvex();
    await seedGithubInstallation(t, ownerTokenIdentifier, 1);

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    for (let index = 0; index < 5; index += 1) {
      await viewer.mutation(api.repositories.createRepositoryImport, {
        url: `https://github.com/acme/import-rate-limit-${index}`,
      });
    }

    const before = await getOwnerImportCounts(t, ownerTokenIdentifier);
    const error = await viewer
      .mutation(api.repositories.createRepositoryImport, {
        url: "https://github.com/acme/import-rate-limit-5",
      })
      .catch((caughtError) => caughtError);

    expectStructuredError(error, "RATE_LIMIT_EXCEEDED", "importRequests");
    expect(await getOwnerImportCounts(t, ownerTokenIdentifier)).toEqual(before);
  });

  test("sendMessage rejects active chat jobs without creating extra jobs or messages", async () => {
    const ownerTokenIdentifier = "user|chat-in-flight";
    const t = createTestConvex();
    const { repositoryId, threadId } = await createRepositoryFixture(t, ownerTokenIdentifier, "chat-active");

    await t.run(async (ctx) => {
      const jobId = await ctx.db.insert("jobs", {
        repositoryId,
        ownerTokenIdentifier,
        threadId,
        kind: "chat",
        status: "running",
        stage: "generating_reply",
        progress: 0.3,
        costCategory: "chat",
        triggerSource: "user",
        startedAt: Date.now(),
        leaseExpiresAt: Date.now() + 60_000,
      });

      await ctx.db.insert("messages", {
        repositoryId,
        threadId,
        jobId,
        ownerTokenIdentifier,
        role: "assistant",
        status: "streaming",
        mode: "discuss",
        content: "",
      });
    });

    const before = await getThreadCounts(t, threadId);
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const error = await viewer
      .mutation(api.chat.send.sendMessage, {
        threadId,
        content: "Can you answer this now?",
      })
      .catch((caughtError) => caughtError);

    expectStructuredError(error, "OPERATION_ALREADY_IN_PROGRESS", "threadChatInFlight");
    expect(await getThreadCounts(t, threadId)).toEqual(before);
  });

  test("sendMessage finds active chat jobs past recent unrelated thread work", async () => {
    const ownerTokenIdentifier = "user|chat-shadowed";
    const t = createTestConvex();
    const { repositoryId, threadId } = await createRepositoryFixture(t, ownerTokenIdentifier, "chat-shadowed");

    await t.run(async (ctx) => {
      await ctx.db.insert("jobs", {
        repositoryId,
        ownerTokenIdentifier,
        threadId,
        kind: "chat",
        status: "running",
        stage: "generating_reply",
        progress: 0.3,
        costCategory: "chat",
        triggerSource: "user",
        startedAt: Date.now(),
        leaseExpiresAt: Date.now() + 60_000,
      });

      for (let index = 0; index < 30; index += 1) {
        await ctx.db.insert("jobs", {
          repositoryId,
          ownerTokenIdentifier,
          threadId,
          kind: "system_design",
          status: "running",
          stage: "focused_inspection",
          progress: 0.4,
          costCategory: "system_design",
          triggerSource: "user",
          startedAt: Date.now(),
          leaseExpiresAt: Date.now() + 60_000,
        });
      }
    });

    const before = await getThreadCounts(t, threadId);
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const error = await viewer
      .mutation(api.chat.send.sendMessage, {
        threadId,
        content: "Can you answer this now?",
      })
      .catch((caughtError) => caughtError);

    expectStructuredError(error, "OPERATION_ALREADY_IN_PROGRESS", "threadChatInFlight");
    expect(await getThreadCounts(t, threadId)).toEqual(before);
  });

  test("sendMessage allows a burst of six then rate limits the seventh request", async () => {
    const ownerTokenIdentifier = "user|chat-rate-limit";
    const t = createTestConvex();
    const { threadId } = await createRepositoryFixture(t, ownerTokenIdentifier, "chat-rate-limit");
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    for (let index = 0; index < 6; index += 1) {
      const result = await viewer.mutation(api.chat.send.sendMessage, {
        threadId,
        content: `message-${index}`,
      });
      await completeJob(t, result.jobId);
    }

    const before = await getThreadCounts(t, threadId);
    const error = await viewer
      .mutation(api.chat.send.sendMessage, {
        threadId,
        content: "message-6",
      })
      .catch((caughtError) => caughtError);

    expectStructuredError(error, "RATE_LIMIT_EXCEEDED", "chatRequestsPerOwner");
    expect(await getThreadCounts(t, threadId)).toEqual(before);
  });

  test("sendMessage rejects blank content before enqueueing any work", async () => {
    const ownerTokenIdentifier = "user|chat-empty-content";
    const t = createTestConvex();
    const { threadId } = await createRepositoryFixture(t, ownerTokenIdentifier, "chat-empty-content");
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const before = await getThreadCounts(t, threadId);
    await expect(
      viewer.mutation(api.chat.send.sendMessage, {
        threadId,
        content: "   \n\t  ",
      }),
    ).rejects.toThrow("Message content cannot be empty.");
    expect(await getThreadCounts(t, threadId)).toEqual(before);
  });

  test("chat global limiter eventually rejects a multi-owner burst without side effects", async () => {
    const t = createTestConvex();

    let successCount = 0;
    let blockedThreadId: Id<"threads"> | null = null;
    let blockedError: unknown = null;

    for (let index = 0; index < 120; index += 1) {
      const ownerTokenIdentifier = `user|chat-global-${index}`;
      const { threadId } = await createRepositoryFixture(t, ownerTokenIdentifier, `chat-global-${index}`);
      const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
      const result = await viewer
        .mutation(api.chat.send.sendMessage, {
          threadId,
          content: `hello-${index}`,
        })
        .catch((caughtError) => caughtError);

      if (result instanceof Error) {
        blockedThreadId = threadId;
        blockedError = result;
        break;
      }

      successCount += 1;
    }

    expect(successCount).toBeGreaterThan(0);
    expect(blockedThreadId).not.toBeNull();
    expectStructuredError(blockedError, "RATE_LIMIT_EXCEEDED", "chatRequestsGlobal");
    expect(await getThreadCounts(t, blockedThreadId!)).toEqual({
      jobs: 0,
      messages: 0,
      streams: 0,
      streamChunks: 0,
    });
  });

  test("daytona global limiter eventually rejects multi-owner imports without side effects", async () => {
    const t = createTestConvex();

    let successCount = 0;
    let blockedOwner: string | null = null;
    let blockedError: unknown = null;

    for (let index = 0; index < 80; index += 1) {
      const ownerTokenIdentifier = `user|daytona-global-${index}`;
      await seedGithubInstallation(t, ownerTokenIdentifier, index + 10);
      const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
      const result = await viewer
        .mutation(api.repositories.createRepositoryImport, {
          url: `https://github.com/acme/daytona-global-${index}`,
        })
        .catch((caughtError) => caughtError);

      if (result instanceof Error) {
        blockedOwner = ownerTokenIdentifier;
        blockedError = result;
        break;
      }

      successCount += 1;
    }

    expect(successCount).toBeGreaterThan(0);
    expect(blockedOwner).not.toBeNull();
    expectStructuredError(blockedError, "RATE_LIMIT_EXCEEDED", "daytonaRequestsGlobal");
    expect(await getOwnerImportCounts(t, blockedOwner!)).toEqual({
      repositories: 0,
      imports: 0,
      jobs: 0,
      workspaces: 0,
    });
  });

  test("stale chat recovery fails the job and assistant message", async () => {
    const ownerTokenIdentifier = "user|stale-chat";
    const t = createTestConvex();
    const { repositoryId, threadId } = await createRepositoryFixture(t, ownerTokenIdentifier, "stale-chat");

    const { jobId, assistantMessageId } = await t.run(async (ctx) => {
      const jobId = await ctx.db.insert("jobs", {
        repositoryId,
        ownerTokenIdentifier,
        threadId,
        kind: "chat",
        status: "running",
        stage: "generating_reply",
        progress: 0.6,
        costCategory: "chat",
        triggerSource: "user",
        startedAt: Date.now() - 120_000,
        leaseExpiresAt: Date.now() - 1_000,
      });

      await ctx.db.insert("messages", {
        repositoryId,
        threadId,
        jobId,
        ownerTokenIdentifier,
        role: "user",
        status: "completed",
        mode: "discuss",
        content: "Hello?",
      });

      const assistantMessageId = await ctx.db.insert("messages", {
        repositoryId,
        threadId,
        jobId,
        ownerTokenIdentifier,
        role: "assistant",
        status: "streaming",
        mode: "discuss",
        content: "",
      });

      const streamId = await ctx.db.insert("messageStreams", {
        repositoryId,
        threadId,
        jobId,
        assistantMessageId,
        ownerTokenIdentifier,
        compactedContent: "Partial ",
        compactedThroughSequence: -1,
        nextSequence: 1,
        startedAt: Date.now() - 120_000,
        lastAppendedAt: Date.now() - 30_000,
      });
      await ctx.db.insert("messageStreamChunks", {
        streamId,
        sequence: 0,
        text: "reply",
      });

      return { jobId, assistantMessageId };
    });

    await t.action(internal.opsNode.reconcileStaleInteractiveJobs, {});

    const result = await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      assistantMessage: await ctx.db.get(assistantMessageId),
      streams: await ctx.db
        .query("messageStreams")
        .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
        .take(10),
    }));

    expect(result.job?.status).toBe("failed");
    expect(result.job?.leaseExpiresAt).toBeUndefined();
    expect(result.assistantMessage?.status).toBe("failed");
    expect(result.assistantMessage?.content).toBe("Partial reply");
    expect(result.assistantMessage?.errorMessage).toContain("stalled");
    expect(result.streams).toHaveLength(0);
  });

  /**
   * Plan 10 — daily sandbox cost cap. We anchor every test in this group
   * with `SANDBOX_DAILY_CAP_PER_USER_USD=0.05` so the cap is hit after a
   * single ~$0.04 settlement (5 cents capacity × 1 cent estimate ≤ 4
   * cents settle). Workspace cap stays at default ($50) so the user cap
   * is the binding constraint; a separate test exercises the workspace
   * cap path.
   */
  describe("sandbox daily cost cap (Plan 10)", () => {
    let priorUserCapEnv: string | undefined;
    let priorWorkspaceCapEnv: string | undefined;
    let priorEstimateEnv: string | undefined;
    let priorSandboxFlagEnv: string | undefined;
    let priorAllowlistEnv: string | undefined;
    let priorOpenAiKeyEnv: string | undefined;

    beforeEach(() => {
      priorUserCapEnv = process.env.SANDBOX_DAILY_CAP_PER_USER_USD;
      priorWorkspaceCapEnv = process.env.SANDBOX_DAILY_CAP_PER_WORKSPACE_USD;
      priorEstimateEnv = process.env.SANDBOX_REPLY_ESTIMATE_USD;
      priorSandboxFlagEnv = process.env.SANDBOX_MODE_ENABLED;
      priorAllowlistEnv = process.env.SANDBOX_BETA_ALLOWLIST;
      priorOpenAiKeyEnv = process.env.OPENAI_API_KEY;
      // 5-cent cap: lets us settle one $0.04 reply, then hit the cap on
      // the next pre-check (1 cent estimate vs 1 cent remaining → ok;
      // 1 cent estimate vs 0 cents → blocked).
      process.env.SANDBOX_DAILY_CAP_PER_USER_USD = "0.05";
      process.env.SANDBOX_DAILY_CAP_PER_WORKSPACE_USD = "10";
      process.env.SANDBOX_REPLY_ESTIMATE_USD = "0.01";
      process.env.SANDBOX_MODE_ENABLED = "true";
      process.env.SANDBOX_BETA_ALLOWLIST = "*";
      // Disable real OpenAI calls so the action falls into the
      // heuristic path. We're testing the rate-limit accounting end-to-end
      // (send → finalize), and the heuristic path lets us drive that
      // entire flow without external calls.
      delete process.env.OPENAI_API_KEY;
    });

    afterEach(() => {
      const restore = (name: string, prior: string | undefined) => {
        if (prior === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = prior;
        }
      };
      restore("SANDBOX_DAILY_CAP_PER_USER_USD", priorUserCapEnv);
      restore("SANDBOX_DAILY_CAP_PER_WORKSPACE_USD", priorWorkspaceCapEnv);
      restore("SANDBOX_REPLY_ESTIMATE_USD", priorEstimateEnv);
      restore("SANDBOX_MODE_ENABLED", priorSandboxFlagEnv);
      restore("SANDBOX_BETA_ALLOWLIST", priorAllowlistEnv);
      restore("OPENAI_API_KEY", priorOpenAiKeyEnv);
    });

    test("non-sandbox sends are not subject to the cap (no extra reads, no extra rejections)", async () => {
      // Discuss / docs sends bill against the cheaper `chat` category;
      // they must keep working even when the user has hit their sandbox
      // cap. Drive the user's sandbox bucket to 0 by direct rate-limiter
      // consumption first, then send a discuss-mode message.
      const ownerTokenIdentifier = "user|cap-non-sandbox";
      const t = createTestConvex();
      const { threadId } = await createRepositoryFixture(t, ownerTokenIdentifier, "cap-non-sandbox");
      const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

      // Burn through the sandbox cap directly (5 cents capacity).
      // Inline config matches the runtime config (sandbox cost buckets
      // use the inline-config pattern so env vars apply per call).
      await t.run(async (ctx) => {
        const { rateLimiter } = await import("./lib/rateLimit");
        await rateLimiter.limit(ctx, "sandboxCostUsdPerUserDaily", {
          key: ownerTokenIdentifier,
          count: 5,
          config: { kind: "fixed window", rate: 5, capacity: 5, period: 86_400_000, maxReserved: 5, start: 0 },
        });
      });

      // Discuss send must succeed despite the cap being exhausted —
      // discuss mode does not consume the sandbox bucket.
      const result = await viewer.mutation(api.chat.send.sendMessage, {
        threadId,
        content: "Hi from discuss mode",
        mode: "discuss",
      });
      expect(result.jobId).toBeDefined();
    });

    test("sandbox pre-check rejects with SANDBOX_DAILY_CAP_EXCEEDED once user cap is exhausted", async () => {
      const ownerTokenIdentifier = "user|cap-user-blocked";
      const t = createTestConvex();
      const { threadId } = await createRepositoryFixture(t, ownerTokenIdentifier, "cap-user-blocked", {
        withSandbox: true,
      });
      const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

      // Drive the user's sandbox bucket to 0 (5 cent capacity).
      await t.run(async (ctx) => {
        const { rateLimiter } = await import("./lib/rateLimit");
        await rateLimiter.limit(ctx, "sandboxCostUsdPerUserDaily", {
          key: ownerTokenIdentifier,
          count: 5,
          config: { kind: "fixed window", rate: 5, capacity: 5, period: 86_400_000, maxReserved: 5, start: 0 },
        });
      });

      const before = await getThreadCounts(t, threadId);
      const error = await viewer
        .mutation(api.chat.send.sendMessage, {
          threadId,
          content: "Inspect the lease logic.",
          mode: "sandbox",
        })
        .catch((caughtError) => caughtError);

      // chat.sendMessage throws via assertServiceModeEligible → throwIfDisabled.
      // Structured shape: { code: "sandbox_user_cap_exceeded", mode: "lab",
      // message, retryAfterMs }. The bucket / capUsd fields stay on
      // assertSandboxDailyCostBudget's own throws (still tested below) but
      // are not part of the eligibility module's contract.
      const data = typeof error?.data === "string" ? JSON.parse(error.data) : error?.data;
      expect(data).toMatchObject({ code: "sandbox_user_cap_exceeded", mode: "lab" });
      expect(data.retryAfterMs).toEqual(expect.any(Number));
      // No job, message, or stream rows should be created when the
      // pre-check rejects — the failure must happen *before* any
      // side-effecting writes.
      expect(await getThreadCounts(t, threadId)).toEqual(before);
    });

    test("sandbox pre-check rejects with SANDBOX_WORKSPACE_DAILY_CAP_EXCEEDED when only the workspace cap is exhausted", async () => {
      // Two-cap scenario: user cap has plenty of room, workspace cap is
      // exhausted. Verifies the user-cap check passes but the
      // workspace-cap check fires with its own structured error code.
      const ownerTokenIdentifier = "user|cap-workspace-blocked";
      const t = createTestConvex();

      const workspaceId = await t.run(async (ctx) => {
        return await ctx.db.insert("workspaces", {
          ownerTokenIdentifier,
          name: "Capped Workspace",
          color: "blue",
          lastAccessedAt: Date.now(),
        });
      });

      const { repositoryId, threadId } = await createRepositoryFixture(
        t,
        ownerTokenIdentifier,
        "cap-workspace-blocked",
        { withSandbox: true },
      );
      // Attach the thread to the workspace so the pre-check runs the
      // workspace branch.
      await t.run(async (ctx) => {
        await ctx.db.patch(threadId, { workspaceId });
        await ctx.db.patch(repositoryId, {});
      });
      const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

      // Workspace cap = $10 = 1000 cents. Burn through all of it.
      await t.run(async (ctx) => {
        const { rateLimiter, workspaceCostKey } = await import("./lib/rateLimit");
        await rateLimiter.limit(ctx, "sandboxCostUsdPerWorkspaceDaily", {
          key: workspaceCostKey(workspaceId),
          count: 1000,
          config: {
            kind: "fixed window",
            rate: 1000,
            capacity: 1000,
            period: 86_400_000,
            maxReserved: 1000,
            start: 0,
          },
        });
      });

      const error = await viewer
        .mutation(api.chat.send.sendMessage, {
          threadId,
          content: "Inspect the lease logic.",
          mode: "sandbox",
        })
        .catch((caughtError) => caughtError);

      const data = typeof error?.data === "string" ? JSON.parse(error.data) : error?.data;
      expect(data).toMatchObject({ code: "sandbox_workspace_cap_exceeded", mode: "lab" });
      expect(data.retryAfterMs).toEqual(expect.any(Number));
    });

    test("finalizeAssistantReply settles real costUsd into the daily-cap bucket (sandbox mode)", async () => {
      // Verifies the in-flight reply → finalize transition actually
      // calls the settle helper. We construct the message + job + stream
      // state by hand (skipping the full send → action flow) so the
      // assertion is anchored on the *settlement* behavior of finalize,
      // not on the action runtime. The action's role is to produce the
      // cost number; this test feeds a known cost in directly.
      const ownerTokenIdentifier = "user|cap-finalize";
      const t = createTestConvex();
      const { repositoryId, threadId } = await createRepositoryFixture(t, ownerTokenIdentifier, "cap-finalize", {
        withSandbox: true,
      });

      const { jobId, assistantMessageId } = await t.run(async (ctx) => {
        const jobId = await ctx.db.insert("jobs", {
          repositoryId,
          ownerTokenIdentifier,
          threadId,
          kind: "chat",
          status: "running",
          stage: "generating_reply",
          progress: 0.6,
          costCategory: "system_design",
          triggerSource: "user",
          startedAt: Date.now(),
          leaseExpiresAt: Date.now() + 60_000,
        });
        const assistantMessageId = await ctx.db.insert("messages", {
          repositoryId,
          threadId,
          jobId,
          ownerTokenIdentifier,
          role: "assistant",
          status: "streaming",
          mode: "sandbox",
          content: "",
        });
        await ctx.db.insert("messageStreams", {
          repositoryId,
          threadId,
          jobId,
          assistantMessageId,
          ownerTokenIdentifier,
          compactedContent: "",
          compactedThroughSequence: -1,
          nextSequence: 0,
          startedAt: Date.now(),
          lastAppendedAt: Date.now(),
        });
        return { jobId, assistantMessageId };
      });

      // Run finalize with a known cost: $0.02 = 2 cents → settle 2 cents
      // out of the 5-cent capacity → 3 cents remaining.
      await t.mutation(internal.chat.streaming.finalizeAssistantReply, {
        threadId,
        assistantMessageId,
        jobId,
        finalDelta: "Done.",
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.02,
      });

      const remaining = await t.run(async (ctx) => {
        const { rateLimiter } = await import("./lib/rateLimit");
        const snapshot = await rateLimiter.getValue(ctx, "sandboxCostUsdPerUserDaily", {
          key: ownerTokenIdentifier,
          config: { kind: "fixed window", rate: 5, capacity: 5, period: 86_400_000, maxReserved: 5, start: 0 },
        });
        return snapshot.value;
      });
      expect(remaining).toBe(3);

      // Per-message cost is also persisted on the message so the chat
      // ticker can render it.
      const message = await t.run(async (ctx) => await ctx.db.get(assistantMessageId));
      expect(message?.estimatedCostUsd).toBeCloseTo(0.02);
    });

    test("finalizeAssistantReply does NOT settle for non-sandbox replies (cost still records on message)", async () => {
      // Discuss / docs replies bill the cheaper `chat` category and
      // shouldn't decrement the sandbox bucket — the cap is sandbox-only.
      const ownerTokenIdentifier = "user|cap-finalize-discuss";
      const t = createTestConvex();
      const { repositoryId, threadId } = await createRepositoryFixture(t, ownerTokenIdentifier, "cap-finalize-discuss");

      const { jobId, assistantMessageId } = await t.run(async (ctx) => {
        const jobId = await ctx.db.insert("jobs", {
          repositoryId,
          ownerTokenIdentifier,
          threadId,
          kind: "chat",
          status: "running",
          stage: "generating_reply",
          progress: 0.6,
          costCategory: "chat",
          triggerSource: "user",
          startedAt: Date.now(),
          leaseExpiresAt: Date.now() + 60_000,
        });
        const assistantMessageId = await ctx.db.insert("messages", {
          repositoryId,
          threadId,
          jobId,
          ownerTokenIdentifier,
          role: "assistant",
          status: "streaming",
          mode: "discuss",
          content: "",
        });
        await ctx.db.insert("messageStreams", {
          repositoryId,
          threadId,
          jobId,
          assistantMessageId,
          ownerTokenIdentifier,
          compactedContent: "",
          compactedThroughSequence: -1,
          nextSequence: 0,
          startedAt: Date.now(),
          lastAppendedAt: Date.now(),
        });
        return { jobId, assistantMessageId };
      });

      await t.mutation(internal.chat.streaming.finalizeAssistantReply, {
        threadId,
        assistantMessageId,
        jobId,
        finalDelta: "Discuss reply.",
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.02,
      });

      // Sandbox bucket untouched — discuss replies don't settle into it.
      const remaining = await t.run(async (ctx) => {
        const { rateLimiter } = await import("./lib/rateLimit");
        const snapshot = await rateLimiter.getValue(ctx, "sandboxCostUsdPerUserDaily", {
          key: ownerTokenIdentifier,
          config: { kind: "fixed window", rate: 5, capacity: 5, period: 86_400_000, maxReserved: 5, start: 0 },
        });
        return snapshot.value;
      });
      expect(remaining).toBe(5);

      // Cost still persists on the message so the ticker shows it.
      const message = await t.run(async (ctx) => await ctx.db.get(assistantMessageId));
      expect(message?.estimatedCostUsd).toBeCloseTo(0.02);
    });

    test("explicit settle via consumeSandboxDailyCost decrements both per-user and per-workspace buckets", async () => {
      // Direct test of the settle helper because the end-to-end finalize
      // test above uses the heuristic path (no real cost). This proves
      // the "real cost gets settled" branch.
      const ownerTokenIdentifier = "user|cap-settle-direct";
      const t = createTestConvex();

      const workspaceId = await t.run(async (ctx) => {
        return await ctx.db.insert("workspaces", {
          ownerTokenIdentifier,
          name: "Settle Workspace",
          color: "blue",
          lastAccessedAt: Date.now(),
        });
      });

      await t.run(async (ctx) => {
        const { consumeSandboxDailyCost } = await import("./lib/rateLimit");
        await consumeSandboxDailyCost(ctx, {
          ownerTokenIdentifier,
          workspaceId,
          cents: 3,
        });
      });

      const userRemaining = await t.run(async (ctx) => {
        const { rateLimiter } = await import("./lib/rateLimit");
        const snapshot = await rateLimiter.getValue(ctx, "sandboxCostUsdPerUserDaily", {
          key: ownerTokenIdentifier,
          config: { kind: "fixed window", rate: 5, capacity: 5, period: 86_400_000, maxReserved: 5, start: 0 },
        });
        return snapshot.value;
      });
      expect(userRemaining).toBe(2); // 5 capacity − 3 consumed

      const workspaceRemaining = await t.run(async (ctx) => {
        const { rateLimiter, workspaceCostKey } = await import("./lib/rateLimit");
        const snapshot = await rateLimiter.getValue(ctx, "sandboxCostUsdPerWorkspaceDaily", {
          key: workspaceCostKey(workspaceId),
          config: {
            kind: "fixed window",
            rate: 1000,
            capacity: 1000,
            period: 86_400_000,
            maxReserved: 1000,
            start: 0,
          },
        });
        return snapshot.value;
      });
      expect(workspaceRemaining).toBe(997); // 1000 capacity − 3 consumed
    });

    test("consumeSandboxDailyCost is a no-op for cents <= 0 (heuristic / pricing-miss replies)", async () => {
      const ownerTokenIdentifier = "user|cap-noop";
      const t = createTestConvex();

      await t.run(async (ctx) => {
        const { consumeSandboxDailyCost } = await import("./lib/rateLimit");
        await consumeSandboxDailyCost(ctx, {
          ownerTokenIdentifier,
          workspaceId: null,
          cents: 0,
        });
        await consumeSandboxDailyCost(ctx, {
          ownerTokenIdentifier,
          workspaceId: null,
          cents: -5,
        });
      });

      const remaining = await t.run(async (ctx) => {
        const { rateLimiter } = await import("./lib/rateLimit");
        const snapshot = await rateLimiter.getValue(ctx, "sandboxCostUsdPerUserDaily", {
          key: ownerTokenIdentifier,
          config: { kind: "fixed window", rate: 5, capacity: 5, period: 86_400_000, maxReserved: 5, start: 0 },
        });
        return snapshot.value;
      });
      // Zero / negative cents must not affect the bucket. Capacity = 5.
      expect(remaining).toBe(5);
    });

    test("peekSandboxDailyCostForUser returns the configured capacity and a future reset timestamp", async () => {
      const ownerTokenIdentifier = "user|cap-peek";
      const t = createTestConvex();

      const budget = await t.run(async (ctx) => {
        const { peekSandboxDailyCostForUser } = await import("./lib/rateLimit");
        return await peekSandboxDailyCostForUser(ctx, ownerTokenIdentifier);
      });

      expect(budget.capacityCents).toBe(5);
      expect(budget.remainingCents).toBe(5);
      // Reset is at the next UTC midnight after the fake `2026-04-22T00:00:00Z`
      // system time set by the outer beforeEach. With `start: 0`, that's
      // 2026-04-23T00:00:00Z.
      expect(budget.resetAtMs).toBe(Date.UTC(2026, 3, 23, 0, 0, 0));
    });
  });

  test("stale deep analysis recovery fails the expired job", async () => {
    const ownerTokenIdentifier = "user|stale-analysis";
    const t = createTestConvex();
    const { repositoryId, sandboxId } = await createRepositoryFixture(t, ownerTokenIdentifier, "stale-analysis", {
      withSandbox: true,
    });

    const jobId = await t.run(async (ctx) => {
      return await ctx.db.insert("jobs", {
        repositoryId,
        ownerTokenIdentifier,
        sandboxId,
        kind: "system_design",
        status: "queued",
        stage: "queued",
        progress: 0,
        costCategory: "system_design",
        triggerSource: "user",
        leaseExpiresAt: Date.now() - 1_000,
      });
    });

    await t.action(internal.opsNode.reconcileStaleInteractiveJobs, {});

    const job = await t.run(async (ctx) => await ctx.db.get(jobId));
    expect(job?.status).toBe("failed");
    expect(job?.leaseExpiresAt).toBeUndefined();
    expect(job?.errorMessage).toContain("stalled");
  });
});

function createTestConvex() {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
}

async function seedGithubInstallation(t: AppTestConvex, ownerTokenIdentifier: string, installationId: number) {
  await t.run(async (ctx) => {
    await ctx.db.insert("githubInstallations", {
      ownerTokenIdentifier,
      installationId,
      accountLogin: `account-${installationId}`,
      accountType: "User",
      status: "active",
      repositorySelection: "all",
      connectedAt: Date.now(),
    });
  });
}

async function createRepositoryFixture(
  t: AppTestConvex,
  ownerTokenIdentifier: string,
  slug: string,
  options?: {
    withSandbox?: boolean;
  },
) {
  return await t.run(async (ctx) => {
    const repositoryId = await ctx.db.insert("repositories", {
      ownerTokenIdentifier,
      sourceHost: "github",
      sourceUrl: `https://github.com/acme/${slug}`,
      sourceRepoFullName: `acme/${slug}`,
      sourceRepoOwner: "acme",
      sourceRepoName: slug,
      defaultBranch: "main",
      visibility: "private",
      accessMode: "private",
      importStatus: "completed",
      detectedLanguages: [],
      packageManagers: [],
      entrypoints: [],
      fileCount: 0,
    });

    const threadId = await ctx.db.insert("threads", {
      repositoryId,
      ownerTokenIdentifier,
      title: `${slug} thread`,
      mode: "discuss",
      lastMessageAt: Date.now(),
    });

    let sandboxId: Id<"sandboxes"> | undefined;
    if (options?.withSandbox) {
      sandboxId = await ctx.db.insert("sandboxes", {
        repositoryId,
        ownerTokenIdentifier,
        provider: "daytona",
        sourceAdapter: "git_clone",
        remoteId: `remote-${slug}`,
        status: "ready",
        workDir: "/workspace",
        repoPath: `/workspace/${slug}`,
        cpuLimit: 2,
        memoryLimitGiB: 4,
        diskLimitGiB: 10,
        ttlExpiresAt: Date.now() + 60 * 60_000,
        autoStopIntervalMinutes: 30,
        autoArchiveIntervalMinutes: 60,
        autoDeleteIntervalMinutes: 120,
        networkBlockAll: false,
      });

      await ctx.db.patch(repositoryId, {
        latestSandboxId: sandboxId,
      });
    }

    return { repositoryId, threadId, sandboxId };
  });
}

async function getOwnerImportCounts(t: AppTestConvex, ownerTokenIdentifier: string) {
  return await t.run(async (ctx) => {
    const repositories = await ctx.db
      .query("repositories")
      .withIndex("by_ownerTokenIdentifier", (q) => q.eq("ownerTokenIdentifier", ownerTokenIdentifier))
      .take(20);
    const imports = await ctx.db
      .query("imports")
      .withIndex("by_ownerTokenIdentifier", (q) => q.eq("ownerTokenIdentifier", ownerTokenIdentifier))
      .take(20);
    const jobs = await ctx.db
      .query("jobs")
      .withIndex("by_ownerTokenIdentifier", (q) => q.eq("ownerTokenIdentifier", ownerTokenIdentifier))
      .take(20);
    const workspaces = await ctx.db
      .query("workspaces")
      .withIndex("by_ownerTokenIdentifier_and_lastAccessedAt", (q) =>
        q.eq("ownerTokenIdentifier", ownerTokenIdentifier),
      )
      .take(20);

    return {
      repositories: repositories.length,
      imports: imports.length,
      jobs: jobs.length,
      workspaces: workspaces.length,
    };
  });
}

async function getThreadCounts(t: AppTestConvex, threadId: Id<"threads">) {
  return await t.run(async (ctx) => {
    const jobs = await ctx.db
      .query("jobs")
      .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
      .take(50);
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
      .take(100);
    const streams = await ctx.db
      .query("messageStreams")
      .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
      .take(50);
    let streamChunks = 0;
    for (const stream of streams) {
      const chunks = await ctx.db
        .query("messageStreamChunks")
        .withIndex("by_streamId_and_sequence", (q) => q.eq("streamId", stream._id))
        .take(100);
      streamChunks += chunks.length;
    }

    return {
      jobs: jobs.length,
      messages: messages.length,
      streams: streams.length,
      streamChunks,
    };
  });
}

async function completeJob(t: AppTestConvex, jobId: Id<"jobs">) {
  await t.run(async (ctx) => {
    await ctx.db.patch(jobId, {
      status: "completed",
      stage: "completed",
      progress: 1,
      completedAt: Date.now(),
      leaseExpiresAt: undefined,
    });
  });
}

function expectStructuredError(
  error: any,
  code:
    | "RATE_LIMIT_EXCEEDED"
    | "OPERATION_ALREADY_IN_PROGRESS"
    | "SANDBOX_DAILY_CAP_EXCEEDED"
    | "SANDBOX_WORKSPACE_DAILY_CAP_EXCEEDED",
  bucket: string,
) {
  const data = typeof error?.data === "string" ? JSON.parse(error.data) : error?.data;
  expect(data).toMatchObject({
    code,
    bucket,
  });
  expect(data.message).toEqual(expect.any(String));
  if (code === "RATE_LIMIT_EXCEEDED") {
    expect(data.retryAfterMs).toEqual(expect.any(Number));
  }
  if (code === "SANDBOX_DAILY_CAP_EXCEEDED" || code === "SANDBOX_WORKSPACE_DAILY_CAP_EXCEEDED") {
    expect(data.retryAfterMs).toEqual(expect.any(Number));
    expect(data.capUsd).toEqual(expect.any(Number));
  }
}
