import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  getCatalogEntry,
  listPickableModels as listCatalogPickableModels,
  type UserPickableCapability,
} from "./llmCatalog";
import type { LlmProvider } from "./llmProvider";

export const USER_TRAITS_MAX_COUNT = 16;
export const USER_TRAIT_MAX_LENGTH = 40;
export const CUSTOM_INSTRUCTIONS_MAX_LENGTH = 3000;

export type UserCustomizationPreferences = {
  traits: string[];
  customInstructions: string;
};

export type ModelPreferenceRef = {
  provider: LlmProvider;
  modelName: string;
};

export const MODEL_PREFERENCE_SCOPES = ["chat", "discuss", "library", "sandbox"] as const;
export type ModelPreferenceScope = (typeof MODEL_PREFERENCE_SCOPES)[number];

export type ScopedModelPreferences = {
  disabledModels: ModelPreferenceRef[];
  favoriteModels: ModelPreferenceRef[];
  defaultModel: ModelPreferenceRef | null;
};

export type UserModelPreferences = {
  scopes: Record<ModelPreferenceScope, ScopedModelPreferences>;
};

const EMPTY_CUSTOMIZATION: UserCustomizationPreferences = {
  traits: [],
  customInstructions: "",
};

const EMPTY_SCOPED_MODEL_PREFERENCES: ScopedModelPreferences = {
  disabledModels: [],
  favoriteModels: [],
  defaultModel: null,
};

const EMPTY_MODEL_PREFERENCES: UserModelPreferences = {
  scopes: {
    chat: EMPTY_SCOPED_MODEL_PREFERENCES,
    discuss: EMPTY_SCOPED_MODEL_PREFERENCES,
    library: EMPTY_SCOPED_MODEL_PREFERENCES,
    sandbox: EMPTY_SCOPED_MODEL_PREFERENCES,
  },
};

/**
 * Per-viewer preferences live in their own table so they can be loaded with a
 * single owner-keyed lookup and extended without reshaping the repository
 * model. All access funnels through these helpers so the upsert / cascade
 * semantics stay consistent across `repositoryPreferences.ts`,
 * `userPreferences.ts`, and the repository cascade in `repositories.ts`.
 */

async function findUserPreferences(ctx: QueryCtx | MutationCtx, ownerTokenIdentifier: string) {
  return await ctx.db
    .query("userPreferences")
    .withIndex("by_ownerTokenIdentifier", (q) => q.eq("ownerTokenIdentifier", ownerTokenIdentifier))
    .unique();
}

function normalizeTrait(rawTrait: string): string {
  return rawTrait.trim().replace(/\s+/g, " ").slice(0, USER_TRAIT_MAX_LENGTH);
}

export function normalizeCustomizationPreferences(
  preferences: UserCustomizationPreferences,
): UserCustomizationPreferences {
  const seen = new Set<string>();
  const traits: string[] = [];
  for (const rawTrait of preferences.traits) {
    const trait = normalizeTrait(rawTrait);
    const key = trait.toLocaleLowerCase();
    if (!trait || seen.has(key)) {
      continue;
    }
    seen.add(key);
    traits.push(trait);
    if (traits.length >= USER_TRAITS_MAX_COUNT) {
      break;
    }
  }

  return {
    traits,
    customInstructions: preferences.customInstructions.trim().slice(0, CUSTOM_INSTRUCTIONS_MAX_LENGTH),
  };
}

function customizationFromPref(
  pref: { traits?: string[]; customInstructions?: string } | null,
): UserCustomizationPreferences {
  if (!pref) {
    return EMPTY_CUSTOMIZATION;
  }
  return normalizeCustomizationPreferences({
    traits: pref.traits ?? [],
    customInstructions: pref.customInstructions ?? "",
  });
}

export function modelPreferenceKey(ref: ModelPreferenceRef): string {
  return `${ref.provider}:${ref.modelName}`;
}

function modelRefFromCatalogEntry(entry: ModelPreferenceRef): ModelPreferenceRef {
  return {
    provider: entry.provider,
    modelName: entry.modelName,
  };
}

function isKnownUserPickableRef(ref: ModelPreferenceRef): boolean {
  const entry = getCatalogEntry(ref.provider, ref.modelName);
  return entry?.userPickable === true;
}

