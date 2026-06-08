/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function createTestConvex() {
  return convexTest(schema, modules);
}

async function seedRepository(t: ReturnType<typeof createTestConvex>, ownerTokenIdentifier: string) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("repositories", {
      ownerTokenIdentifier,
      sourceHost: "github",
      sourceUrl: "https://github.com/acme/existing-repo",
      sourceRepoFullName: "acme/existing-repo",
      sourceRepoOwner: "acme",
      sourceRepoName: "existing-repo",
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

describe("viewerAccess.getSelf", () => {
  test("returns free demo access when no profile exists", async () => {
    const t = createTestConvex();
    const viewer = t.withIdentity({
      tokenIdentifier: "user|viewer-free",
      email: "viewer-free@example.com",
    });

    const access = await viewer.query(api.viewerAccess.getSelf, {});

    expect(access).toMatchObject({
      ownerTokenIdentifier: "user|viewer-free",
      email: "viewer-free@example.com",
      plan: "free",
      billingStatus: "none",
    });
    expect(access.features.demoMode.enabled).toBe(true);
    expect(access.features.chatSend.enabled).toBe(false);
  });

  test("returns the persisted profile as source of truth", async () => {
    const t = createTestConvex();
    const ownerTokenIdentifier = "user|viewer-internal";
    await t.run(async (ctx) => {
      await ctx.db.insert("userAccessProfiles", {
        ownerTokenIdentifier,
        email: "profile@example.com",
        plan: "internal",
        billingStatus: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const access = await t
      .withIdentity({
        tokenIdentifier: ownerTokenIdentifier,
        email: "identity@example.com",
      })
      .query(api.viewerAccess.getSelf, {});

    expect(access).toMatchObject({
      ownerTokenIdentifier,
      email: "profile@example.com",
      plan: "internal",
      billingStatus: "active",
    });
    expect(access.features.repoImport.enabled).toBe(true);
    expect(access.features.generateSystemDesign.enabled).toBe(true);
  });

  test("treats pre-entitlement owners with existing data as free until manually upgraded", async () => {
    const t = createTestConvex();
    const ownerTokenIdentifier = "user|viewer-existing-owner";
    await seedRepository(t, ownerTokenIdentifier);

    const access = await t
      .withIdentity({
        tokenIdentifier: ownerTokenIdentifier,
        email: "existing@example.com",
      })
      .query(api.viewerAccess.getSelf, {});

    expect(access).toMatchObject({
      ownerTokenIdentifier,
      email: "existing@example.com",
      plan: "free",
      billingStatus: "none",
    });
    expect(access.features.chatSend.enabled).toBe(false);
    expect(access.features.repoImport.enabled).toBe(true);
    expect(access.features.syncRepository.enabled).toBe(true);
  });
});

describe("viewerAccess.ensureSelf", () => {
  test("creates a durable free profile for new demo viewers", async () => {
    const t = createTestConvex();
    const ownerTokenIdentifier = "user|viewer-ensure-free";

    const access = await t
      .withIdentity({
        tokenIdentifier: ownerTokenIdentifier,
        email: "ensure-free@example.com",
      })
      .mutation(api.viewerAccess.ensureSelf, {});

    expect(access.plan).toBe("free");
    const profiles = await t.run(async (ctx) =>
      ctx.db
        .query("userAccessProfiles")
        .withIndex("by_ownerTokenIdentifier", (q) => q.eq("ownerTokenIdentifier", ownerTokenIdentifier))
        .collect(),
    );
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      ownerTokenIdentifier,
      email: "ensure-free@example.com",
      plan: "free",
      billingStatus: "none",
    });
  });

  test("creates a durable free profile for existing pre-entitlement owners", async () => {
    const t = createTestConvex();
    const ownerTokenIdentifier = "user|viewer-ensure-existing";
    await seedRepository(t, ownerTokenIdentifier);

    const access = await t
      .withIdentity({
        tokenIdentifier: ownerTokenIdentifier,
        email: "existing-owner@example.com",
      })
      .mutation(api.viewerAccess.ensureSelf, {});

    expect(access.plan).toBe("free");
    const profiles = await t.run(async (ctx) =>
      ctx.db
        .query("userAccessProfiles")
        .withIndex("by_ownerTokenIdentifier", (q) => q.eq("ownerTokenIdentifier", ownerTokenIdentifier))
        .collect(),
    );
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      ownerTokenIdentifier,
      email: "existing-owner@example.com",
      plan: "free",
      billingStatus: "none",
    });
  });

  test("deduplicates profiles and keeps the most recently updated profile authoritative", async () => {
    const t = createTestConvex();
    const ownerTokenIdentifier = "user|viewer-ensure-dedup";
    await t.run(async (ctx) => {
      await ctx.db.insert("userAccessProfiles", {
        ownerTokenIdentifier,
        email: "old@example.com",
        plan: "free",
        billingStatus: "none",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("userAccessProfiles", {
        ownerTokenIdentifier,
        email: "new@example.com",
        plan: "internal",
        billingStatus: "active",
        createdAt: 2,
        updatedAt: 2,
      });
    });

    const access = await t
      .withIdentity({
        tokenIdentifier: ownerTokenIdentifier,
        email: "identity@example.com",
      })
      .mutation(api.viewerAccess.ensureSelf, {});

    expect(access).toMatchObject({
      ownerTokenIdentifier,
      email: "identity@example.com",
      plan: "internal",
      billingStatus: "active",
    });
    const profiles = await t.run(async (ctx) =>
      ctx.db
        .query("userAccessProfiles")
        .withIndex("by_ownerTokenIdentifier", (q) => q.eq("ownerTokenIdentifier", ownerTokenIdentifier))
        .collect(),
    );
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      ownerTokenIdentifier,
      email: "identity@example.com",
      plan: "internal",
      billingStatus: "active",
    });
  });
});
