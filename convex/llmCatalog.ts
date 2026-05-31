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
import { listPickableModels as listPickableModelsFromCatalog, type ModelCatalogEntry } from "./lib/llmCatalog";
import { llmProviderValidator } from "./lib/llmProvider";

const capabilityValidator = v.union(v.literal("sandbox"), v.literal("library"), v.literal("discuss"));

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
