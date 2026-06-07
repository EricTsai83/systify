/// <reference types="vite/client" />

import { describe, expect, test, afterEach, vi } from "vitest";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import { parseGitHubUrl } from "./lib/github";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const RETURN_TO_ALLOWLIST_ENV = "ALLOWED_RETURN_TO_ORIGINS";
const originalGitHubAppSlug = process.env.GITHUB_APP_SLUG;
const originalGitHubAppClientId = process.env.GITHUB_APP_CLIENT_ID;
const originalGitHubAppClientSecret = process.env.GITHUB_APP_CLIENT_SECRET;
const originalReturnToAllowlist = process.env[RETURN_TO_ALLOWLIST_ENV];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();

  if (originalGitHubAppSlug === undefined) {
    delete process.env.GITHUB_APP_SLUG;
  } else {
    process.env.GITHUB_APP_SLUG = originalGitHubAppSlug;
  }

  if (originalGitHubAppClientId === undefined) {
    delete process.env.GITHUB_APP_CLIENT_ID;
  } else {
    process.env.GITHUB_APP_CLIENT_ID = originalGitHubAppClientId;
  }

  if (originalGitHubAppClientSecret === undefined) {
    delete process.env.GITHUB_APP_CLIENT_SECRET;
  } else {
    process.env.GITHUB_APP_CLIENT_SECRET = originalGitHubAppClientSecret;
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

async function seedInternalAccessProfile(
  t: ReturnType<typeof createTestConvex>,
  ownerTokenIdentifier: string,
  overrides?: { email?: string },
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("userAccessProfiles", {
      ownerTokenIdentifier,
      email: overrides?.email ?? `${ownerTokenIdentifier}@example.com`,
      plan: "internal",
      billingStatus: "none",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
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

function suspendedInstallation(ownerTokenIdentifier: string, installationId: number) {
  return {
    ownerTokenIdentifier,
    installationId,
    accountLogin: `suspended-${installationId}`,
    accountType: "User" as const,
    status: "suspended" as const,
    repositorySelection: "selected" as const,
    connectedAt: Date.now() - 10_000,
    suspendedAt: Date.now() - 5_000,
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

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function requestBodyText(init: RequestInit | undefined): string {
  const body = init?.body;
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  if (typeof body === "string") {
    return body;
  }
  if (body === undefined || body === null) {
    return "";
  }
  throw new Error("Unexpected request body type.");
}

describe("parseGitHubUrl", () => {
  test("ignores subtree paths in /tree URLs", () => {
    const parsed = parseGitHubUrl("https://github.com/acme/widget/tree/feature/import-hardening");

    expect(parsed).toMatchObject({
      normalizedUrl: "https://github.com/acme/widget",
      owner: "acme",
      repo: "widget",
      fullName: "acme/widget",
      branch: undefined,
    });
  });
});

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

  test("saveInstallation rejects an installation id already active for another owner", async () => {
    const ownerTokenIdentifier = "user|installation-owner";
    const intruderTokenIdentifier = "user|installation-intruder";
    const t = createTestConvex();

    await t.run(async (ctx) => {
      await ctx.db.insert("githubInstallations", activeInstallation(ownerTokenIdentifier, 701));
    });

    const result = await t.mutation(internal.github.saveInstallation, {
      ownerTokenIdentifier: intruderTokenIdentifier,
      installationId: 701,
      accountLogin: "intruder-account",
      accountType: "User",
      repositorySelection: "all",
    });

    expect(result).toEqual({
      kind: "conflict",
      existingInstallationId: 701,
      existingAccountLogin: "active-701",
    });

    const rows = await t.run(
      async (ctx) =>
        await ctx.db
          .query("githubInstallations")
          .withIndex("by_installationId", (q) => q.eq("installationId", 701))
          .take(10),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ownerTokenIdentifier).toBe(ownerTokenIdentifier);
  });

  test("saveInstallation rejects an installation id already suspended for another owner", async () => {
    const ownerTokenIdentifier = "user|installation-owner-suspended";
    const intruderTokenIdentifier = "user|installation-intruder-suspended";
    const t = createTestConvex();

    await t.run(async (ctx) => {
      await ctx.db.insert("githubInstallations", suspendedInstallation(ownerTokenIdentifier, 703));
    });

    const result = await t.mutation(internal.github.saveInstallation, {
      ownerTokenIdentifier: intruderTokenIdentifier,
      installationId: 703,
      accountLogin: "intruder-account",
      accountType: "User",
      repositorySelection: "all",
    });

    expect(result).toEqual({
      kind: "conflict",
      existingInstallationId: 703,
      existingAccountLogin: "suspended-703",
    });

    const rows = await t.run(
      async (ctx) =>
        await ctx.db
          .query("githubInstallations")
          .withIndex("by_installationId", (q) => q.eq("installationId", 703))
          .take(10),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ownerTokenIdentifier).toBe(ownerTokenIdentifier);
    expect(rows[0]?.status).toBe("suspended");
  });

  test("saveInstallation reconnects the same owner's suspended installation", async () => {
    const ownerTokenIdentifier = "user|installation-suspended-reconnect";
    const t = createTestConvex();

    await t.run(async (ctx) => {
      await ctx.db.insert("githubInstallations", suspendedInstallation(ownerTokenIdentifier, 704));
    });

    const result = await t.mutation(internal.github.saveInstallation, {
      ownerTokenIdentifier,
      installationId: 704,
      accountLogin: "reconnected-account",
      accountType: "Organization",
      repositorySelection: "all",
    });

    expect(result).toEqual({
      kind: "connected",
      installationId: 704,
    });

    const rows = await t.run(
      async (ctx) =>
        await ctx.db
          .query("githubInstallations")
          .withIndex("by_ownerTokenIdentifier_and_installationId", (q) =>
            q.eq("ownerTokenIdentifier", ownerTokenIdentifier).eq("installationId", 704),
          )
          .take(10),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      accountLogin: "reconnected-account",
      accountType: "Organization",
      repositorySelection: "all",
      status: "active",
    });
    expect(rows[0]?.suspendedAt).toBeUndefined();
  });

  test("saveInstallation allows reusing an installation id after the foreign active row is deleted", async () => {
    const oldOwnerTokenIdentifier = "user|installation-old-owner";
    const newOwnerTokenIdentifier = "user|installation-new-owner";
    const t = createTestConvex();

    await t.run(async (ctx) => {
      await ctx.db.insert("githubInstallations", deletedInstallation(oldOwnerTokenIdentifier, 702));
    });

    const result = await t.mutation(internal.github.saveInstallation, {
      ownerTokenIdentifier: newOwnerTokenIdentifier,
      installationId: 702,
      accountLogin: "new-account",
      accountType: "Organization",
      repositorySelection: "selected",
    });

    expect(result).toEqual({
      kind: "connected",
      installationId: 702,
    });
  });

  test("saveInstallation does not patch a foreign deleted installation row", async () => {
    const oldOwnerTokenIdentifier = "user|installation-foreign-deleted-old-owner";
    const newOwnerTokenIdentifier = "user|installation-foreign-deleted-new-owner";
    const t = createTestConvex();

    await t.run(async (ctx) => {
      await ctx.db.insert("githubInstallations", deletedInstallation(oldOwnerTokenIdentifier, 705));
    });

    const result = await t.mutation(internal.github.saveInstallation, {
      ownerTokenIdentifier: newOwnerTokenIdentifier,
      installationId: 705,
      accountLogin: "new-account",
      accountType: "Organization",
      repositorySelection: "selected",
    });

    expect(result).toEqual({
      kind: "connected",
      installationId: 705,
    });

    const rows = await t.run(
      async (ctx) =>
        await ctx.db
          .query("githubInstallations")
          .withIndex("by_installationId", (q) => q.eq("installationId", 705))
          .order("asc")
          .take(10),
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.ownerTokenIdentifier === oldOwnerTokenIdentifier)).toMatchObject({
      accountLogin: "deleted-705",
      status: "deleted",
    });
    expect(rows.find((row) => row.ownerTokenIdentifier === newOwnerTokenIdentifier)).toMatchObject({
      accountLogin: "new-account",
      status: "active",
    });
  });

  test("deleted installations can only reconnect through saveInstallation", async () => {
    const ownerTokenIdentifier = "user|installation-deleted-reconnect";
    const t = createTestConvex();

    await t.run(async (ctx) => {
      await ctx.db.insert("githubInstallations", deletedInstallation(ownerTokenIdentifier, 706));
    });

    await t.mutation(internal.github.markInstallationActive, { installationId: 706 });

    const afterWebhook = await t.run(
      async (ctx) =>
        await ctx.db
          .query("githubInstallations")
          .withIndex("by_ownerTokenIdentifier_and_installationId", (q) =>
            q.eq("ownerTokenIdentifier", ownerTokenIdentifier).eq("installationId", 706),
          )
          .unique(),
    );
    expect(afterWebhook?.status).toBe("deleted");

    await t.mutation(internal.github.saveInstallation, {
      ownerTokenIdentifier,
      installationId: 706,
      accountLogin: "fresh-oauth-account",
      accountType: "User",
      repositorySelection: "all",
    });

    const afterSave = await t.run(
      async (ctx) =>
        await ctx.db
          .query("githubInstallations")
          .withIndex("by_ownerTokenIdentifier_and_installationId", (q) =>
            q.eq("ownerTokenIdentifier", ownerTokenIdentifier).eq("installationId", 706),
          )
          .unique(),
    );
    expect(afterSave).toMatchObject({
      accountLogin: "fresh-oauth-account",
      status: "active",
    });
  });

  test("markInstallationSuspended ignores deleted installations", async () => {
    const ownerTokenIdentifier = "user|installation-suspend-deleted";
    const t = createTestConvex();

    await t.run(async (ctx) => {
      await ctx.db.insert("githubInstallations", deletedInstallation(ownerTokenIdentifier, 707));
    });

    await t.mutation(internal.github.markInstallationSuspended, { installationId: 707 });

    const row = await t.run(
      async (ctx) =>
        await ctx.db
          .query("githubInstallations")
          .withIndex("by_ownerTokenIdentifier_and_installationId", (q) =>
            q.eq("ownerTokenIdentifier", ownerTokenIdentifier).eq("installationId", 707),
          )
          .unique(),
    );
    expect(row?.status).toBe("deleted");
  });

  test("markInstallationActive does not resurrect deleted installations", async () => {
    const ownerTokenIdentifier = "user|installation-unsuspend-deleted";
    const t = createTestConvex();

    await t.run(async (ctx) => {
      await ctx.db.insert("githubInstallations", deletedInstallation(ownerTokenIdentifier, 708));
    });

    await t.mutation(internal.github.markInstallationActive, { installationId: 708 });

    const row = await t.run(
      async (ctx) =>
        await ctx.db
          .query("githubInstallations")
          .withIndex("by_ownerTokenIdentifier_and_installationId", (q) =>
            q.eq("ownerTokenIdentifier", ownerTokenIdentifier).eq("installationId", 708),
          )
          .unique(),
    );
    expect(row?.status).toBe("deleted");
  });

  test("markInstallationActive fails closed when multiple current owners exist", async () => {
    const activeOwnerTokenIdentifier = "user|installation-unsuspend-active-owner";
    const suspendedOwnerTokenIdentifier = "user|installation-unsuspend-suspended-owner";
    const t = createTestConvex();

    await t.run(async (ctx) => {
      await ctx.db.insert("githubInstallations", activeInstallation(activeOwnerTokenIdentifier, 709));
      await ctx.db.insert("githubInstallations", suspendedInstallation(suspendedOwnerTokenIdentifier, 709));
    });

    await t.mutation(internal.github.markInstallationActive, { installationId: 709 });

    const rows = await t.run(
      async (ctx) =>
        await ctx.db
          .query("githubInstallations")
          .withIndex("by_installationId", (q) => q.eq("installationId", 709))
          .take(10),
    );
    expect(rows.find((row) => row.ownerTokenIdentifier === activeOwnerTokenIdentifier)?.status).toBe("active");
    expect(rows.find((row) => row.ownerTokenIdentifier === suspendedOwnerTokenIdentifier)?.status).toBe("suspended");
  });

  test("disconnectGitHub deletes suspended installations", async () => {
    const ownerTokenIdentifier = "user|installation-disconnect-suspended";
    const t = createTestConvex();

    await t.run(async (ctx) => {
      await ctx.db.insert("githubInstallations", suspendedInstallation(ownerTokenIdentifier, 710));
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    await viewer.mutation(api.github.disconnectGitHub, {});

    const row = await t.run(
      async (ctx) =>
        await ctx.db
          .query("githubInstallations")
          .withIndex("by_ownerTokenIdentifier_and_installationId", (q) =>
            q.eq("ownerTokenIdentifier", ownerTokenIdentifier).eq("installationId", 710),
          )
          .unique(),
    );
    expect(row?.status).toBe("deleted");
    expect(row?.deletedAt).toEqual(expect.any(Number));
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
      installationStatus: "active",
    });
  });

  test("connection status returns suspended metadata with isConnected false", async () => {
    const ownerTokenIdentifier = "user|github-status-suspended";
    const t = createTestConvex();

    await t.run(async (ctx) => {
      await ctx.db.insert("githubInstallations", suspendedInstallation(ownerTokenIdentifier, 203));
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const status = await viewer.query(api.github.getGitHubConnectionStatus, {});

    expect(status).toMatchObject({
      isConnected: false,
      installationId: 203,
      accountLogin: "suspended-203",
      repositorySelection: "selected",
      installationStatus: "suspended",
    });
  });

  test("syncRepository uses the active installation when history rows exist", async () => {
    const ownerTokenIdentifier = "user|sync";
    const t = createTestConvex();

    await seedInternalAccessProfile(t, ownerTokenIdentifier, { email: "sync@example.com" });

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

  test("prepareInstallationUserAuthorization records pending installation without consuming state", async () => {
    const ownerTokenIdentifier = "user|oauth-prepare";
    const state = "state-prepare-installation";
    const t = createTestConvex();

    await t.mutation(internal.github.createOAuthState, {
      state,
      ownerTokenIdentifier,
      githubCodeVerifier: "a".repeat(64),
      githubCodeChallenge: "b".repeat(43),
    });

    const result = await t.mutation(internal.github.prepareInstallationUserAuthorization, {
      state,
      installationId: 801,
    });

    expect(result).toEqual({
      returnTo: null,
      githubCodeChallenge: "b".repeat(43),
    });

    const storedState = await t.run(
      async (ctx) =>
        await ctx.db
          .query("githubOAuthStates")
          .withIndex("by_state", (q) => q.eq("state", state))
          .unique(),
    );

    expect(storedState).toMatchObject({
      consumed: false,
      pendingInstallationId: 801,
    });
    expect(storedState?.githubUserAuthorizationStartedAt).toEqual(expect.any(Number));
  });

  test("consumeOAuthStateForInstallationVerification consumes the pending installation state", async () => {
    const ownerTokenIdentifier = "user|oauth-consume-installation";
    const state = "state-consume-installation";
    const t = createTestConvex();

    await t.mutation(internal.github.createOAuthState, {
      state,
      ownerTokenIdentifier,
      githubCodeVerifier: "c".repeat(64),
      githubCodeChallenge: "d".repeat(43),
    });
    await t.mutation(internal.github.prepareInstallationUserAuthorization, {
      state,
      installationId: 901,
    });

    const result = await t.mutation(internal.github.consumeOAuthStateForInstallationVerification, {
      state,
    });

    expect(result).toEqual({
      ownerTokenIdentifier,
      returnTo: null,
      installationId: 901,
      githubCodeVerifier: "c".repeat(64),
    });

    const storedState = await t.run(
      async (ctx) =>
        await ctx.db
          .query("githubOAuthStates")
          .withIndex("by_state", (q) => q.eq("state", state))
          .unique(),
    );
    expect(storedState?.consumed).toBe(true);
  });

  test("consumeOAuthStateForInstallationVerification rejects a mismatched callback installation", async () => {
    const ownerTokenIdentifier = "user|oauth-mismatched-installation";
    const state = "state-mismatched-installation";
    const t = createTestConvex();

    await t.mutation(internal.github.createOAuthState, {
      state,
      ownerTokenIdentifier,
      githubCodeVerifier: "e".repeat(64),
      githubCodeChallenge: "f".repeat(43),
    });
    await t.mutation(internal.github.prepareInstallationUserAuthorization, {
      state,
      installationId: 1001,
    });

    await expect(
      t.mutation(internal.github.consumeOAuthStateForInstallationVerification, {
        state,
        callbackInstallationId: 1002,
      }),
    ).rejects.toThrow("does not match the pending installation");
  });

  test("initiateGitHubInstall stores sanitized returnTo URL used by callback state lookup", async () => {
    const ownerTokenIdentifier = "user|oauth-initiate-return-to";
    process.env.GITHUB_APP_SLUG = "systify-app";
    process.env.GITHUB_APP_CLIENT_ID = "Iv1.test-client-id";
    process.env.GITHUB_APP_CLIENT_SECRET = "test-client-secret";
    process.env[RETURN_TO_ALLOWLIST_ENV] = "https://app.systify.dev";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    await seedInternalAccessProfile(t, ownerTokenIdentifier);

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

    const storedState = await t.run(
      async (ctx) =>
        await ctx.db
          .query("githubOAuthStates")
          .withIndex("by_state", (q) => q.eq("state", state!))
          .unique(),
    );
    expect(storedState?.githubCodeVerifier).toMatch(/^[0-9a-f]{64}$/u);
    expect(storedState?.githubCodeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  test("verifyInstallationAccessWithGitHubUser accepts a GitHub user who can access the installation", async () => {
    process.env.GITHUB_APP_CLIENT_ID = "Iv1.test-client-id";
    process.env.GITHUB_APP_CLIENT_SECRET = "test-client-secret";
    const t = createTestConvex();
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);

      if (url === "https://github.com/login/oauth/access_token") {
        expect(init?.method).toBe("POST");
        const body = requestBodyText(init);
        expect(body).toContain("code=github-code");
        expect(body).toContain("code_verifier=github-verifier");
        return new Response(JSON.stringify({ access_token: "ghu_user_token" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url === "https://api.github.com/user/installations?per_page=100") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer ghu_user_token");
        return new Response(JSON.stringify({ installations: [{ id: 1101 }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await t.action(internal.githubAppNode.verifyInstallationAccessWithGitHubUser, {
      code: "github-code",
      codeVerifier: "github-verifier",
      redirectUri: "https://example.com/api/github/callback",
      installationId: 1101,
    });

    expect(result).toEqual({ kind: "verified" });
  });

  test("verifyInstallationAccessWithGitHubUser rejects a GitHub user who cannot access the installation", async () => {
    process.env.GITHUB_APP_CLIENT_ID = "Iv1.test-client-id";
    process.env.GITHUB_APP_CLIENT_SECRET = "test-client-secret";
    const t = createTestConvex();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);

      if (url === "https://github.com/login/oauth/access_token") {
        return new Response(JSON.stringify({ access_token: "ghu_user_token" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url === "https://api.github.com/user/installations?per_page=100") {
        return new Response(JSON.stringify({ installations: [{ id: 1202 }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await t.action(internal.githubAppNode.verifyInstallationAccessWithGitHubUser, {
      code: "github-code",
      redirectUri: "https://example.com/api/github/callback",
      installationId: 1201,
    });

    expect(result).toEqual({
      kind: "unauthorized",
      message: "The authenticated GitHub user cannot access this GitHub App installation.",
    });
  });
});
