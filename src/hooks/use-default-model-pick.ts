import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { LlmProvider, UserPickableCapability } from "@/lib/types";

export interface DefaultModelPick {
  provider: LlmProvider;
  modelName: string;
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
  /**
   * `threads.defaultModelName`. Restores the user's last pick when
   * they reopen a thread.
   */
  threadDefaultModelName?: string | null;
}): DefaultModelPick | undefined {
  const capabilityDefault = useQuery(api.llmCatalog.getDefaultModelPick, { capability: args.capability });
  // Looked up purely so the hook can verify a persisted thread
  // default model still exists in the catalog before returning it.
  // When the persisted name is absent or stale we fall through to
  // the capability default rather than handing back a model the
  // gateway would reject.
  const catalogForThreadDefault = useQuery(
    api.llmCatalog.listPickableModels,
    args.threadDefaultModelName !== null && args.threadDefaultModelName !== undefined ? {} : "skip",
  );

  return useMemo<DefaultModelPick | undefined>(() => {
    // Thread default takes priority — restores the user's most
    // recent pick on this thread.
    if (args.threadDefaultModelName !== null && args.threadDefaultModelName !== undefined) {
      if (catalogForThreadDefault === undefined) {
        return undefined;
      }
      const entry = catalogForThreadDefault.find((row) => row.modelName === args.threadDefaultModelName);
      if (entry) {
        return { provider: entry.provider, modelName: entry.modelName };
      }
    }

    if (capabilityDefault === undefined) {
      return undefined;
    }

    return capabilityDefault;
  }, [args.threadDefaultModelName, catalogForThreadDefault, capabilityDefault]);
}
