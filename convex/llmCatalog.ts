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
import { query } from "./_generated/server";
import {
  listPickableModels as listPickableModelsFromCatalog,
  ROLE_MODELS,
  type ModelCatalogEntry,
  type UserPickableCapability,
} from "./lib/llmCatalog";
import { llmProviderValidator, type LlmProvider } from "./lib/llmProvider";

const capabilityValidator = v.union(v.literal("sandbox"), v.literal("library"), v.literal("discuss"));

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

/**
 * Return the subset of {@link MODEL_CATALOG} that the model picker
 * should surface, optionally filtered by `(provider, capability)`.
 *
 * Both filters compose: passing both restricts to entries matching
 * each. Omit both to get the full pickable set.
 *
 * Returned shape matches {@link ModelCatalogEntry} verbatim so the
 * frontend picker can render `displayName` directly and key click
 * handlers off `(provider, modelName)`.
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
  },
  handler: async (_ctx, args): Promise<ModelCatalogEntry[]> => {
    return listPickableModelsFromCatalog({
      provider: args.provider,
      capability: args.capability,
    });
  },
});

/**
 * Return the `(provider, modelName)` default for a capability tier,
 * so the composer's model picker can render its trigger label with
 * the actual default model on first mount instead of a placeholder
 * (and the user can see what the backend would resolve to before
 * they make a pick).
 *
 * Mirrors the third layer of {@link resolveModelForReply}'s cascade.
 * The hook `useDefaultModelPick` composes this with the thread-level
 * default and a locked-provider override on the client.
 */
export const getDefaultModelPick = query({
  args: { capability: capabilityValidator },
  handler: async (_ctx, { capability }): Promise<{ provider: LlmProvider; modelName: string }> => {
    return DEFAULT_PICK_BY_CAPABILITY[capability];
  },
});
