import type { Doc, Id, TableNames } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { requireViewerIdentity } from "./auth";

type ReadCtx = QueryCtx | MutationCtx;

/**
 * The set of tables that scope rows to a viewer via `ownerTokenIdentifier`.
 * Computed from the schema: adding a new owner-scoped table extends this
 * union automatically.
 */
export type OwnedTable = {
  [K in TableNames]: Doc<K> extends { ownerTokenIdentifier: string } ? K : never;
}[TableNames];

/**
 * `Doc<T>` with the `ownerTokenIdentifier` field surfaced as a non-optional
 * string. The intersection nudges TS to expose the field on the union of
 * owned tables; runtime safety is guaranteed by the `OwnedTable` constraint.
 */
export type OwnedDoc<T extends OwnedTable> = Doc<T> & { ownerTokenIdentifier: string };

type ViewerIdentity = Awaited<ReturnType<typeof requireViewerIdentity>>;

const DEFAULT_NOT_FOUND_MESSAGE = "Not found.";

/**
 * Strict, viewer-driven owner gate. Fetches the document, asserts the
 * signed-in viewer owns it, and returns both the identity and the doc.
 * Throws `notFoundMessage` (default `"Not found."`) on missing or
 * non-owned rows — the same error shape for both cases so the existence
 * of a stranger's row is never leaked.
 *
 * Use this in public queries / mutations whose contract is "I will fail
 * loudly if you ask about a row that isn't yours."
 */
export async function requireOwnedDoc<T extends OwnedTable>(
  ctx: ReadCtx,
  id: Id<T>,
  options?: { notFoundMessage?: string },
): Promise<{ identity: ViewerIdentity; doc: OwnedDoc<T> }> {
  const identity = await requireViewerIdentity(ctx);
  const doc = (await ctx.db.get(id)) as OwnedDoc<T> | null;
  if (!doc || doc.ownerTokenIdentifier !== identity.tokenIdentifier) {
    throw new Error(options?.notFoundMessage ?? DEFAULT_NOT_FOUND_MESSAGE);
  }
  return { identity, doc };
}

/**
 * Soft, viewer-driven owner gate. Returns `{ identity, doc: null }` on
 * missing or non-owned rows instead of throwing — used by queries that
 * render an empty state rather than surface an error (e.g. a stale URL).
 *
 * The identity is still returned so callers can short-circuit subsequent
 * reads without re-fetching it.
 */
export async function loadOwnedDoc<T extends OwnedTable>(
  ctx: ReadCtx,
  id: Id<T>,
): Promise<{ identity: ViewerIdentity; doc: OwnedDoc<T> | null }> {
  const identity = await requireViewerIdentity(ctx);
  const doc = (await ctx.db.get(id)) as OwnedDoc<T> | null;
  if (!doc || doc.ownerTokenIdentifier !== identity.tokenIdentifier) {
    return { identity, doc: null };
  }
  return { identity, doc };
}

/**
 * Strict gate for callers that already have an owner token in scope (e.g.
 * internal mutations invoked from actions, store helpers that take
 * `ownerTokenIdentifier` as an argument). Asserts the doc is non-null
 * and owned by the given token; throws the same shape as
 * {@link requireOwnedDoc}.
 */
export function assertOwnedBy<D extends { ownerTokenIdentifier: string }>(
  doc: D | null | undefined,
  ownerTokenIdentifier: string,
  notFoundMessage: string = DEFAULT_NOT_FOUND_MESSAGE,
): asserts doc is D {
  if (!doc || doc.ownerTokenIdentifier !== ownerTokenIdentifier) {
    throw new Error(notFoundMessage);
  }
}

/**
 * Predicate for callers that need to fail with a custom error shape
 * (e.g. a `ConvexError` with a structured code) or that compose the
 * ownership check into a larger validation. Narrows the doc type on
 * `true`.
 */
export function isOwnedBy<D extends { ownerTokenIdentifier: string }>(
  doc: D | null | undefined,
  ownerTokenIdentifier: string,
): doc is D {
  return !!doc && doc.ownerTokenIdentifier === ownerTokenIdentifier;
}