function normalizeModelRefs(refs: readonly ModelPreferenceRef[] | undefined): ModelPreferenceRef[] {
  if (refs === undefined) {
    return [];
  }

  const seen = new Set<string>();
  const out: ModelPreferenceRef[] = [];
  for (const ref of refs) {
    const modelName = ref.modelName.trim();
    if (!modelName) {
      continue;
    }
    const normalized = { provider: ref.provider, modelName };
    if (!isKnownUserPickableRef(normalized)) {
      continue;
    }
    const key = modelPreferenceKey(normalized);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function capabilityForModelPreferenceScope(scope: ModelPreferenceScope): UserPickableCapability {
  if (scope === "sandbox") {
    return "sandbox";
  }
  if (scope === "library") {
    return "library";
  }
  return "discuss";
}

export function normalizeModelPreferences(
  pref: {
    disabledModels?: ModelPreferenceRef[];
    favoriteModels?: ModelPreferenceRef[];
    scopedModelPreferences?: Partial<
      Record<
        ModelPreferenceScope,
        {
          disabledModels?: ModelPreferenceRef[];
          favoriteModels?: ModelPreferenceRef[];
          defaultModel?: ModelPreferenceRef | null;
        }
      >
    >;
  } | null,
): UserModelPreferences {
  if (!pref) {
    return EMPTY_MODEL_PREFERENCES;
  }

  const legacy = normalizeScopedModelPreferences({
    disabledModels: pref.disabledModels,
    favoriteModels: pref.favoriteModels,
  });
  const scopes = {} as Record<ModelPreferenceScope, ScopedModelPreferences>;
  for (const scope of MODEL_PREFERENCE_SCOPES) {
    const scoped = pref.scopedModelPreferences?.[scope];
    scopes[scope] = scoped ? normalizeScopedModelPreferences(scoped) : legacy;
  }

  return { scopes };
}

function normalizeScopedModelPreferences(pref: {
  disabledModels?: ModelPreferenceRef[];
  favoriteModels?: ModelPreferenceRef[];
  defaultModel?: ModelPreferenceRef | null;
}): ScopedModelPreferences {
  const disabledModels = normalizeModelRefs(pref.disabledModels);
  const disabledKeys = new Set(disabledModels.map(modelPreferenceKey));
  const favoriteModels = normalizeModelRefs(pref.favoriteModels).filter(
    (ref) => !disabledKeys.has(modelPreferenceKey(ref)),
  );
  const normalizedDefault = normalizeModelRefs(pref.defaultModel ? [pref.defaultModel] : [])[0] ?? null;
  const defaultModel =
    normalizedDefault && !disabledKeys.has(modelPreferenceKey(normalizedDefault)) ? normalizedDefault : null;

  return {
    disabledModels,
    favoriteModels,
    defaultModel,
  };
}

function areModelRefsEqual(a: readonly ModelPreferenceRef[], b: readonly ModelPreferenceRef[]): boolean {
  return a.length === b.length && a.every((ref, index) => modelPreferenceKey(ref) === modelPreferenceKey(b[index]));
}

function areScopedModelPreferencesEqual(a: ScopedModelPreferences, b: ScopedModelPreferences): boolean {
  return (
    areModelRefsEqual(a.disabledModels, b.disabledModels) &&
    areModelRefsEqual(a.favoriteModels, b.favoriteModels) &&
    (a.defaultModel === null && b.defaultModel === null
      ? true
      : a.defaultModel !== null &&
        b.defaultModel !== null &&
        modelPreferenceKey(a.defaultModel) === modelPreferenceKey(b.defaultModel))
  );
}

function areModelPreferencesEqual(a: UserModelPreferences, b: UserModelPreferences): boolean {
  return MODEL_PREFERENCE_SCOPES.every((scope) => areScopedModelPreferencesEqual(a.scopes[scope], b.scopes[scope]));
}

export function getModelPreferencesForScope(
  preferences: UserModelPreferences,
  scope: ModelPreferenceScope,
): ScopedModelPreferences {
  return preferences.scopes[scope];
}

export function isModelEnabledInPreferences(
  preferences: UserModelPreferences,
  ref: ModelPreferenceRef,
  scope: ModelPreferenceScope,
): boolean {
  const disabledKeys = new Set(getModelPreferencesForScope(preferences, scope).disabledModels.map(modelPreferenceKey));
  return !disabledKeys.has(modelPreferenceKey(ref));
}

export function applyModelPreferences<T extends ModelPreferenceRef>(
  entries: readonly T[],
  preferences: UserModelPreferences,
  scope: ModelPreferenceScope,
): T[] {
  const favoriteKeys = new Set(getModelPreferencesForScope(preferences, scope).favoriteModels.map(modelPreferenceKey));
  const indexed = entries
    .filter((entry) => isModelEnabledInPreferences(preferences, entry, scope))
    .map((entry, index) => ({ entry, index, favorite: favoriteKeys.has(modelPreferenceKey(entry)) }));

  indexed.sort((a, b) => {
    if (a.favorite !== b.favorite) {
      return a.favorite ? -1 : 1;
    }
    return a.index - b.index;
  });

  return indexed.map((item) => item.entry);
}

/**
 * Read the viewer's preferences row, validating the stored
 * `lastActiveRepositoryId` still exists and still belongs to the viewer.
 *
 * A stale id would normally appear if a repository got deleted on another
 * device after the preference was written. Returning `null` for the field
 * in that case lets the frontend fall through to the "most recently
 * accessed repository" fallback, which is the behavior we want.
 */
export async function loadViewerPreferences(ctx: QueryCtx | MutationCtx, ownerTokenIdentifier: string) {
  const pref = await findUserPreferences(ctx, ownerTokenIdentifier);
  if (!pref) {
    return null;
  }

  let lastActiveRepositoryId: Id<"repositories"> | null = null;
  if (pref.lastActiveRepositoryId) {
    const repository = await ctx.db.get(pref.lastActiveRepositoryId);
    if (repository && repository.ownerTokenIdentifier === ownerTokenIdentifier) {
      lastActiveRepositoryId = repository._id;
    }
  }

  return {
    lastActiveRepositoryId,
    lastActiveRepositoryUpdatedAt: pref.lastActiveRepositoryUpdatedAt ?? null,
    ...customizationFromPref(pref),
    customizationUpdatedAt: pref.customizationUpdatedAt ?? null,
  };
}

export async function loadViewerCustomization(ctx: QueryCtx | MutationCtx, ownerTokenIdentifier: string) {
  return customizationFromPref(await findUserPreferences(ctx, ownerTokenIdentifier));
}

export async function loadViewerModelPreferences(
  ctx: QueryCtx | MutationCtx,
  ownerTokenIdentifier: string,
): Promise<UserModelPreferences> {
  return normalizeModelPreferences(await findUserPreferences(ctx, ownerTokenIdentifier));
}

/**
 * Idempotently persist stable per-viewer LLM customization. These fields are
 * low-churn profile data, so they share the existing per-viewer preference row
 * instead of being duplicated onto every chat message.
 */
export async function upsertViewerCustomization(
  ctx: MutationCtx,
  args: {
    ownerTokenIdentifier: string;
    preferences: UserCustomizationPreferences;
  },
) {
  const next = normalizeCustomizationPreferences(args.preferences);
  const existing = await findUserPreferences(ctx, args.ownerTokenIdentifier);
  const current = customizationFromPref(existing);

  if (
    existing &&
    current.customInstructions === next.customInstructions &&
    current.traits.length === next.traits.length &&
    current.traits.every((trait, index) => trait === next.traits[index])
  ) {
    if (existing.customizationUpdatedAt === undefined) {
      await ctx.db.patch(existing._id, {
        customizationUpdatedAt: Date.now(),
      });
    }
    return;
  }

  const now = Date.now();
  if (!existing) {
    await ctx.db.insert("userPreferences", {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      traits: next.traits,
      customInstructions: next.customInstructions,
      customizationUpdatedAt: now,
    });
    return;
  }

  await ctx.db.patch(existing._id, {
    traits: next.traits,
    customInstructions: next.customInstructions,
    customizationUpdatedAt: now,
  });
}

/**
 * Persist per-viewer model availability and favorites. We store the inverse
 * availability set (`disabledModels`) so newly-added catalog models remain
 * selectable by default unless the viewer explicitly turns them off later.
 */
export async function upsertViewerModelPreferences(
  ctx: MutationCtx,
  args: {
    scope: ModelPreferenceScope;
    ownerTokenIdentifier: string;
    enabledModels: ModelPreferenceRef[];
    favoriteModels: ModelPreferenceRef[];
    defaultModel?: ModelPreferenceRef | null;
  },
) {
  const scopeCatalog = listCatalogPickableModels().filter(
    (entry) => entry.capability === capabilityForModelPreferenceScope(args.scope),
  );
  const scopeCatalogKeys = new Set(scopeCatalog.map(modelPreferenceKey));
  const enabledModels = normalizeModelRefs(args.enabledModels).filter((ref) =>
    scopeCatalogKeys.has(modelPreferenceKey(ref)),
  );
  const enabledKeys = new Set(enabledModels.map(modelPreferenceKey));
  if (enabledKeys.size === 0) {
    throw new Error("At least one model must remain selectable.");
  }

  const disabledModels = scopeCatalog
    .filter((entry) => !enabledKeys.has(modelPreferenceKey(entry)))
    .map(modelRefFromCatalogEntry);

  const favoriteModels = normalizeModelRefs(args.favoriteModels).filter((ref) =>
    enabledKeys.has(modelPreferenceKey(ref)),
  );
  const existing = await findUserPreferences(ctx, args.ownerTokenIdentifier);
  const current = normalizeModelPreferences(existing);
  const hasDefaultModelArg = "defaultModel" in args;
  const normalizedDefault = normalizeModelRefs(
    hasDefaultModelArg && args.defaultModel ? [args.defaultModel] : [],
  ).filter((ref) => enabledKeys.has(modelPreferenceKey(ref)))[0];
  const defaultModel = hasDefaultModelArg ? (normalizedDefault ?? null) : current.scopes[args.scope].defaultModel;
  const next = normalizeModelPreferences({
    scopedModelPreferences: {
      ...current.scopes,
      [args.scope]: {
        disabledModels,
        favoriteModels,
        defaultModel,
      },
    },
  });

  if (existing && areModelPreferencesEqual(current, next)) {
    if (existing.modelPreferencesUpdatedAt === undefined) {
      await ctx.db.patch(existing._id, {
        modelPreferencesUpdatedAt: Date.now(),
      });
    }
    return;
  }

  const now = Date.now();
  if (!existing) {
    await ctx.db.insert("userPreferences", {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      scopedModelPreferences: next.scopes,
      modelPreferencesUpdatedAt: now,
    });
    return;
  }

  await ctx.db.patch(existing._id, {
    scopedModelPreferences: next.scopes,
    modelPreferencesUpdatedAt: now,
  });
}

/**
 * Idempotently set the viewer's last active repository. Skips the write when
 * the value already matches so subscriptions on `getViewerPreferences` stay
 * stable across redundant calls (e.g. the auto-select fallback re-running
 * on every repositories query revalidation).
 */
export async function upsertLastActiveRepository(
  ctx: MutationCtx,
  args: {
    ownerTokenIdentifier: string;
    repositoryId: Id<"repositories">;
  },
) {
  const existing = await findUserPreferences(ctx, args.ownerTokenIdentifier);
  const now = Date.now();

  if (!existing) {
    await ctx.db.insert("userPreferences", {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      lastActiveRepositoryId: args.repositoryId,
      lastActiveRepositoryUpdatedAt: now,
    });
    return;
  }

  if (existing.lastActiveRepositoryId === args.repositoryId) {
    return;
  }

  await ctx.db.patch(existing._id, {
    lastActiveRepositoryId: args.repositoryId,
    lastActiveRepositoryUpdatedAt: now,
  });
}

/**
 * Cascade hook for repository deletion: clear the pointer if the deleted
 * repository was the viewer's stored "last active". Without this, the next
 * `getViewerPreferences` call would have to silently drop a dangling id.
 */
export async function clearLastActiveRepositoryIfMatches(
  ctx: MutationCtx,
  args: {
    ownerTokenIdentifier: string;
    repositoryId: Id<"repositories">;
  },
) {
  const existing = await findUserPreferences(ctx, args.ownerTokenIdentifier);
  if (!existing || existing.lastActiveRepositoryId !== args.repositoryId) {
    return;
  }
  await ctx.db.patch(existing._id, {
    lastActiveRepositoryId: undefined,
    lastActiveRepositoryUpdatedAt: Date.now(),
  });
}
