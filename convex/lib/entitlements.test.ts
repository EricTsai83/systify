/// <reference types="vite/client" />

import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import {
  FEATURES,
  assertFeatureAccess,
  getViewerAccessByOwnerTokenIdentifier,
  requiresHighReasoningAccess,
  requiresPremiumModelAccess,
} from "./entitlements";

const modules = import.meta.glob("../**/*.ts");

function createTestConvex() {
  return convexTest(schema, modules);
}

function expectFeatureNotIncluded(error: unknown, feature: string, plan: string) {
  expect(error).toBeInstanceOf(ConvexError);
  expect(parseConvexErrorData(error)).toMatchObject({
    code: "FEATURE_NOT_INCLUDED",
    feature,
    plan,
  });
}

function parseConvexErrorData(error: unknown): unknown {
  let data: unknown = (error as { data?: unknown }).data;
  for (let attempts = 0; attempts < 2 && typeof data === "string"; attempts += 1) {
    data = JSON.parse(data);
  }
  return data;
}

describe("entitlements", () => {
  test("missing profile is treated as free demo access", async () => {
    const t = createTestConvex();
    const access = await t.run(async (ctx) =>
      getViewerAccessByOwnerTokenIdentifier(ctx, {
        ownerTokenIdentifier: "user|missing-profile",
        email: "missing@example.com",
      }),
    );

    expect(access).toMatchObject({
      ownerTokenIdentifier: "user|missing-profile",
      email: "missing@example.com",
      plan: "free",
      billingStatus: "none",
    });
    expect(access.features.demoMode.enabled).toBe(true);
    expect(access.features.chatSend.enabled).toBe(false);
    expect(access.features.repoImport.enabled).toBe(true);
    expect(access.features.syncRepository.enabled).toBe(true);
    expect(access.features.checkForUpdates.enabled).toBe(true);
    expect(access.features.artifactIndexing.enabled).toBe(false);
  });

  test("internal profile enables every feature", async () => {
    const t = createTestConvex();
    const ownerTokenIdentifier = "user|internal-access";
    await t.run(async (ctx) => {
      await ctx.db.insert("userAccessProfiles", {
        ownerTokenIdentifier,
        email: "internal@example.com",
        plan: "internal",
        billingStatus: "none",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const access = await t.run(async (ctx) =>
      getViewerAccessByOwnerTokenIdentifier(ctx, {
        ownerTokenIdentifier,
      }),
    );

    expect(access.plan).toBe("internal");
    for (const feature of FEATURES) {
      expect(access.features[feature].enabled).toBe(true);
    }
  });

  test("assertFeatureAccess throws structured ConvexError for disabled features", async () => {
    const t = createTestConvex();
    let caught: unknown;
    try {
      await t.run(async (ctx) => {
        await assertFeatureAccess(ctx, "user|free-direct", "chatSend");
      });
    } catch (error) {
      caught = error;
    }

    expectFeatureNotIncluded(caught, "chatSend", "free");
  });

  test("model helpers classify premium models and high reasoning", () => {
    expect(requiresPremiumModelAccess("openai", "gpt-5.5")).toBe(true);
    expect(requiresPremiumModelAccess("openai", "gpt-5.4-mini")).toBe(false);
    expect(requiresHighReasoningAccess("high")).toBe(true);
    expect(requiresHighReasoningAccess("xhigh")).toBe(true);
    expect(requiresHighReasoningAccess("medium")).toBe(false);
    expect(requiresHighReasoningAccess(undefined)).toBe(false);
  });
});
