import { useCallback, useEffect, useRef, useState } from "react";
import { onLocalStorageChange, readJSON, writeJSON } from "@/lib/storage";
import { useLocalStorageBoolean } from "@/hooks/use-persisted-state";

export const USER_PREFERENCES_STORAGE_KEY = "systify.userPreferences.v1";
export const STATS_FOR_NERDS_STORAGE_KEY = "systify.statsForNerds.enabled";
export const CUSTOM_INSTRUCTIONS_MAX_LENGTH = 3000;

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
    const trait = rawTrait.trim();
    const key = trait.toLocaleLowerCase();
    if (!trait || seen.has(key)) continue;
    seen.add(key);
    out.push(trait);
  }
  return out;
}

export function useUserPreferences(): readonly [
  UserPreferences,
  (next: UserPreferences | ((prev: UserPreferences) => UserPreferences)) => void,
] {
  const [preferences, setPreferences] = useState<UserPreferences>(() =>
    normalizePreferences(readJSON(USER_PREFERENCES_STORAGE_KEY, isUserPreferences) ?? DEFAULT_USER_PREFERENCES),
  );
  const hasUserSetRef = useRef(readJSON(USER_PREFERENCES_STORAGE_KEY, isUserPreferences) !== null);

  useEffect(() => {
    if (!hasUserSetRef.current) return;
    writeJSON(USER_PREFERENCES_STORAGE_KEY, preferences);
  }, [preferences]);

  useEffect(() => {
    return onLocalStorageChange(USER_PREFERENCES_STORAGE_KEY, (newValue) => {
      const next =
        newValue === null ? DEFAULT_USER_PREFERENCES : readJSON(USER_PREFERENCES_STORAGE_KEY, isUserPreferences);
      hasUserSetRef.current = newValue !== null;
      setPreferences(normalizePreferences(next ?? DEFAULT_USER_PREFERENCES));
    });
  }, []);

  const setPersistedPreferences = useCallback(
    (next: UserPreferences | ((prev: UserPreferences) => UserPreferences)) => {
      hasUserSetRef.current = true;
      setPreferences((prev) => normalizePreferences(typeof next === "function" ? next(prev) : next));
    },
    [],
  );

  return [preferences, setPersistedPreferences] as const;
}

export function useStatsForNerdsPreference(): readonly [boolean, (next: boolean) => void] {
  return useLocalStorageBoolean(STATS_FOR_NERDS_STORAGE_KEY, false);
}
