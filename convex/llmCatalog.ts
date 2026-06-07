/**
 * Public queries exposing the LLM model catalog to the frontend.
 *
 * The catalog itself lives in `convex/lib/llmCatalog.ts` (which the
 * gateway and the send mutation also read). This module is a thin
 * shim that surfaces a JSON-safe projection through Convex's public
 * `query` so the composer's model picker can subscribe to "which
 * `(provider, model)` pairs are pickable right now?" without pulling
 * in the catalog module on the client.
 *
 * Why a query (vs. a constant the client imports directly):
 *
 *   - The catalog reads the `llmProviderValidator` from the server
 *     schema barrel; surfacing it via `useQuery` keeps the client
 *     bundle free of those server-only imports.
 *   - A query keeps the door open to per-user catalog filtering (e.g.
 *     hide gpt-5 from a free-tier user) without a frontend change.
 *     Today the projection is uniform across users; tomorrow we add an
 *     auth read here.
 *
 * The projection is intentionally JSON-safe: every field on
 * {@link ModelCatalogEntry} round-trips through
 * `JSON.parse(JSON.stringify(...))`.
 */

import { v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import {
  catalogCapabilityForPickableSurface,
  isUserPickableModel,
  listPickableModels as listPickableModelsFromCatalog,
  ROLE_MODELS,
  type ModelCatalogEntry,
  type UserPickableCapability,
} from "./lib/llmCatalog";
import { llmProviderValidator, type LlmProvider } from "./lib/llmProvider";
import {
  applyModelPreferences,
  getModelPreferencesForScope,
  isModelEnabledInPreferences,
  loadViewerModelPreferences,
  modelPreferenceKey,
  normalizeModelPreferences,
  type ModelPreferenceScope,
  type UserModelPreferences,
} from "./lib/userPreferences";

const capabilityValidator = v.union(v.literal("sandbox"), v.literal("library"), v.literal("discuss"));
const modelPreferenceScopeValidator = v.union(
  v.literal("chat"),
  v.literal("discuss"),
  v.literal("library"),
  v.literal("sandbox"),
);

/**
 * Per-capability `(provider, modelName)` default surfaced to the
 * frontend so the composer's model picker can hydrate its trigger
 * label without flashing a "Pick model" placeholder on first mount.
 * Mirrors the backend cascade in `resolveModelForReply`'s third
 * layer — the picker shows what the gateway would otherwise resolve
 * to when no override / thread default exists.
 *
 * Sourced from {@link ROLE_MODELS} so the swap-the-model contract is
 * single-file (`llmCatalog.ts` edit propagates to both the resolver
 * and this query).
 */
const DEFAULT_PICK_BY_CAPABILITY: Record<UserPickableCapability, { provider: LlmProvider; modelName: string }> = {
  sandbox: ROLE_MODELS.defaultSandbox,
  library: ROLE_MODELS.defaultLibrary,
  discuss: ROLE_MODELS.defaultDiscuss,
};

export type ModelSettingsEntry = ModelCatalogEntry & {
  enabled: boolean;
  favorite: boolean;
  default: boolean;
  defaultSource: "custom" | "system" | null;
};

export type PickableModelEntry = ModelCatalogEntry & {
  favorite: boolean;
  default: boolean;
  defaultSource: "custom" | "system" | null;
};

async function getOptionalViewerModelPreferences(ctx: QueryCtx): Promise<UserModelPreferences> {
  const identity = await ctx.auth.getUserIdentity();
  return identity ? await loadViewerModelPreferences(ctx, identity.tokenIdentifier) : normalizeModelPreferences(null);
}

function toPick(entry: { provider: LlmProvider; modelName: string }) {
  return {
    provider: entry.provider,
    modelName: entry.modelName,
  };
}

/**
 * Return the subset of {@link MODEL_CATALOG} that the model picker
 * should surface, optionally filtered by `(provider, capability)`.
 *
 * Both filters compose: passing both restricts to entries matching
 * each. Omit both to get the full pickable set.
 *
 * Returned shape carries {@link ModelCatalogEntry} plus per-viewer
 * picker metadata (`favorite` / `default`) so the frontend can group
 * shortcuts without importing server-only catalog helpers.
 *
 * Authentication: this query is public-readable for now — the picker
 * UI needs to render even before the viewer is fully authenticated
 * (e.g. on the auth landing page demo). When per-user catalog policies
 * land, swap to `requireViewerIdentity` here and adjust the picker's
 * `useQuery` to handle the unauth case.
 */
export const listPickableModels = query({
  args: {
    provider: v.optional(llmProviderValidator),
    capability: v.optional(capabilityValidator),
    preferenceScope: v.optional(modelPreferenceScopeValidator),
  },
  handler: async (ctx, args): Promise<PickableModelEntry[]> => {
    const preferences = await getOptionalViewerModelPreferences(ctx);
    const scope = args.preferenceScope ?? capabilityToPreferenceScope(args.capability);
    const scoped = getModelPreferencesForScope(preferences, scope);
    const favoriteKeys = new Set(scoped.favoriteModels.map(modelPreferenceKey));
    const catalogEntries = listPickableModelsFromCatalog({
      provider: args.provider,
      capability: args.capability,
    });
    const defaultResolution = effectiveDefaultResolution(preferences, scope, catalogEntries, args.capability);
    return applyModelPreferences(catalogEntries, preferences, scope).map((entry) => ({
      ...entry,
      favorite: favoriteKeys.has(modelPreferenceKey(entry)),
      default: defaultResolution?.key === modelPreferenceKey(entry),
      defaultSource: defaultResolution?.key === modelPreferenceKey(entry) ? defaultResolution.source : null,
    }));
  },
});

export const listModelSettings = query({
  args: {
    scope: modelPreferenceScopeValidator,
  },
  handler: async (ctx, { scope }): Promise<ModelSettingsEntry[]> => {
    const preferences = await getOptionalViewerModelPreferences(ctx);
    const scoped = getModelPreferencesForScope(preferences, scope);
    const favoriteKeys = new Set(scoped.favoriteModels.map(modelPreferenceKey));
    const catalogEntries = listPickableModelsFromCatalog(settingsCatalogFilterForScope(scope));
    const defaultResolution = effectiveDefaultResolution(preferences, scope, catalogEntries);
    return catalogEntries.map((entry) => ({
      ...entry,
      enabled: isModelEnabledInPreferences(preferences, entry, scope),
      favorite: favoriteKeys.has(modelPreferenceKey(entry)),
      default: defaultResolution?.key === modelPreferenceKey(entry),
      defaultSource: defaultResolution?.key === modelPreferenceKey(entry) ? defaultResolution.source : null,
    }));
  },
});

/**
 * Return the `(provider, modelName)` default for a capability tier,
 * so the composer's model picker can render its trigger label with
 * the actual default model on first mount instead of a placeholder
 * (and the user can see what the backend would otherwise resolve to before
 * they make a pick).
 *
 * Mirrors the third layer of {@link resolveModelForReply}'s cascade, then
 * applies viewer model availability. If the catalog default was disabled by
 * the viewer, we fall forward to the first enabled pickable model instead of
 * handing the composer a model it just hid.
 */
export const getDefaultModelPick = query({
  args: {
    capability: capabilityValidator,
    preferenceScope: v.optional(modelPreferenceScopeValidator),
  },
  handler: async (ctx, { capability, preferenceScope }): Promise<{ provider: LlmProvider; modelName: string }> => {
    const preferences = await getOptionalViewerModelPreferences(ctx);
    const scope = preferenceScope ?? capabilityToPreferenceScope(capability);
    const scoped = getModelPreferencesForScope(preferences, scope);
    if (
      scoped.defaultModel &&
      isModelEnabledInPreferences(preferences, scoped.defaultModel, scope) &&
      isUserPickableModel(scoped.defaultModel.provider, scoped.defaultModel.modelName, capability)
    ) {
      return toPick(scoped.defaultModel);
    }

    const fallback = DEFAULT_PICK_BY_CAPABILITY[capability];
    if (isModelEnabledInPreferences(preferences, fallback, scope)) {
      return fallback;
    }

    const capabilityFallback = applyModelPreferences(
      listPickableModelsFromCatalog({ capability }),
      preferences,
      scope,
    )[0];
    const firstEnabled =
      capabilityFallback ?? applyModelPreferences(listPickableModelsFromCatalog(), preferences, scope)[0];
    return firstEnabled ? toPick(firstEnabled) : fallback;
  },
});

function capabilityToPreferenceScope(capability: UserPickableCapability | undefined): ModelPreferenceScope {
  if (capability === "sandbox") {
    return "sandbox";
  }
  if (capability === "library") {
    return "library";
  }
  return "discuss";
}

function defaultCapabilityForScope(scope: ModelPreferenceScope): UserPickableCapability {
  if (scope === "sandbox") {
    return "sandbox";
  }
  if (scope === "library") {
    return "library";
  }
  return "discuss";
}

function effectiveDefaultResolution(
  preferences: UserModelPreferences,
  scope: ModelPreferenceScope,
  catalogEntries: readonly ModelCatalogEntry[],
  capability?: UserPickableCapability,
): { key: string; source: "custom" | "system" } | null {
  const scoped = getModelPreferencesForScope(preferences, scope);
  const hasEntry = (ref: { provider: LlmProvider; modelName: string }) =>
    catalogEntries.some((entry) => entry.provider === ref.provider && entry.modelName === ref.modelName);

  if (
    scoped.defaultModel &&
    isModelEnabledInPreferences(preferences, scoped.defaultModel, scope) &&
    hasEntry(scoped.defaultModel)
  ) {
    return { key: modelPreferenceKey(scoped.defaultModel), source: "custom" };
  }

  const fallback = DEFAULT_PICK_BY_CAPABILITY[capability ?? defaultCapabilityForScope(scope)];
  if (isModelEnabledInPreferences(preferences, fallback, scope) && hasEntry(fallback)) {
    return { key: modelPreferenceKey(fallback), source: "system" };
  }

  const firstEnabled = applyModelPreferences(catalogEntries, preferences, scope)[0];
  return firstEnabled ? { key: modelPreferenceKey(firstEnabled), source: "system" } : null;
}

function settingsCatalogFilterForScope(
  scope: ModelPreferenceScope,
): { capability?: UserPickableCapability } | undefined {
  return { capability: catalogCapabilityForPickableSurface(scope) };
}
