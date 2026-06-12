import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { LlmProvider, ModelPreferenceScope, UserPickableCapability } from "@/lib/types";

export interface DefaultModelPick {
  provider: LlmProvider;
  modelName: string;
}

const LLM_PROVIDERS = new Set<LlmProvider>(["openai", "anthropic"]);

function isDefaultModelPick(value: unknown): value is DefaultModelPick {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { provider?: unknown; modelName?: unknown };
  return (
    typeof candidate.modelName === "string" &&
    typeof candidate.provider === "string" &&
    LLM_PROVIDERS.has(candidate.provider as LlmProvider)
  );
}

/**
 * Resolve the model the composer's picker should display by default
 * for a given capability tier, mirroring the backend cascade in
 * `resolveModelForReply`:
 *
 *   1. Thread default — `threads.defaultModelName` (provider inferred
 *      via catalog lookup). Restores the user's last pick when they
 *      reopen a thread.
 *   2. Capability default — the `(provider, modelName)` pair the
 *      `getDefaultModelPick` query returns for this capability
 *      (sourced from `ROLE_MODELS` server-side).
 *
 * Returns `undefined` while either dependent query is still loading
 * so callers can render their placeholder state on first paint
 * instead of flashing the wrong label.
 *
 * Auto-hydration usage: call sites pass `useDefaultModelPick({ ... })`
 * to the picker's `value` prop via `selectedPick ?? defaultPick`,
 * so the trigger shows the actual default model on mount rather than
 * a "Pick model" placeholder. The user's first interaction promotes
 * the value out of the default — explicit pick wins.
 */
export function useDefaultModelPick(args: {
  capability: UserPickableCapability;
  preferenceScope: ModelPreferenceScope;
  /**
   * `threads.lockedProvider`. When the thread is locked, the capability
   * default's provider may not match — in that case the hook prefers the
   * locked-provider capability default by reading
   * `listPickableModels({ provider, preferenceScope })` and returning the
   * first selectable entry for that provider.
   */
  threadLockedProvider?: LlmProvider | null;
  /**
   * `threads.defaultModelName`. Restores the user's last pick when
   * they reopen a thread.
   */
  threadDefaultModelName?: string | null;
}): DefaultModelPick | undefined {
  const capabilityDefault = useQuery(api.llmCatalog.getDefaultModelPick, {
    capability: args.capability,
    preferenceScope: args.preferenceScope,
  });
  const validCapabilityDefault = isDefaultModelPick(capabilityDefault) ? capabilityDefault : undefined;
  // Provider filter applied only when the thread is locked to a provider
  // whose capability default differs from the global pick. Saves a query
  // roundtrip for the common unlocked / matching case.
  const lockedProviderNeedsLookup =
    args.threadLockedProvider !== null &&
    args.threadLockedProvider !== undefined &&
    validCapabilityDefault !== undefined &&
    validCapabilityDefault.provider !== args.threadLockedProvider;
  const lockedProviderEntries = useQuery(
    api.llmCatalog.listPickableModels,
    lockedProviderNeedsLookup
      ? { provider: args.threadLockedProvider!, preferenceScope: args.preferenceScope }
      : "skip",
  );
  // Looked up purely so the hook can verify a persisted thread
  // default model still exists in the catalog before returning it.
  // When the persisted name is absent or stale we fall through to
  // the capability default rather than handing back a model the
  // gateway would reject.
  const catalogForThreadDefault = useQuery(
    api.llmCatalog.listPickableModels,
    args.threadDefaultModelName !== null && args.threadDefaultModelName !== undefined
      ? { preferenceScope: args.preferenceScope }
      : "skip",
  );

  return useMemo<DefaultModelPick | undefined>(() => {
    // Thread default takes priority — restores the user's most
    // recent pick on this thread.
    if (args.threadDefaultModelName !== null && args.threadDefaultModelName !== undefined) {
      if (catalogForThreadDefault === undefined) {
        return undefined;
      }
      const entry = Array.isArray(catalogForThreadDefault)
        ? catalogForThreadDefault.find((row) => row.modelName === args.threadDefaultModelName)
        : undefined;
      if (entry) {
        return { provider: entry.provider, modelName: entry.modelName };
      }
    }

    if (validCapabilityDefault === undefined) {
      return undefined;
    }

    if (lockedProviderNeedsLookup) {
      if (!Array.isArray(lockedProviderEntries)) {
        return undefined;
      }
      const first = lockedProviderEntries[0];
      if (first) {
        return { provider: first.provider, modelName: first.modelName };
      }
    }

    return validCapabilityDefault;
  }, [
    args.threadDefaultModelName,
    catalogForThreadDefault,
    lockedProviderEntries,
    lockedProviderNeedsLookup,
    validCapabilityDefault,
  ]);
}
