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
const USER_PREFERENCES_SAVE_RETRY_MS = 3000;

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
    customInstructions: normalizeCustomInstructions(value.customInstructions),
  };
}

function normalizeCustomInstructions(value: string): string {
  return value.trim().slice(0, CUSTOM_INSTRUCTIONS_MAX_LENGTH);
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

function preferencesFromViewerPreferences(
  viewerPreferences: { traits: string[]; customInstructions: string } | null,
): UserPreferences {
  return viewerPreferences === null
    ? DEFAULT_USER_PREFERENCES
    : normalizePreferences({
        traits: viewerPreferences.traits,
        customInstructions: viewerPreferences.customInstructions,
      });
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
  const migrationInFlightRef = useRef(false);
  const serverEchoPendingRef = useRef<UserPreferences | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const isMountedRef = useRef(false);
  const [retryNonce, setRetryNonce] = useState(0);

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current === null) {
      return;
    }
    window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
  }, []);

  const scheduleRetry = useCallback(() => {
    if (!isMountedRef.current || retryTimerRef.current !== null) {
      return;
    }
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null;
      setRetryNonce((nonce) => nonce + 1);
    }, USER_PREFERENCES_SAVE_RETRY_MS);
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      clearRetryTimer();
    };
  }, [clearRetryTimer]);

  useEffect(() => {
    writeJSON(USER_PREFERENCES_STORAGE_KEY, preferences);
  }, [preferences]);

  useEffect(() => {
    if (viewerPreferences === undefined || localEditVersionRef.current > savedEditVersionRef.current) {
      return;
    }

    const next = preferencesFromViewerPreferences(viewerPreferences);
    const pendingServerEcho = serverEchoPendingRef.current;
    if (pendingServerEcho !== null) {
      if (arePreferencesEqual(next, pendingServerEcho)) {
        serverEchoPendingRef.current = null;
      } else {
        return;
      }
    }

    const cached = cachedPreferencesRef.current;
    const serverHasCustomization =
      viewerPreferences !== null && !isDefaultPreferences(preferencesFromViewerPreferences(viewerPreferences));
    const shouldMigrateCache =
      !migrationInFlightRef.current &&
      cached !== null &&
      !isDefaultPreferences(cached) &&
      !serverHasCustomization &&
      (viewerPreferences === null || viewerPreferences.customizationUpdatedAt === null);

    if (shouldMigrateCache) {
      const preferencesToMigrate = normalizePreferences(cached);
      migrationInFlightRef.current = true;
      clearRetryTimer();
      void updateCustomization(preferencesToMigrate)
        .then(() => {
          if (localEditVersionRef.current === savedEditVersionRef.current) {
            serverEchoPendingRef.current = preferencesToMigrate;
          }
        })
        .catch((error) => {
          console.error("Failed to migrate cached customization preferences", error);
          scheduleRetry();
        })
        .finally(() => {
          migrationInFlightRef.current = false;
        });
      return;
    }

    if (!arePreferencesEqual(preferences, next)) {
      const handle = window.setTimeout(() => setPreferences(next), 0);
      return () => window.clearTimeout(handle);
    }
  }, [clearRetryTimer, preferences, retryNonce, scheduleRetry, updateCustomization, viewerPreferences]);

  useEffect(() => {
    if (localEditVersionRef.current === savedEditVersionRef.current) {
      return;
    }

    const version = localEditVersionRef.current;
    const preferencesToSave = normalizePreferences(preferences);
    clearRetryTimer();
    const handle = window.setTimeout(() => {
      void updateCustomization(preferencesToSave)
        .then(() => {
          if (localEditVersionRef.current === version) {
            savedEditVersionRef.current = version;
            serverEchoPendingRef.current = preferencesToSave;
          }
        })
        .catch((error) => {
          console.error("Failed to save customization preferences", error);
          if (localEditVersionRef.current === version) {
            scheduleRetry();
          }
        });
    }, USER_PREFERENCES_SAVE_DEBOUNCE_MS);

    return () => window.clearTimeout(handle);
  }, [clearRetryTimer, preferences, retryNonce, scheduleRetry, updateCustomization]);

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
