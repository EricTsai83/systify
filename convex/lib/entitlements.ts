import { ConvexError } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";
import { getCatalogEntry, type ReasoningEffort } from "./llmCatalog";
import type { LlmProvider } from "./llmProvider";

export const ACCESS_PLANS = ["internal", "free", "trial", "pro"] as const;
export type AccessPlan = (typeof ACCESS_PLANS)[number];

export const BILLING_STATUSES = ["none", "active", "past_due", "canceled"] as const;
export type BillingStatus = (typeof BILLING_STATUSES)[number];

export const FEATURES = [
  "demoMode",
  "repoImport",
  "syncRepository",
  "checkForUpdates",
  "chatSend",
  "libraryAsk",
  "generateSystemDesign",
  "sandboxGrounding",
  "artifactIndexing",
  "premiumModels",
  "highReasoning",
] as const;

export type Feature = (typeof FEATURES)[number];

export type FeatureAccess = {
  enabled: boolean;
  code: "FEATURE_NOT_INCLUDED" | null;
  message: string | null;
};

export type ViewerAccess = {
  ownerTokenIdentifier: string;
  email: string | null;
  plan: AccessPlan;
  billingStatus: BillingStatus;
  features: Record<Feature, FeatureAccess>;
};

type IdentityLike = {
  tokenIdentifier: string;
  email?: string | null;
};

type EntitlementCtx = QueryCtx | MutationCtx | ActionCtx;
type DbEntitlementCtx = QueryCtx | MutationCtx;

const FEATURE_NOT_INCLUDED_MESSAGE = "This feature is not available on your current plan.";
const ACCESS_PROFILE_SCAN_LIMIT = 20;
const COST_FREE_REPOSITORY_FEATURES = new Set<Feature>(["demoMode", "repoImport", "syncRepository", "checkForUpdates"]);

export async function getViewerAccess(ctx: EntitlementCtx, identity: IdentityLike): Promise<ViewerAccess> {
  return await getViewerAccessForOwnerTokenIdentifier(ctx, {
    ownerTokenIdentifier: identity.tokenIdentifier,
    email: identity.email ?? null,
  });
}

export async function getViewerAccessForOwnerTokenIdentifier(
  ctx: EntitlementCtx,
  args: { ownerTokenIdentifier: string; email?: string | null },
): Promise<ViewerAccess> {
  if (hasDb(ctx)) {
    return await getViewerAccessByOwnerTokenIdentifier(ctx, args);
  }

  return await ctx.runQuery(internal.viewerAccess.getByOwnerTokenIdentifier, {
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    ...(args.email ? { email: args.email } : {}),
  });
}

export async function getViewerAccessByOwnerTokenIdentifier(
  ctx: DbEntitlementCtx,
  args: { ownerTokenIdentifier: string; email?: string | null },
): Promise<ViewerAccess> {
  const profiles = await listAccessProfiles(ctx, args.ownerTokenIdentifier);
  const profile = selectCanonicalProfile(profiles);
  const plan = profile?.plan ?? resolveMissingProfilePlan();
  const billingStatus = profile?.billingStatus ?? "none";

  const access = {
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    email: profile?.email ?? args.email ?? null,
    plan,
    billingStatus,
  };

  return {
    ...access,
    features: evaluateAllFeatureAccess(access),
  };
}

export async function ensureViewerAccessProfile(ctx: MutationCtx, identity: IdentityLike): Promise<ViewerAccess> {
  const ownerTokenIdentifier = identity.tokenIdentifier;
  const email = identity.email ?? null;
  const profiles = await listAccessProfiles(ctx, ownerTokenIdentifier);
  const canonical = selectCanonicalProfile(profiles);
  const now = Date.now();

  if (!canonical) {
    const plan = resolveMissingProfilePlan();
    await ctx.db.insert("userAccessProfiles", {
      ownerTokenIdentifier,
      ...(email ? { email } : {}),
      plan,
      billingStatus: "none",
      createdAt: now,
      updatedAt: now,
    });
    return accessFromProfile({
      ownerTokenIdentifier,
      email,
      plan,
      billingStatus: "none",
    });
  }

  for (const duplicate of profiles) {
    if (duplicate._id !== canonical._id) {
      await ctx.db.delete(duplicate._id);
    }
  }

  const patch: { email?: string; updatedAt?: number } = {};
  if (email && canonical.email !== email) {
    patch.email = email;
    patch.updatedAt = now;
  }
  if (patch.updatedAt !== undefined) {
    await ctx.db.patch(canonical._id, patch);
  }

  return accessFromProfile({
    ownerTokenIdentifier,
    email: patch.email ?? canonical.email ?? email,
    plan: canonical.plan,
    billingStatus: canonical.billingStatus,
  });
}

