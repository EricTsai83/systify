/// <reference types="vite/client" />

import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import { assertRepositoryModeEligible } from "./repositoryModeEligibility";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function createTestConvex() {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
}

async function insertRepository(
  t: ReturnType<typeof createTestConvex>,
  ownerTokenIdentifier: string,
  slug: string,
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("repositories", {
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
      fileCount: 1,
      color: "blue",
      lastAccessedAt: Date.now(),
    });
  });
}

async function seedArtifact(
  t: ReturnType<typeof createTestConvex>,
  ownerTokenIdentifier: string,
  repositoryId: Awaited<ReturnType<typeof insertRepository>>,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("artifacts", {
      repositoryId,
      ownerTokenIdentifier,
      kind: "architecture_overview",
      title: "Architecture overview",
      summary: "Module boundaries",
      contentMarkdown: "## Modules",
      source: "heuristic",
      version: 1,
    });
  });
}

describe("evaluate (read path)", () => {
  test("no repositoryId arg: library/grounding all disabled with no_repository_attached", async () => {
    const ownerTokenIdentifier = "user|eval-no-repo";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const verdict = await viewer.query(api.repositoryModeEligibility.evaluate, {});
    expect(verdict).not.toBeNull();
    expect(verdict?.hasAttachedRepo).toBe(false);
    expect(verdict?.hasAtLeastOneArtifact).toBe(false);
    expect(verdict?.modes.discuss.enabled).toBe(true);
    expect(verdict?.modes.library.enabled).toBe(false);
    expect(verdict?.modes.library).toHaveProperty("code", "no_repository_attached");
    expect(verdict?.grounding.library.enabled).toBe(false);
    expect(verdict?.grounding.library).toHaveProperty("code", "no_repository_attached");
    expect(verdict?.grounding.sandbox.enabled).toBe(false);
    expect(verdict?.grounding.sandbox).toHaveProperty("code", "no_repository_attached");
    expect(verdict?.askReadiness.enabled).toBe(false);
    expect(verdict?.askReadiness).toHaveProperty("code", "no_repository_attached");
    expect(verdict?.defaultMode).toBe("discuss");
  });

  test("repo with no artifacts: askReadiness + library grounding closed with library_no_artifact", async () => {
    const ownerTokenIdentifier = "user|eval-no-artifact";
    const t = createTestConvex();
    const repositoryId = await insertRepository(t, ownerTokenIdentifier, "no-artifact");
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const verdict = await viewer.query(api.repositoryModeEligibility.evaluate, { repositoryId });
    expect(verdict?.hasAttachedRepo).toBe(true);
    expect(verdict?.hasAtLeastOneArtifact).toBe(false);
    expect(verdict?.modes.library.enabled).toBe(true);
    expect(verdict?.askReadiness.enabled).toBe(false);
    expect(verdict?.askReadiness).toHaveProperty("code", "library_no_artifact");
    expect(verdict?.grounding.library.enabled).toBe(false);
    expect(verdict?.grounding.library).toHaveProperty("code", "library_no_artifact");
    // No sandbox provisioned — the sandbox axis still closes with the
    // missing-sandbox reason rather than something cap-related.
    expect(verdict?.grounding.sandbox.enabled).toBe(false);
    expect(verdict?.grounding.sandbox).toHaveProperty("code", "sandbox_missing");
  });

  test("repo with at least one artifact: askReadiness + library grounding open", async () => {
    const ownerTokenIdentifier = "user|eval-with-artifact";
    const t = createTestConvex();
    const repositoryId = await insertRepository(t, ownerTokenIdentifier, "with-artifact");
    await seedArtifact(t, ownerTokenIdentifier, repositoryId);
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const verdict = await viewer.query(api.repositoryModeEligibility.evaluate, { repositoryId });
    expect(verdict?.hasAtLeastOneArtifact).toBe(true);
    expect(verdict?.askReadiness.enabled).toBe(true);
    expect(verdict?.grounding.library.enabled).toBe(true);
    expect(verdict?.defaultMode).toBe("library");
  });

  test("repository the viewer doesn't own returns null (instead of leaking a verdict)", async () => {
    const ownerTokenIdentifier = "user|eval-owner";
    const intruderTokenIdentifier = "user|eval-intruder";
    const t = createTestConvex();
    const repositoryId = await insertRepository(t, ownerTokenIdentifier, "owned");
    const intruder = t.withIdentity({ tokenIdentifier: intruderTokenIdentifier });

    const verdict = await intruder.query(api.repositoryModeEligibility.evaluate, { repositoryId });
    expect(verdict).toBeNull();
  });

  test("sandbox user-cap exceeded closes the sandbox grounding axis with sandbox_user_cap_exceeded", async () => {
    const ownerTokenIdentifier = "user|eval-sandbox-user-cap";
    const t = createTestConvex();
    const repositoryId = await insertRepository(t, ownerTokenIdentifier, "user-cap");
    await seedArtifact(t, ownerTokenIdentifier, repositoryId);

    // Drain the user bucket close to zero. Default per-user cap is $5
    // (500 cents); default estimate is 10 cents. Recording 495 cents
    // leaves 5 cents remaining — below the estimate, so the cost-cap
    // gate closes with the user-scoped code (user-cap precedence beats
    // repository-cap when both could close).
    await t.run(async (ctx) => {
      const { consumeSandboxDailyCost } = await import("./lib/rateLimit");
      await consumeSandboxDailyCost(ctx, {
        ownerTokenIdentifier,
        repositoryId,
        cents: 495,
      });
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const verdict = await viewer.query(api.repositoryModeEligibility.evaluate, { repositoryId });
    expect(verdict?.grounding.sandbox.enabled).toBe(false);
    const sandbox = verdict?.grounding.sandbox;
    if (sandbox && !sandbox.enabled) {
      expect(sandbox.code).toBe("sandbox_user_cap_exceeded");
    }
  });

  test("sandbox repository-cap exceeded (with user-cap headroom) reports sandbox_repository_cap_exceeded", async () => {
    const ownerTokenIdentifier = "user|eval-sandbox-repo-cap";
    const previousUserCap = process.env.SANDBOX_DAILY_CAP_PER_USER_USD;
    const previousRepoCap = process.env.SANDBOX_DAILY_CAP_PER_REPOSITORY_USD;
    // Raise the user cap so the repository cap is the binding constraint.
    // Lower the repository cap so a small consume drains it.
    process.env.SANDBOX_DAILY_CAP_PER_USER_USD = "1000";
    process.env.SANDBOX_DAILY_CAP_PER_REPOSITORY_USD = "5";
    try {
      const t = createTestConvex();
      const repositoryId = await insertRepository(t, ownerTokenIdentifier, "repo-cap");
      await seedArtifact(t, ownerTokenIdentifier, repositoryId);

      // Repo cap = $5 (500 cents); drain to 5 cents remaining so the
      // 10-cent estimate trips the repo gate while leaving the user
      // bucket comfortably above its $1000 ceiling.
      await t.run(async (ctx) => {
        const { consumeSandboxDailyCost } = await import("./lib/rateLimit");
        await consumeSandboxDailyCost(ctx, {
          ownerTokenIdentifier,
          repositoryId,
          cents: 495,
        });
      });

      const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
      const verdict = await viewer.query(api.repositoryModeEligibility.evaluate, { repositoryId });
      expect(verdict?.grounding.sandbox.enabled).toBe(false);
      const sandbox = verdict?.grounding.sandbox;
      if (sandbox && !sandbox.enabled) {
        expect(sandbox.code).toBe("sandbox_repository_cap_exceeded");
      }
    } finally {
      if (previousUserCap === undefined) delete process.env.SANDBOX_DAILY_CAP_PER_USER_USD;
      else process.env.SANDBOX_DAILY_CAP_PER_USER_USD = previousUserCap;
      if (previousRepoCap === undefined) delete process.env.SANDBOX_DAILY_CAP_PER_REPOSITORY_USD;
      else process.env.SANDBOX_DAILY_CAP_PER_REPOSITORY_USD = previousRepoCap;
    }
  });
});

describe("assertRepositoryModeEligible (write path)", () => {
  test("discuss + groundLibrary=true with no repo throws no_repository_attached", async () => {
    const ownerTokenIdentifier = "user|assert-no-repo";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    await expect(
      viewer.run(async (ctx) => {
        await assertRepositoryModeEligible(ctx, {
          repositoryId: null,
          mode: "discuss",
          groundLibrary: true,
        });
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("library mode with no repo throws no_repository_attached", async () => {
    const ownerTokenIdentifier = "user|assert-library-no-repo";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    await expect(
      viewer.run(async (ctx) => {
        await assertRepositoryModeEligible(ctx, {
          repositoryId: null,
          mode: "library",
        });
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("library mode against a repo with no artifacts throws library_no_artifact", async () => {
    const ownerTokenIdentifier = "user|assert-library-no-artifact";
    const t = createTestConvex();
    const repositoryId = await insertRepository(t, ownerTokenIdentifier, "no-artifact-assert");
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    await expect(
      viewer.run(async (ctx) => {
        await assertRepositoryModeEligible(ctx, {
          repositoryId,
          mode: "library",
        });
      }),
    ).rejects.toThrow(/library_no_artifact/);
  });

  test("discuss with no grounding flags doesn't require a repo and doesn't throw", async () => {
    const ownerTokenIdentifier = "user|assert-discuss-clean";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    await expect(
      viewer.run(async (ctx) => {
        await assertRepositoryModeEligible(ctx, {
          repositoryId: null,
          mode: "discuss",
        });
      }),
    ).resolves.not.toThrow();
  });

  test("library mode against a repo with at least one artifact does not throw", async () => {
    const ownerTokenIdentifier = "user|assert-library-happy";
    const t = createTestConvex();
    const repositoryId = await insertRepository(t, ownerTokenIdentifier, "happy");
    await seedArtifact(t, ownerTokenIdentifier, repositoryId);
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    await expect(
      viewer.run(async (ctx) => {
        await assertRepositoryModeEligible(ctx, {
          repositoryId,
          mode: "library",
        });
      }),
    ).resolves.not.toThrow();
  });

  test("a repositoryId the viewer doesn't own throws RepositoryNotFound (not the disabled-reason code)", async () => {
    const ownerTokenIdentifier = "user|assert-owner";
    const intruderTokenIdentifier = "user|assert-intruder";
    const t = createTestConvex();
    const repositoryId = await insertRepository(t, ownerTokenIdentifier, "private-asserts");
    const intruder = t.withIdentity({ tokenIdentifier: intruderTokenIdentifier });

    await expect(
      intruder.run(async (ctx) => {
        await assertRepositoryModeEligible(ctx, {
          repositoryId,
          mode: "library",
        });
      }),
    ).rejects.toThrow(/RepositoryNotFound/);
  });
});
