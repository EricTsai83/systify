import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useLocalStorageBoolean } from "@/hooks/use-persisted-state";
import { readJSON, writeJSON } from "@/lib/storage";

export const USER_PREFERENCES_STORAGE_KEY = "systify.userPreferences.v1";
export const STATS_FOR_NERDS_STORAGE_KEY = "systify.statsForNerds.enabled";
export const CUSTOM_INSTRUCTIONS_MAX_LENGTH = 3000;
export const USER_TRAITS_MAX_COUNT = 16;
export const USER_TRAIT_MAX_LENGTH = 40;
const USER_PREFERENCES_SAVE_DEBOUNCE_MS = 600;

export type UserPreferences = {
  traits: string[];
  customInstructions: string;
};

const DEFAULT_USER_PREFERENCES: UserPreferences = {
  traits: [],
  customInstructions: "",
};

function isUserPreferences(value: unknown): value is UserPreferences {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record.traits) &&
    record.traits.every((trait) => typeof trait === "string") &&
    typeof record.customInstructions === "string"
  );
}

function normalizePreferences(value: UserPreferences): UserPreferences {
  return {
    traits: dedupeTraits(value.traits),
    customInstructions: value.customInstructions.slice(0, CUSTOM_INSTRUCTIONS_MAX_LENGTH),
  };
}

function dedupeTraits(traits: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawTrait of traits) {
    const trait = rawTrait.trim().replace(/\s+/g, " ").slice(0, USER_TRAIT_MAX_LENGTH);
    const key = trait.toLocaleLowerCase();
    if (!trait || seen.has(key)) continue;
    seen.add(key);
    out.push(trait);
    if (out.length >= USER_TRAITS_MAX_COUNT) break;
  }
  return out;
}

function arePreferencesEqual(a: UserPreferences, b: UserPreferences): boolean {
  return (
    a.customInstructions === b.customInstructions &&
    a.traits.length === b.traits.length &&
    a.traits.every((trait, index) => trait === b.traits[index])
  );
}

function isDefaultPreferences(value: UserPreferences): boolean {
  return arePreferencesEqual(value, DEFAULT_USER_PREFERENCES);
}

export function useUserPreferences(): readonly [
  UserPreferences,
  (next: UserPreferences | ((prev: UserPreferences) => UserPreferences)) => void,
] {
  const [cachedPreferences] = useState<UserPreferences | null>(() => {
    const cached = readJSON(USER_PREFERENCES_STORAGE_KEY, isUserPreferences);
    return cached ? normalizePreferences(cached) : null;
  });
  const cachedPreferencesRef = useRef<UserPreferences | null>(cachedPreferences);
  const [preferences, setPreferences] = useState<UserPreferences>(() => cachedPreferences ?? DEFAULT_USER_PREFERENCES);
  const viewerPreferences = useQuery(api.userPreferences.getViewerPreferences);
  const updateCustomization = useMutation(api.userPreferences.updateViewerCustomization);
  const localEditVersionRef = useRef(0);
  const savedEditVersionRef = useRef(0);
  const migrationAttemptedRef = useRef(false);

  useEffect(() => {
    writeJSON(USER_PREFERENCES_STORAGE_KEY, preferences);
  }, [preferences]);

  useEffect(() => {
    if (viewerPreferences === undefined || localEditVersionRef.current > savedEditVersionRef.current) {
      return;
    }

    const cached = cachedPreferencesRef.current;
    const shouldMigrateCache =
      !migrationAttemptedRef.current &&
      cached !== null &&
      !isDefaultPreferences(cached) &&
      (viewerPreferences === null || viewerPreferences.customizationUpdatedAt === null);

    if (shouldMigrateCache) {
      migrationAttemptedRef.current = true;
      void updateCustomization(cached).catch((error) => {
        console.error("Failed to migrate cached customization preferences", error);
      });
      return;
    }

    const next =
      viewerPreferences === null
        ? DEFAULT_USER_PREFERENCES
        : normalizePreferences({
            traits: viewerPreferences.traits,
            customInstructions: viewerPreferences.customInstructions,
          });
    if (!arePreferencesEqual(preferences, next)) {
      const handle = window.setTimeout(() => setPreferences(next), 0);
      return () => window.clearTimeout(handle);
    }
  }, [preferences, updateCustomization, viewerPreferences]);

  useEffect(() => {
    if (localEditVersionRef.current === savedEditVersionRef.current) {
      return;
    }

    const version = localEditVersionRef.current;
    const handle = window.setTimeout(() => {
      void updateCustomization(preferences)
        .then(() => {
          if (localEditVersionRef.current === version) {
            savedEditVersionRef.current = version;
          }
        })
        .catch((error) => {
          console.error("Failed to save customization preferences", error);
        });
    }, USER_PREFERENCES_SAVE_DEBOUNCE_MS);

    return () => window.clearTimeout(handle);
  }, [preferences, updateCustomization]);

  const setPersistedPreferences = useCallback(
    (next: UserPreferences | ((prev: UserPreferences) => UserPreferences)) => {
      localEditVersionRef.current += 1;
      setPreferences((prev) => normalizePreferences(typeof next === "function" ? next(prev) : next));
    },
    [],
  );

  return [preferences, setPersistedPreferences] as const;
}

export function useStatsForNerdsPreference(): readonly [boolean, (next: boolean) => void] {
  return useLocalStorageBoolean(STATS_FOR_NERDS_STORAGE_KEY, false);
}
