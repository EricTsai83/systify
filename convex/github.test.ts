/// <reference types="vite/client" />

import { describe, expect, test, afterEach } from "vitest";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const RETURN_TO_ALLOWLIST_ENV = "ALLOWED_RETURN_TO_ORIGINS";
const originalGitHubAppSlug = process.env.GITHUB_APP_SLUG;
const originalReturnToAllowlist = process.env[RETURN_TO_ALLOWLIST_ENV];

afterEach(() => {
  if (originalGitHubAppSlug === undefined) {
    delete process.env.GITHUB_APP_SLUG;
  } else {
    process.env.GITHUB_APP_SLUG = originalGitHubAppSlug;
  }

  if (originalReturnToAllowlist === undefined) {
    delete process.env[RETURN_TO_ALLOWLIST_ENV];
  } else {
    process.env[RETURN_TO_ALLOWLIST_ENV] = originalReturnToAllowlist;
  }
});

function createTestConvex() {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
}

function activeInstallation(ownerTokenIdentifier: string, installationId: number) {
  return {
    ownerTokenIdentifier,
    installationId,
    accountLogin: `active-${installationId}`,
    accountType: "User" as const,
    status: "active" as const,
    repositorySelection: "selected" as const,
    connectedAt: Date.now(),
  };
}

function deletedInstallation(ownerTokenIdentifier: string, installationId: number) {
  return {
    ownerTokenIdentifier,
    installationId,
    accountLogin: `deleted-${installationId}`,
    accountType: "User" as const,
    status: "deleted" as const,
    repositorySelection: "selected" as const,
    connectedAt: Date.now() - 10_000,
    deletedAt: Date.now() - 5_000,
  };
}