export async function assertFeatureAccess(
  ctx: EntitlementCtx,
  identityOrOwnerTokenIdentifier: IdentityLike | string,
  feature: Feature,
): Promise<void> {
  const access =
    typeof identityOrOwnerTokenIdentifier === "string"
      ? await getViewerAccessForOwnerTokenIdentifier(ctx, {
          ownerTokenIdentifier: identityOrOwnerTokenIdentifier,
        })
      : await getViewerAccess(ctx, identityOrOwnerTokenIdentifier);
  const verdict = evaluateFeatureAccess(access, feature);
  if (verdict.enabled) {
    return;
  }

  throw new ConvexError({
    code: "FEATURE_NOT_INCLUDED",
    feature,
    plan: access.plan,
    message: FEATURE_NOT_INCLUDED_MESSAGE,
  });
}

export function evaluateFeatureAccess(access: Pick<ViewerAccess, "plan" | "billingStatus">, feature: Feature) {
  const enabled = isFeatureEnabled(access, feature);
  return {
    enabled,
    code: enabled ? null : ("FEATURE_NOT_INCLUDED" as const),
    message: enabled ? null : FEATURE_NOT_INCLUDED_MESSAGE,
  } satisfies FeatureAccess;
}

export function requiresPremiumModelAccess(provider: LlmProvider, modelName: string): boolean {
  const entry = getCatalogEntry(provider, modelName);
  return entry?.capability === "sandbox";
}

export function requiresHighReasoningAccess(reasoningEffort: ReasoningEffort | undefined): boolean {
  return reasoningEffort === "high" || reasoningEffort === "xhigh";
}

function evaluateAllFeatureAccess(
  access: Pick<ViewerAccess, "plan" | "billingStatus">,
): Record<Feature, FeatureAccess> {
  return Object.fromEntries(FEATURES.map((feature) => [feature, evaluateFeatureAccess(access, feature)])) as Record<
    Feature,
    FeatureAccess
  >;
}

function isFeatureEnabled(access: Pick<ViewerAccess, "plan" | "billingStatus">, feature: Feature): boolean {
  if (access.plan === "internal") {
    return true;
  }

  // Trial and paid plan limits require real usage budgets / billing webhooks
  // before variable-cost operations can be safely enabled. GitHub-backed
  // repository import/sync does not provision a sandbox or call LLM providers,
  // so keep it available while chat, sandbox, generation, and embeddings stay
  // gated.
  return COST_FREE_REPOSITORY_FEATURES.has(feature);
}

function hasDb(ctx: EntitlementCtx): ctx is DbEntitlementCtx {
  return "db" in ctx;
}

async function listAccessProfiles(
  ctx: DbEntitlementCtx,
  ownerTokenIdentifier: string,
): Promise<Array<Doc<"userAccessProfiles">>> {
  return await ctx.db
    .query("userAccessProfiles")
    .withIndex("by_ownerTokenIdentifier", (q) => q.eq("ownerTokenIdentifier", ownerTokenIdentifier))
    .take(ACCESS_PROFILE_SCAN_LIMIT);
}

function selectCanonicalProfile(profiles: ReadonlyArray<Doc<"userAccessProfiles">>): Doc<"userAccessProfiles"> | null {
  if (profiles.length === 0) {
    return null;
  }
  return profiles.reduce((best, candidate) => {
    if (candidate.updatedAt !== best.updatedAt) {
      return candidate.updatedAt > best.updatedAt ? candidate : best;
    }
    return candidate._creationTime > best._creationTime ? candidate : best;
  });
}

function resolveMissingProfilePlan(): AccessPlan {
  return "free";
}

function accessFromProfile(access: Omit<ViewerAccess, "features">): ViewerAccess {
  return {
    ...access,
    features: evaluateAllFeatureAccess(access),
  };
}