describe("GitHub installation selection", () => {
  test("saveInstallation updates metadata when reconnecting the same installation", async () => {
    const ownerTokenIdentifier = "user|same-installation";
    const t = createTestConvex();

    await t.run(async (ctx) => {
      await ctx.db.insert("githubInstallations", {
        ownerTokenIdentifier,
        installationId: 501,
        accountLogin: "old-login",
        accountType: "User",
        status: "active",
        repositorySelection: "selected",
        connectedAt: Date.now() - 10_000,
      });
    });

    const result = await t.mutation(internal.github.saveInstallation, {
      ownerTokenIdentifier,
      installationId: 501,
      accountLogin: "new-login",
      accountType: "Organization",
      repositorySelection: "all",
    });

    expect(result).toEqual({
      kind: "connected",
      installationId: 501,
    });

    const installations = await t.run(
      async (ctx) =>
        await ctx.db
          .query("githubInstallations")
          .withIndex("by_ownerTokenIdentifier", (q) => q.eq("ownerTokenIdentifier", ownerTokenIdentifier))
          .take(10),
    );
    expect(installations).toHaveLength(1);
    expect(installations[0]).toMatchObject({
      installationId: 501,
      accountLogin: "new-login",
      accountType: "Organization",
      repositorySelection: "all",
      status: "active",
    });
  });

  test("saveInstallation returns a conflict instead of overwriting a different active installation", async () => {
    const ownerTokenIdentifier = "user|installation-conflict";
    const t = createTestConvex();

    await t.run(async (ctx) => {
      await ctx.db.insert("githubInstallations", activeInstallation(ownerTokenIdentifier, 601));
    });

    const result = await t.mutation(internal.github.saveInstallation, {
      ownerTokenIdentifier,
      installationId: 602,
      accountLogin: "new-account",
      accountType: "Organization",
      repositorySelection: "all",
    });

    expect(result).toEqual({
      kind: "conflict",
      existingInstallationId: 601,
      existingAccountLogin: "active-601",
    });

    const activeInstallations = await t.run(
      async (ctx) =>
        await ctx.db
          .query("githubInstallations")
          .withIndex("by_ownerTokenIdentifier_and_status", (q) =>
            q.eq("ownerTokenIdentifier", ownerTokenIdentifier).eq("status", "active"),
          )
          .take(10),
    );
    expect(activeInstallations).toHaveLength(1);
    expect(activeInstallations[0]?.installationId).toBe(601);
  });

  test("connection status ignores deleted installations that were created first", async () => {
    const ownerTokenIdentifier = "user|github-status";
    const t = createTestConvex();

    await t.run(async (ctx) => {
      await ctx.db.insert("githubInstallations", deletedInstallation(ownerTokenIdentifier, 101));
      await ctx.db.insert("githubInstallations", activeInstallation(ownerTokenIdentifier, 202));
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const status = await viewer.query(api.github.getGitHubConnectionStatus, {});

    expect(status).toMatchObject({
      isConnected: true,
      installationId: 202,
      accountLogin: "active-202",
      repositorySelection: "selected",
    });
  });

  test("syncRepository uses the active installation when history rows exist", async () => {
    const ownerTokenIdentifier = "user|sync";
    const t = createTestConvex();

    const repositoryId = await t.run(async (ctx) => {
      await ctx.db.insert("githubInstallations", deletedInstallation(ownerTokenIdentifier, 301));
      await ctx.db.insert("githubInstallations", activeInstallation(ownerTokenIdentifier, 302));

      return await ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/repo",
        sourceRepoFullName: "acme/repo",
        sourceRepoOwner: "acme",
        sourceRepoName: "repo",
        defaultBranch: "main",
        visibility: "private",
        accessMode: "private",
        importStatus: "idle",
        detectedLanguages: [],
        packageManagers: [],
        entrypoints: [],
        fileCount: 0,
        color: "blue",
        lastAccessedAt: Date.now(),
      });
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const result = await viewer.mutation(api.repositories.syncRepository, { repositoryId });

    expect(result.jobId).toBeTruthy();
    expect(result.importId).toBeTruthy();

    const repository = await t.run(async (ctx) => await ctx.db.get(repositoryId));
    expect(repository?.importStatus).toBe("queued");
  });

  test("getInstallationIdForOwner returns the active installation id", async () => {
    const ownerTokenIdentifier = "user|installation-query";
    const t = createTestConvex();

    await t.run(async (ctx) => {
      await ctx.db.insert("githubInstallations", deletedInstallation(ownerTokenIdentifier, 401));
      await ctx.db.insert("githubInstallations", activeInstallation(ownerTokenIdentifier, 402));
    });

    const installationId = await t.query(internal.github.getInstallationIdForOwner, {
      ownerTokenIdentifier,
    });

    expect(installationId).toBe(402);
  });

  test("consumeOAuthState returns the stored returnTo origin and marks the state consumed", async () => {
    const ownerTokenIdentifier = "user|oauth-return-to";
    const state = "state-with-return-to";
    const returnTo = "https://systify-git-feature-branch.vercel.app";
    const t = createTestConvex();

    await t.mutation(internal.github.createOAuthState, {
      state,
      ownerTokenIdentifier,
      returnTo,
    });

    const result = await t.mutation(internal.github.consumeOAuthState, { state });

    expect(result).toEqual({
      ownerTokenIdentifier,
      returnTo,
    });

    const storedState = await t.run(
      async (ctx) =>
        await ctx.db
          .query("githubOAuthStates")
          .withIndex("by_state", (q) => q.eq("state", state))
          .unique(),
    );

    expect(storedState?.consumed).toBe(true);
    expect(storedState?.returnTo).toBe(returnTo);
  });

  test("getOAuthReturnToByState returns the stored origin without consuming the state", async () => {
    const ownerTokenIdentifier = "user|oauth-read-return-to";
    const state = "state-read-return-to";
    const returnTo = "https://systify-git-preview.vercel.app";
    const t = createTestConvex();

    await t.mutation(internal.github.createOAuthState, {
      state,
      ownerTokenIdentifier,
      returnTo,
    });

    const lookedUpReturnTo = await t.query(internal.github.getOAuthReturnToByState, {
      state,
    });

    expect(lookedUpReturnTo).toBe(returnTo);

    const storedState = await t.run(
      async (ctx) =>
        await ctx.db
          .query("githubOAuthStates")
          .withIndex("by_state", (q) => q.eq("state", state))
          .unique(),
    );

    expect(storedState?.consumed).toBe(false);
  });

  test("consumeOAuthState returns null returnTo for older state rows without redirect metadata", async () => {
    const ownerTokenIdentifier = "user|oauth-legacy-state";
    const state = "legacy-state";
    const t = createTestConvex();

    await t.run(async (ctx) => {
      await ctx.db.insert("githubOAuthStates", {
        state,
        ownerTokenIdentifier,
        createdAt: Date.now(),
        expiresAt: Date.now() + 10 * 60 * 1000,
        consumed: false,
      });
    });

    const result = await t.mutation(internal.github.consumeOAuthState, { state });

    expect(result).toEqual({
      ownerTokenIdentifier,
      returnTo: null,
    });
  });

  test("initiateGitHubInstall stores sanitized returnTo URL used by callback state lookup", async () => {
    const ownerTokenIdentifier = "user|oauth-initiate-return-to";
    process.env.GITHUB_APP_SLUG = "systify-app";
    process.env[RETURN_TO_ALLOWLIST_ENV] = "https://app.systify.dev";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const installUrl = await viewer.action(api.githubAppNode.initiateGitHubInstall, {
      returnTo: "https://app.systify.dev/settings/integrations?tab=github#close-this-tab",
    });

    const parsedInstallUrl = new URL(installUrl);
    const state = parsedInstallUrl.searchParams.get("state");
    expect(parsedInstallUrl.origin).toBe("https://github.com");
    expect(parsedInstallUrl.pathname).toBe("/apps/systify-app/installations/new");
    expect(state).toBeTruthy();

    const lookedUpReturnTo = await t.query(internal.github.getOAuthReturnToByState, {
      state: state!,
    });
    expect(lookedUpReturnTo).toBe("https://app.systify.dev/settings/integrations?tab=github");
  });
});
